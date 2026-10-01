/**
 * Error taxonomy for the KeeperHub Direct Execution API.
 *
 * The KeeperHub API does not signal failure with status codes alone: a 400 can
 * be a malformed request, a confirmed EVM revert, or a funding shortfall, and
 * the three demand different responses from a caller. The docs prescribe a
 * strict read order for the discriminators -- `code`, then `failureKind`, then
 * `wouldRevert` -- precisely so a generic "non-2xx means bad request" wrapper
 * cannot discard chain-state diagnostics. `classifyError` is that read order,
 * written once.
 *
 * @see https://docs.keeperhub.com/api/direct-execution
 */

/** Failure classes a caller has to tell apart to react correctly. */
export type KeeperHubFailureKind =
  /** Request never reached the chain: bad params, bad address, bad ABI. */
  | "validation"
  /** The chain would reject (or did reject) the call. Never retry as-is. */
  | "revert"
  /** Sender cannot fund the call. Retrying without topping up repeats it. */
  | "insufficient_funds"
  /** Daily org spending cap hit. Retrying before reset repeats it. */
  | "spend_cap"
  /** Credential lacks the scope. Never retryable -- the key must be reissued. */
  | "insufficient_scope"
  /** Auth rejected outright. */
  | "unauthorized"
  /** Org wallet not provisioned yet. */
  | "wallet_not_configured"
  /** Rate limited. Retry after `retryAfterSeconds`. */
  | "rate_limited"
  /** Same idempotency key still in flight. Retry the SAME key shortly. */
  | "idempotency_in_progress"
  /** Same key, different body. Do not blindly rotate -- see docs. */
  | "idempotency_conflict"
  /** Simulator or upstream infrastructure is down. Retry later. */
  | "unavailable"
  /** Anything we could not attribute. */
  | "unknown";

/** Raw JSON body shapes the execute endpoints return on failure. */
export type KeeperHubErrorBody = {
  error?: string;
  message?: string;
  code?: string;
  field?: string;
  details?: string;
  failureKind?: string;
  wouldRevert?: boolean;
  revertReason?: string;
  retryable?: boolean;
  required_scope?: string;
  granted_scope?: string;
  originalExecutionId?: string;
  idempotentReplay?: boolean;
  /** Present when the failure came after a transaction was broadcast. */
  transactionHash?: string;
  transactionLink?: string;
};

export class KeeperHubError extends Error {
  readonly kind: KeeperHubFailureKind;
  readonly status: number;
  readonly code?: string;
  readonly revertReason?: string;
  readonly retryAfterSeconds?: number;
  readonly requiredScope?: string;
  readonly grantedScope?: string;
  readonly originalExecutionId?: string;
  readonly body: KeeperHubErrorBody;

  constructor(init: {
    message: string;
    kind: KeeperHubFailureKind;
    status: number;
    code?: string;
    revertReason?: string;
    retryAfterSeconds?: number;
    requiredScope?: string;
    grantedScope?: string;
    originalExecutionId?: string;
    body?: KeeperHubErrorBody;
  }) {
    super(init.message);
    this.name = "KeeperHubError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.revertReason = init.revertReason;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.requiredScope = init.requiredScope;
    this.grantedScope = init.grantedScope;
    this.originalExecutionId = init.originalExecutionId;
    this.body = init.body ?? {};
  }

  /**
   * Whether sending this exact request again, under the same idempotency key,
   * could plausibly succeed.
   *
   * Deliberately conservative: anything we could not attribute is treated as
   * NOT retryable. A value-moving call that we misclassify as retryable can
   * broadcast twice, which is strictly worse than surfacing a failure a human
   * has to look at.
   */
  get retryable(): boolean {
    if (typeof this.body.retryable === "boolean") return this.body.retryable;
    return this.kind === "rate_limited" || this.kind === "unavailable";
  }
}

/**
 * Maps an HTTP response to a failure kind, following the discriminator order
 * the KeeperHub docs mandate: an attributed `code` first, then `failureKind`,
 * then `wouldRevert`. Reading `wouldRevert` first would label a plain
 * validation error a revert; reading status first would label both as "bad
 * request" and lose the distinction entirely.
 */
export function classifyError(
  status: number,
  body: KeeperHubErrorBody,
  headers?: { get(name: string): string | null }
): KeeperHubError {
  // The revert reason is the single most actionable field on a failed call,
  // so it is preferred over a generic status message when nothing else names
  // the cause.
  const message =
    body.error ??
    body.message ??
    body.revertReason ??
    body.details ??
    `KeeperHub request failed (${status})`;

  const retryAfterRaw = headers?.get("retry-after");
  const retryAfterSeconds = retryAfterRaw ? Number(retryAfterRaw) : undefined;

  const base = {
    message,
    status,
    code: body.code,
    revertReason: body.revertReason,
    requiredScope: body.required_scope,
    grantedScope: body.granted_scope,
    originalExecutionId: body.originalExecutionId,
    retryAfterSeconds:
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : undefined,
    body,
  };

  // 1. An attributed code is the most specific signal the API gives us.
  switch (body.code) {
    case "idempotency_in_progress":
      return new KeeperHubError({ ...base, kind: "idempotency_in_progress" });
    case "idempotency_conflict":
      return new KeeperHubError({ ...base, kind: "idempotency_conflict" });
    case "insufficient_balance":
      return new KeeperHubError({ ...base, kind: "insufficient_funds" });
    case "WALLET_NOT_CONFIGURED":
      return new KeeperHubError({ ...base, kind: "wallet_not_configured" });
    default:
      break;
  }

  // `insufficient_scope` arrives in `error` rather than `code`.
  if (body.error === "insufficient_scope" || body.code === "insufficient_scope") {
    return new KeeperHubError({ ...base, kind: "insufficient_scope" });
  }

  // 2. failureKind distinguishes a real revert from a preflight failure.
  if (body.failureKind === "revert") {
    return new KeeperHubError({ ...base, kind: "revert" });
  }
  if (body.failureKind === "unavailable") {
    return new KeeperHubError({ ...base, kind: "unavailable" });
  }
  if (body.failureKind === "validation") {
    return new KeeperHubError({ ...base, kind: "validation" });
  }

  // 3. wouldRevert only as a last resort, never as a standalone discriminator.
  if (body.wouldRevert === true) {
    return new KeeperHubError({ ...base, kind: "revert" });
  }

  // 4. Fall back to transport-level status.
  switch (status) {
    case 401:
      return new KeeperHubError({ ...base, kind: "unauthorized" });
    case 403:
      // 403 is overloaded: scope was handled above, so this is the spend cap.
      return new KeeperHubError({ ...base, kind: "spend_cap" });
    case 422:
      return new KeeperHubError({ ...base, kind: "wallet_not_configured" });
    case 429:
      return new KeeperHubError({ ...base, kind: "rate_limited" });
    case 400:
      return new KeeperHubError({ ...base, kind: "validation" });
    default:
      if (status >= 500) {
        return new KeeperHubError({ ...base, kind: "unavailable" });
      }
      return new KeeperHubError({ ...base, kind: "unknown" });
  }
}
