/**
 * The `keeperhub()` Lucid extension.
 *
 * Lucid is explicit that "wallets, payment protocols, networks, and
 * facilitators remain external": it owns schemas, payment admission, policy,
 * idempotency, fulfillment and accounting, and deliberately owns no signer.
 * That leaves a gap on the fulfillment side. An agent that sells a service
 * whose delivery is an onchain payment has nowhere to put that payment, so in
 * practice it ends up constructing an ethers wallet inside the handler --
 * private key in process memory, no dry run, no nonce management, no audit
 * trail, and a retry that double-sends.
 *
 * This extension fills that gap with KeeperHub rather than a signer. The
 * runtime gains a `keeperhub` slice whose settlement calls are idempotent by
 * construction (keyed on the Lucid `runId`), preflighted by default, and
 * observable afterwards through KeeperHub's stored execution record.
 */

import type {
  AgentManifest,
  BuildContext,
  EntrypointDef,
  Extension,
} from "@lucid-agents/types/core";

import { KeeperHubClient, type KeeperHubClientOptions } from "./client.js";
import { KeeperHubError } from "./errors.js";
import { settleTransfer, type SettleOptions, type SettlementOutcome } from "./settle.js";
import type { ExecutionStatusResult, SpendCapResult, TransferRequest } from "./types.js";

/** URI identifying this capability in an A2A agent card. */
export const KEEPERHUB_EXTENSION_URI =
  "https://docs.keeperhub.com/api/direct-execution";

export type KeeperHubExtensionOptions = Omit<KeeperHubClientOptions, "apiKey"> & {
  /** Organization API key. Defaults to `process.env.KEEPERHUB_API_KEY`. */
  apiKey?: string;
  /**
   * Chain id used when a settlement call omits one. Supplying it here keeps
   * the chain out of every handler and out of the idempotency key's variance.
   */
  defaultChainId?: number | string;
  /**
   * Advertise KeeperHub settlement in the agent card. Default true.
   *
   * This is what makes the capability *discoverable*: a buying agent reading
   * the card learns that this seller settles deterministically and publishes
   * an audit trail, without having to invoke anything to find out.
   */
  advertise?: boolean;
  /** Defaults applied to every settlement call. */
  settlementDefaults?: Pick<SettleOptions, "preflight" | "confirm" | "maxPolls" | "pollIntervalMs">;
};

/** The runtime slice this extension contributes. */
export type KeeperHubSlice = {
  keeperhub: {
    /** The underlying client, for calls this slice does not wrap. */
    client: KeeperHubClient;
    /**
     * Settles a transfer, deriving the idempotency key from the invocation.
     *
     * Pass the handler's `runId` as `workId`. That single argument is what
     * makes a retried invocation reuse KeeperHub's stored outcome instead of
     * broadcasting a second transaction.
     */
    settle(request: TransferRequest, options?: SettleOptions): Promise<SettlementOutcome>;
    /** Dry-runs a transfer without signing. Safe under an `mcp:read` key. */
    simulate(request: TransferRequest, signal?: AbortSignal): Promise<{
      ok: boolean;
      gasEstimate?: string;
      reason?: string;
    }>;
    /** Reads a stored execution -- the authoritative record for a hash. */
    status(executionId: string, signal?: AbortSignal): Promise<ExecutionStatusResult>;
    /** Reads the org's daily native-value spend caps. */
    spendCap(signal?: AbortSignal): Promise<SpendCapResult>;
    /** Entrypoint keys that declared KeeperHub settlement, for diagnostics. */
    settlingEntrypoints(): readonly string[];
  };
};

/**
 * Per-entrypoint settlement declaration, read from `metadata.keeperhub`.
 *
 * Declaring settlement on the entrypoint rather than only calling it inside
 * the handler is what lets the extension surface the capability in discovery
 * and validate it at build time instead of at first invocation.
 */
export type EntrypointSettlementConfig = {
  /** Marks this entrypoint as settling onchain through KeeperHub. */
  settles: true;
  /** Chain the settlement lands on. Falls back to `defaultChainId`. */
  chainId?: number | string;
  /** ERC-20 settled in. Omit for the chain's native token. */
  tokenAddress?: string;
  /** Human-readable note surfaced in the agent card. */
  description?: string;
};

function readSettlementConfig(
  entrypoint: EntrypointDef
): EntrypointSettlementConfig | undefined {
  const raw = (entrypoint.metadata as Record<string, unknown> | undefined)?.keeperhub;
  if (!raw || typeof raw !== "object") return undefined;
  const config = raw as Partial<EntrypointSettlementConfig>;
  if (config.settles !== true) return undefined;
  return config as EntrypointSettlementConfig;
}

