/**
 * Two-phase settlement: dry run, then broadcast, then recover proof.
 *
 * The shape of this flow is dictated by three documented KeeperHub behaviours
 * that a naive `await client.transfer(...)` gets wrong:
 *
 * 1. A dry run catches reverts, allowance mismatches and balance shortfalls
 *    without spending gas. For an agent that has *already taken payment* for
 *    the work, finding out before broadcasting is worth one extra round trip.
 * 2. The execute endpoints return a hash only when the step reported success.
 *    A `failed` or `unconfirmed` response carries none -- including when a
 *    transaction really was broadcast and its receipt simply could not be
 *    confirmed. Treating "no hash" as "nothing happened" is how an agent
 *    double-pays. We always read the stored execution back.
 * 3. A sponsored execution never touches the org EOA's nonce or balance, so
 *    verifying against EOA state concludes nothing happened even on success.
 *    The hash is the only authoritative proof.
 */

import { KeeperHubError } from "./errors.js";
import type { KeeperHubClient, ExecuteOptions } from "./client.js";
import type {
  ExecutionResult,
  ExecutionStatusResult,
  SimulationResult,
  TransferRequest,
} from "./types.js";

export type SettlementOutcome = {
  /** `settled` only when we hold a hash and no failure. */
  status: "settled" | "failed" | "unconfirmed";
  executionId: string;
  transactionHash?: string;
  transactionLink?: string;
  /** True when KeeperHub replayed a stored response instead of executing. */
  replayed: boolean;
  /** True when broadcast via relayer/smart account rather than the org EOA. */
  sponsored?: boolean;
  /** Gas estimate from the preflight, when one ran. */
  gasEstimate?: string;
  error?: string;
  /** The stored execution record, when we read it back. */
  execution?: ExecutionStatusResult;
};

export type SettleOptions = ExecuteOptions & {
  /**
   * Run a dry run before broadcasting. Default true. Disable only for work
   * where the extra round trip is worse than a failed broadcast.
   */
  preflight?: boolean;
  /** Poll the status endpoint until terminal. Default true. */
  confirm?: boolean;
  /** Max polls when confirming. Default 10. */
  maxPolls?: number;
  /** Delay between polls in ms. Default 1500. */
  pollIntervalMs?: number;
};

/** Statuses that mean KeeperHub is still working. */
const NON_TERMINAL = new Set(["pending"]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Settles a transfer through KeeperHub and returns proof of what happened.
 *
 * Never throws for an onchain failure -- a reverted transfer is an outcome the
 * caller has to report to its buyer, not an exception. Throws only for
 * conditions the caller cannot act on per-request (bad credentials, missing
 * wallet, exhausted scope).
 */
export async function settleTransfer(
  client: KeeperHubClient,
  request: TransferRequest,
  options: SettleOptions = {}
): Promise<SettlementOutcome> {
  const {
    preflight = true,
    confirm = true,
    maxPolls = 10,
    pollIntervalMs = 1500,
    ...executeOptions
  } = options;

  let gasEstimate: string | undefined;

  if (preflight) {
    try {
      const simulation: SimulationResult = await client.simulateTransfer(request, {
        signal: executeOptions.signal,
      });
      gasEstimate = simulation.gasEstimate;
    } catch (error) {
      if (!(error instanceof KeeperHubError)) throw error;

      // A revert or a funding shortfall found before broadcast is the dry run
      // doing its job: report it, having spent nothing.
      if (error.kind === "revert" || error.kind === "insufficient_funds") {
        return {
          status: "failed",
          executionId: "",
          replayed: false,
          error: error.revertReason ?? error.message,
        };
      }

      // The simulator being down is not a reason to refuse to pay someone we
      // already owe. Fall through and broadcast; the chain is the real judge.
      if (error.kind !== "unavailable") throw error;
    }
  }

  let result: ExecutionResult;
  try {
    result = await client.transfer(request, executeOptions);
  } catch (error) {
    if (!(error instanceof KeeperHubError)) throw error;

    // Conditions a caller cannot fix by handling the response.
    if (
      error.kind === "unauthorized" ||
      error.kind === "insufficient_scope" ||
      error.kind === "wallet_not_configured"
    ) {
      throw error;
    }

    // An in-flight duplicate means the work IS happening under this key. That
    // is a success path for the caller, not an error -- surfacing it as failed
    // invites exactly the retry that would double-send.
    if (error.kind === "idempotency_in_progress") {
      return {
        status: "unconfirmed",
        executionId: error.originalExecutionId ?? "",
        replayed: true,
        gasEstimate,
        error: "Settlement already in progress under this idempotency key",
      };
    }

    return {
      status: "failed",
      executionId: error.originalExecutionId ?? "",
      replayed: false,
      gasEstimate,
      error: error.revertReason ?? error.message,
    };
  }

  const replayed = result.idempotentReplay === true;

  // Fast path: the step reported success and handed us a hash.
  if (result.transactionHash && result.status === "completed" && !confirm) {
    return {
      status: "settled",
      executionId: result.executionId,
      transactionHash: result.transactionHash,
      transactionLink: result.transactionLink,
      replayed,
      gasEstimate,
    };
  }

  if (!confirm || !result.executionId) {
    return {
      status: result.transactionHash ? "settled" : "unconfirmed",
      executionId: result.executionId,
      transactionHash: result.transactionHash,
      transactionLink: result.transactionLink,
      replayed,
      gasEstimate,
    };
  }

  // Read the stored execution back. This is the step that recovers a hash the
  // step result withheld, and the only way to learn `sponsored`.
  let execution: ExecutionStatusResult | undefined;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    execution = await client.getStatus(result.executionId, executeOptions.signal);
    if (!NON_TERMINAL.has(execution.status)) break;
    if (poll < maxPolls - 1) await sleep(pollIntervalMs);
  }

  const hash = execution?.transactionHash ?? result.transactionHash ?? undefined;
  const link = execution?.transactionLink ?? result.transactionLink ?? undefined;

  // A verified receipt that reverted is a failure even though a hash exists.
  const reverted = execution?.receipts?.some((r) => r.receiptStatus === "reverted") ?? false;

  let status: SettlementOutcome["status"];
  if (reverted || execution?.status === "failed") {
    status = "failed";
  } else if (hash && execution?.status === "completed") {
    status = "settled";
  } else {
    status = "unconfirmed";
  }

  return {
    status,
    executionId: result.executionId,
    transactionHash: hash ?? undefined,
    transactionLink: link ?? undefined,
    replayed,
    sponsored: execution?.sponsored,
    gasEstimate,
    error: execution?.error ?? undefined,
    execution,
  };
}
