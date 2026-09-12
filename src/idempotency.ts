/**
 * Stable idempotency keys and canonical request bodies.
 *
 * KeeperHub deduplicates fund-moving requests on a caller-supplied
 * `Idempotency-Key`, and every guarantee it offers depends on a retry sending
 * both the same key AND the same body. Two failure modes follow from that, and
 * this module exists to close both:
 *
 * 1. A key generated per attempt (`crypto.randomUUID()` inside the handler)
 *    does not survive a retry. The second attempt looks like new work and
 *    broadcasts a second transaction. We derive the key from the work instead,
 *    so it is reproducible without persisting anything.
 *
 * 2. A body that is rebuilt rather than replayed drifts in ways that do not
 *    change the onchain effect -- `"0.1"` against `"0.10"`, a checksummed
 *    address against a lowercase one, `1` against `"1"`. KeeperHub hashes the
 *    body to detect conflicts and normalizes key order but NOT values, so each
 *    of those returns 409 `idempotency_conflict` for work that is already in
 *    flight. The documented remedy is to canonicalize the body and keep the
 *    key, which is what `canonicalizeBody` does.
 *
 * @see https://docs.keeperhub.com/api/direct-execution#idempotency
 */

import { createHash } from "node:crypto";

/** Milliseconds in KeeperHub's 24h idempotency replay window. */
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Normalizes a decimal amount string to a canonical form.
 *
 * String-based on purpose: routing through `Number` would round
 * `"0.1000000000000000001"` and silently change the value being sent. We only
 * ever strip representational noise, never precision.
 *
 * `"0.10"` -> `"0.1"`, `"1."` -> `"1"`, `".5"` -> `"0.5"`, `"+1.0"` -> `"1"`,
 * `"-0.0"` -> `"0"`.
 */
export function canonicalizeAmount(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return trimmed;

  // Scientific notation has no single unambiguous decimal form we can produce
  // without arbitrary-precision maths, so leave it untouched rather than
  // guess. Callers are told to send plain decimals.
  if (/e/i.test(trimmed)) return trimmed;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return trimmed;

  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[+-]/, "");

  const [rawWhole = "", rawFraction = ""] = unsigned.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "") || "0";
  const fraction = rawFraction.replace(/0+$/, "");

  const magnitude = fraction ? `${whole}.${fraction}` : whole;
  // Never emit "-0": it hashes differently from "0" for the same value.
  if (magnitude === "0") return "0";
  return negative ? `-${magnitude}` : magnitude;
}

/**
 * Lowercases a 0x-prefixed EVM address.
 *
 * KeeperHub accepts either exact EIP-55 or all-lowercase and rejects any other
 * mixed case, so lowercase is the one form that is always valid AND always
 * hashes identically. Anything that is not an address-shaped string is
 * returned untouched.
 */
export function canonicalizeAddress(value: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim())
    ? value.trim().toLowerCase()
    : value;
}

/** Fields whose values are amounts, and so need decimal normalization. */
const AMOUNT_FIELDS = new Set([
  "amount",
  "value",
  "gasLimitMultiplier",
  "minAmountOut",
  "maxAmountIn",
]);

/** Fields whose values are addresses. */
const ADDRESS_FIELDS = new Set([
  "recipientAddress",
  "contractAddress",
  "tokenAddress",
  "spenderAddress",
  "fromAddress",
  "toAddress",
]);

/**
 * Produces the canonical form of a request body: deterministic key order,
 * normalized amounts and addresses, chain ids as numeric strings.
 *
 * This is what gets both hashed into the idempotency key and sent as the
 * request body, so the key and the body can never disagree about what the work
 * is.
 */
export function canonicalizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(body).sort()) {
    const value = body[key];
    if (value === undefined) continue;

    if (key === "chainId") {
      // The API accepts a number or a numeric string; pick one so the two
      // spellings of the same chain hash alike.
      out[key] = typeof value === "number" ? String(value) : canonicalizeAmount(String(value));
      continue;
    }

    if (typeof value === "string") {
      if (AMOUNT_FIELDS.has(key)) {
        out[key] = canonicalizeAmount(value);
        continue;
      }
      if (ADDRESS_FIELDS.has(key)) {
        out[key] = canonicalizeAddress(value);
        continue;
      }
      out[key] = value;
      continue;
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = canonicalizeBody(value as Record<string, unknown>);
      continue;
    }

    out[key] = value;
  }

  return out;
}

/** Inputs that determine an idempotency key. */
export type IdempotencyKeyInput = {
  /**
   * The caller's own stable identifier for this unit of work. In a Lucid agent
   * this is the invocation `runId`, which is already stable across a retry of
   * the same invocation.
   */
  workId: string;
  /** The canonical request body. Its hash binds the key to the effect. */
  body: Record<string, unknown>;
  /** Endpoint path, so the same work against two endpoints cannot collide. */
  endpoint: string;
  /**
   * Optional coarse time bucket. KeeperHub forgets a key after 24h, so work
   * that recurs on a cadence of a day or longer must vary its key or the
   * second run is silently treated as new. Pass the scheduled occurrence time
   * for recurring jobs; omit it for one-shot work.
   */
  occurrenceMs?: number;
};

/**
 * Derives a deterministic `Idempotency-Key` for a unit of work.
 *
 * Same work in, same key out -- on this process or any other, now or on a
 * retry an hour later. That is the whole point: a retry can reconstruct the
 * key from the work rather than having had to persist it before the first
 * attempt.
 */
export function deriveIdempotencyKey(input: IdempotencyKeyInput): string {
  const canonical = canonicalizeBody(input.body);

  const parts = [
    input.endpoint,
    input.workId,
    JSON.stringify(canonical),
  ];

  if (input.occurrenceMs !== undefined) {
    // Bucket to the replay window so a cadence slower than 24h always lands in
    // a fresh bucket, while retries of one occurrence stay in the same one.
    parts.push(String(Math.floor(input.occurrenceMs / REPLAY_WINDOW_MS)));
  }

  const digest = createHash("sha256").update(parts.join("\n")).digest("hex");
  // Prefixed so a key is recognisable in KeeperHub's audit trail as having
  // come from a Lucid agent rather than a hand-rolled caller.
  return `lucid-${digest.slice(0, 32)}`;
}