/**
 * Creates the KeeperHub settlement extension.
 *
 * @example
 * ```ts
 * const runtime = await createAgent({ name: 'payout', version: '1.0.0' })
 *   .use(http())
 *   .use(keeperhub({ defaultChainId: 84532 }))
 *   .addEntrypoint({
 *     key: 'payout',
 *     input: z.object({ to: z.string(), amount: z.string() }),
 *     output: z.object({ transactionHash: z.string().optional() }),
 *     metadata: { keeperhub: { settles: true } },
 *     handler: async ({ input, runId, runtime }) => {
 *       const outcome = await runtime.keeperhub.settle(
 *         { chainId: 84532, recipientAddress: input.to, amount: input.amount },
 *         { workId: runId },
 *       );
 *       return { output: { transactionHash: outcome.transactionHash } };
 *     },
 *   })
 *   .build();
 * ```
 */
export function keeperhub(
  options: KeeperHubExtensionOptions = {}
): Extension<KeeperHubSlice> {
  const settling = new Set<string>();

  return {
    name: "keeperhub",
    // Settlement is fulfillment, so it must not run before payment admission
    // has decided whether this invocation is even entitled to be fulfilled.
    // `after` rather than `requires`: an agent may settle without selling.
    after: ["payments", "mpp"],

    build(_ctx: BuildContext): KeeperHubSlice {
      const apiKey = options.apiKey ?? process.env.KEEPERHUB_API_KEY;
      if (!apiKey) {
        throw new Error(
          "keeperhub(): no API key. Pass `apiKey` or set KEEPERHUB_API_KEY. " +
            "Create one under Settings > Developer in KeeperHub; broadcasting needs the `mcp:write` scope."
        );
      }

      const client = new KeeperHubClient({ ...options, apiKey });
      const defaults = options.settlementDefaults ?? {};

      const withDefaultChain = (request: TransferRequest): TransferRequest =>
        request.chainId === undefined && options.defaultChainId !== undefined
          ? { ...request, chainId: options.defaultChainId }
          : request;

      return {
        keeperhub: {
          client,

          settle(request, settleOptions = {}) {
            return settleTransfer(client, withDefaultChain(request), {
              ...defaults,
              ...settleOptions,
            });
          },

          async simulate(request, signal) {
            try {
              const simulation = await client.simulateTransfer(withDefaultChain(request), {
                signal,
              });
              return { ok: true, gasEstimate: simulation.gasEstimate };
            } catch (error) {
              const reason =
                error instanceof KeeperHubError
                  ? (error.revertReason ?? error.message)
                  : error instanceof Error
                    ? error.message
                    : String(error);
              return { ok: false, reason };
            }
          },

          status(executionId, signal) {
            return client.getStatus(executionId, signal);
          },

          spendCap(signal) {
            return client.getSpendCap(signal);
          },

          settlingEntrypoints() {
            return [...settling];
          },
        },
      };
    },

    onEntrypointAdded(entrypoint: EntrypointDef) {
      const config = readSettlementConfig(entrypoint);
      if (!config) return;

      // Fail at build time rather than at the first paid invocation: an
      // entrypoint that cannot name its chain cannot settle, and finding that
      // out after taking someone's money is the expensive version.
      if (config.chainId === undefined && options.defaultChainId === undefined) {
        throw new Error(
          `Entrypoint "${entrypoint.key}" declares KeeperHub settlement but no chain. ` +
            "Set `metadata.keeperhub.chainId` on the entrypoint, or `defaultChainId` on keeperhub()."
        );
      }

      settling.add(entrypoint.key);
    },

    onManifestBuild(card: AgentManifest): AgentManifest {
      if (options.advertise === false || settling.size === 0) return card;

      const extensions = card.capabilities?.extensions ?? [];

      return {
        ...card,
        capabilities: {
          ...card.capabilities,
          extensions: [
            ...extensions,
            {
              uri: KEEPERHUB_EXTENSION_URI,
              description:
                "Onchain settlement executed deterministically through KeeperHub, with dry-run preflight, idempotent retries and a per-execution audit trail.",
              required: false,
              params: {
                settlingEntrypoints: [...settling],
                defaultChainId:
                  options.defaultChainId !== undefined
                    ? String(options.defaultChainId)
                    : undefined,
                auditTrail: true,
                dryRun: true,
                idempotent: true,
              },
            },
          ],
        },
      };
    },
  };
}
