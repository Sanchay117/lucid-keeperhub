/**
 * Choosing the work identity a settlement is deduplicated on.
 *
 * The obvious anchor inside a Lucid handler is `runId`, and it is the wrong one
 * for anything a buyer can retry. `@lucid-agents/http` mints a fresh
 * `crypto.randomUUID()` for every HTTP request, so a buyer that retries a
 * timed-out call arrives with a new `runId` -- and a settlement keyed on it is
 * new work to KeeperHub, which broadcasts a second transfer.
 *
 * Lucid does deduplicate retries at the HTTP layer when the buyer sends an
 * `Idempotency-Key`: a completed invocation is replayed from its idempotency
 * store without running the handler again. That store is process-local by
 * default, though. A seller restart, a second instance behind a load balancer,
 * or an in-progress claim that outlives its TTL all run the handler again, with
 * a new `runId`.
 *
 * Anchoring the KeeperHub key to the buyer's `Idempotency-Key` closes that gap:
 * whatever Lucid forgets, KeeperHub's 24h execution-level record still matches
 * the retry to the transfer that already happened. Two independent layers, and
 * the durable one is the one that guards the money.
 */

/** The parts of a Lucid handler context that identify a unit of work. */
export type InvocationContext = {
  /** Entrypoint key. Scopes the work so two entrypoints cannot share a key. */
  key: string;
  /** Per-request id minted by Lucid. The fallback anchor. */
  runId?: string;
  /** `@lucid-agents/http` places the request `Headers` at `metadata.headers`. */
  metadata?: Record<string, unknown>;
  /** Verified caller identity (SIWx), when the entrypoint requires one. */
  auth?: { address?: string; chainId?: string };
};

export type WorkIdSource = "idempotency-key" | "run-id";

export type ResolvedWorkId = {
  workId: string;
  /**
   * `idempotency-key` survives buyer retries and seller restarts.
   * `run-id` only survives retries inside this one invocation.
   */
  source: WorkIdSource;
};

type HeaderBag = { get(name: string): string | null } | Record<string, unknown>;

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;

  const bag = headers as HeaderBag;
  if (typeof (bag as { get?: unknown }).get === "function") {
    const value = (bag as { get(name: string): string | null }).get(name);
    return typeof value === "string" ? value : undefined;
  }

  // Plain objects: header names are case-insensitive, object keys are not.
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
    if (key.toLowerCase() === wanted && typeof value === "string") return value;
  }
  return undefined;
}

/** Reads the buyer's `Idempotency-Key` from a Lucid invocation, if it sent one. */
export function idempotencyKeyOf(context: InvocationContext): string | undefined {
  const value = readHeader(context.metadata?.headers, "Idempotency-Key")?.trim();
  return value ? value : undefined;
}

/**
 * Resolves the work id a settlement should be deduplicated on.
 *
 * The buyer's key is scoped by entrypoint and by verified caller, because the
 * key is chosen by the caller: without the caller in scope, two buyers who
 * happen to pick the same key for the same payout would be treated as one, and
 * the second would be handed the first one's transaction instead of being paid.
 */
export function resolveWorkId(context: InvocationContext): ResolvedWorkId {
  const buyerKey = idempotencyKeyOf(context);
  if (buyerKey) {
    const caller =
      context.auth?.address !== undefined
        ? `${context.auth.chainId ?? ""}:${context.auth.address.toLowerCase()}`
        : "anonymous";
    return {
      workId: `idem|${context.key}|${caller}|${buyerKey}`,
      source: "idempotency-key",
    };
  }

  if (context.runId) {
    return { workId: `run|${context.key}|${context.runId}`, source: "run-id" };
  }

  throw new Error(
    `Cannot settle for entrypoint "${context.key}": the invocation has neither an Idempotency-Key header nor a runId, so a retry could not be matched to this transfer.`
  );
}
