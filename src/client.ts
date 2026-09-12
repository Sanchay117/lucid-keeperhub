/**
 * A typed client for the KeeperHub Direct Execution API.
 *
 * Three behaviours here are not conveniences -- they are the difference
 * between an agent that moves money once and one that moves it twice:
 *
 * - Every fund-moving request carries a derived `Idempotency-Key` and the
 *   canonical body that key was computed from.
 * - `idempotency_in_progress` is retried under the SAME key, never a fresh
 *   one. Rotating there escapes the in-progress guard on a request that may
 *   already have broadcast.
 * - A failure carrying a transaction hash is never retried. The hash means a
 *   transaction is already live; a retry signs a second one.
 *
 * @see https://docs.keeperhub.com/api/direct-execution
 */

import { classifyError, KeeperHubError, type KeeperHubErrorBody } from "./errors.js";
import { canonicalizeBody, deriveIdempotencyKey } from "./idempotency.js";
import type {
  ContractCallRequest,
  ExecutionResult,
  ExecutionStatusResult,
  SimulationResult,
  SpendCapResult,
  TransferRequest,
} from "./types.js";

export type KeeperHubClientOptions = {
  /** Organization API key (`kh_...`). */
  apiKey: string;
  /** Defaults to the hosted app. Override for self-hosted deployments. */
  baseUrl?: string;
  /** Per-request timeout in ms. Default 60s -- execute endpoints run synchronously. */
  timeoutMs?: number;
  /** Max attempts for retryable failures. Default 4. */
  maxAttempts?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests, so backoff does not make suites slow. */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_BASE_URL = "https://app.keeperhub.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 4;

/** Options carried on any call that can move value. */
export type ExecuteOptions = {
  /**
   * Stable identifier for this unit of work. In a Lucid handler this is the
   * invocation `runId`. Omitting it disables idempotency entirely, which is
   * only ever correct for a read.
   */
  workId?: string;
  /** Scheduled occurrence time, for work recurring on a cadence over 24h. */
  occurrenceMs?: number;
  /** Pre-computed key. Overrides derivation; use when you persist keys yourself. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

function sleepDefault(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, capped. */
function backoffMs(attempt: number): number {
  const capped = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return Math.floor(Math.random() * capped);
}

export class KeeperHubClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: KeeperHubClientOptions) {
    if (!options.apiKey) {
      throw new Error("KeeperHubClient requires an apiKey (kh_...)");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? sleepDefault;
  }

  /**
   * Issues one request, classifying the response. Retries only failures that
   * are safe to repeat under an unchanged idempotency key.
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    init: {
      body?: Record<string, unknown>;
      idempotencyKey?: string;
      signal?: AbortSignal;
      /**
       * True when repeating this request cannot have a second side effect --
       * reads and dry runs. A write is repeat-safe only when it carries an
       * idempotency key for KeeperHub to match the retry against.
       */
      repeatSafe?: boolean;
    } = {}
  ): Promise<T> {
    const repeatSafe = init.repeatSafe === true || Boolean(init.idempotencyKey);
    const url = `${this.baseUrl}${path}`;
    let lastError: KeeperHubError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), this.timeoutMs);

      // Caller aborts and our timeout both have to cancel the request.
      const onExternalAbort = () => timeout.abort();
      init.signal?.addEventListener("abort", onExternalAbort, { once: true });

      let response: Response;
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        };
        if (init.body) headers["Content-Type"] = "application/json";
        if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

        response = await this.fetchImpl(url, {
          method,
          headers,
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: timeout.signal,
        });
      } catch (cause) {
        // A transport failure tells us nothing about whether the request was
        // received. Retrying is safe only because the idempotency key is
        // unchanged: if the first attempt did land, we get a replay.
        lastError = new KeeperHubError({
          message: `KeeperHub request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          kind: repeatSafe ? "unavailable" : "unknown",
          status: 0,
        });
        if (!repeatSafe || attempt === this.maxAttempts) throw lastError;
        await this.sleep(backoffMs(attempt));
        continue;
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onExternalAbort);
      }

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { error: text || `Non-JSON response (${response.status})` };
      }

      if (response.ok) return parsed as T;

      const body = (parsed ?? {}) as KeeperHubErrorBody;
      const error = classifyError(response.status, body, response.headers);

      // A hash means a transaction is live. Whatever the message says, a
      // retry signs a second one rather than replacing the first.
      const carriesHash =
        typeof (parsed as { transactionHash?: unknown })?.transactionHash === "string";
      if (carriesHash) throw error;

      // A 429 is rejected before execution, so repeating it is safe whether or
      // not a key is in play. A 5xx or a dropped connection is not: the
      // request may have executed and failed only on the way back, so it may
      // be repeated only when KeeperHub can match the retry to the original.
      const canRetry =
        error.kind === "idempotency_in_progress" ||
        error.kind === "rate_limited" ||
        (error.kind === "unavailable" && repeatSafe);

      if (!canRetry || attempt === this.maxAttempts) throw error;

      // Honour the server's own pacing when it gives us one.
      const waitMs =
        error.retryAfterSeconds !== undefined
          ? error.retryAfterSeconds * 1000
          : backoffMs(attempt);
      await this.sleep(waitMs);
      lastError = error;
    }

    throw lastError ?? new KeeperHubError({
      message: "KeeperHub request exhausted retries",
      kind: "unknown",
      status: 0,
    });
  }

  /** Prepares the canonical body and matching idempotency key for a write. */
  private prepare(
    endpoint: string,
    body: Record<string, unknown>,
    options: ExecuteOptions
  ): { body: Record<string, unknown>; idempotencyKey?: string } {
    const canonical = canonicalizeBody(body);
    if (options.idempotencyKey) {
      return { body: canonical, idempotencyKey: options.idempotencyKey };
    }
    if (!options.workId) return { body: canonical };
    return {
      body: canonical,
      idempotencyKey: deriveIdempotencyKey({
        workId: options.workId,
        body: canonical,
        endpoint,
        occurrenceMs: options.occurrenceMs,
      }),
    };
  }

  /** Transfers native or ERC-20 value. Broadcasts. */
  async transfer(req: TransferRequest, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    const endpoint = "/api/execute/transfer";
    const prepared = this.prepare(endpoint, req as unknown as Record<string, unknown>, options);
    return this.request<ExecutionResult>("POST", endpoint, {
      body: prepared.body,
      idempotencyKey: prepared.idempotencyKey,
      signal: options.signal,
    });
  }

  /** Dry-runs a transfer. Never signs or broadcasts; `mcp:read` is sufficient. */
  async simulateTransfer(
    req: TransferRequest,
    options: Pick<ExecuteOptions, "signal"> = {}
  ): Promise<SimulationResult> {
    return this.request<SimulationResult>("POST", "/api/execute/transfer", {
      // A dry run is not deduplicated, so it deliberately carries no key --
      // and it never broadcasts, so repeating it is always safe.
      body: canonicalizeBody({ ...req, simulate: true }),
      repeatSafe: true,
      signal: options.signal,
    });
  }

  /** Calls a contract function. Broadcasts when the function is a write. */
  async contractCall(
    req: ContractCallRequest,
    options: ExecuteOptions = {}
  ): Promise<ExecutionResult> {
    const endpoint = "/api/execute/contract-call";
    const prepared = this.prepare(endpoint, req as unknown as Record<string, unknown>, options);
    return this.request<ExecutionResult>("POST", endpoint, {
      body: prepared.body,
      idempotencyKey: prepared.idempotencyKey,
      signal: options.signal,
    });
  }

  /** Dry-runs a contract call. */
  async simulateContractCall(
    req: ContractCallRequest,
    options: Pick<ExecuteOptions, "signal"> = {}
  ): Promise<SimulationResult> {
    return this.request<SimulationResult>("POST", "/api/execute/contract-call", {
      body: canonicalizeBody({ ...req, simulate: true }),
      repeatSafe: true,
      signal: options.signal,
    });
  }

  /** Reads the stored execution record. The authoritative source for a hash. */
  async getStatus(executionId: string, signal?: AbortSignal): Promise<ExecutionStatusResult> {
    return this.request<ExecutionStatusResult>(
      "GET",
      `/api/execute/${encodeURIComponent(executionId)}/status`,
      { signal, repeatSafe: true }
    );
  }

  /** Reads the org's daily native-value spending caps. */
  async getSpendCap(signal?: AbortSignal): Promise<SpendCapResult> {
    return this.request<SpendCapResult>("GET", "/api/analytics/spend-cap", {
      signal,
      repeatSafe: true,
    });
  }
}
