import { describe, expect, it } from "vitest";

import { classifyError } from "../errors.js";

const headers = (map: Record<string, string> = {}) => ({
  get: (name: string) => map[name.toLowerCase()] ?? null,
});

describe("classifyError discriminator ordering", () => {
  it("prefers an attributed code over failureKind and wouldRevert", () => {
    // A funding shortfall can arrive alongside revert-ish fields. The coded
    // attribution is the specific one and has to win.
    const error = classifyError(
      400,
      { code: "insufficient_balance", failureKind: "revert", wouldRevert: true },
      headers()
    );
    expect(error.kind).toBe("insufficient_funds");
  });

  it("reads failureKind before wouldRevert", () => {
    const error = classifyError(400, { failureKind: "validation", wouldRevert: true }, headers());
    expect(error.kind).toBe("validation");
  });

  it("treats a confirmed revert as a revert", () => {
    const error = classifyError(
      400,
      { failureKind: "revert", wouldRevert: true, revertReason: "Error(ERC20: transfer amount exceeds balance)" },
      headers()
    );
    expect(error.kind).toBe("revert");
    expect(error.revertReason).toContain("exceeds balance");
    expect(error.retryable).toBe(false);
  });

  it("does not label a bare 400 a revert", () => {
    const error = classifyError(400, { error: "Missing required field", field: "chainId" }, headers());
    expect(error.kind).toBe("validation");
  });

  it("classifies simulator outage as unavailable and retryable", () => {
    const error = classifyError(503, { failureKind: "unavailable", wouldRevert: false }, headers());
    expect(error.kind).toBe("unavailable");
    expect(error.retryable).toBe(true);
  });
});

describe("classifyError idempotency codes", () => {
  it("marks in-progress retryable under the same key", () => {
    const error = classifyError(
      409,
      { code: "idempotency_in_progress", retryable: true },
      headers()
    );
    expect(error.kind).toBe("idempotency_in_progress");
    expect(error.retryable).toBe(true);
  });

  it("marks conflict non-retryable and surfaces the original execution", () => {
    const error = classifyError(
      409,
      { code: "idempotency_conflict", retryable: false, originalExecutionId: "exec_1" },
      headers()
    );
    expect(error.kind).toBe("idempotency_conflict");
    expect(error.retryable).toBe(false);
    expect(error.originalExecutionId).toBe("exec_1");
  });
});

describe("classifyError auth and limits", () => {
  it("separates insufficient scope from the spend cap, both of which are 403", () => {
    const scope = classifyError(
      403,
      { error: "insufficient_scope", required_scope: "mcp:write", granted_scope: "mcp:read" },
      headers()
    );
    expect(scope.kind).toBe("insufficient_scope");
    expect(scope.requiredScope).toBe("mcp:write");
    expect(scope.retryable).toBe(false);

    const cap = classifyError(403, { error: "Daily spending cap exceeded" }, headers());
    expect(cap.kind).toBe("spend_cap");
  });

  it("reads Retry-After off the response headers", () => {
    const error = classifyError(429, { error: "Rate limit exceeded" }, headers({ "retry-after": "12" }));
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.retryable).toBe(true);
  });

  it("maps 401 and 422 to their documented meanings", () => {
    expect(classifyError(401, {}, headers()).kind).toBe("unauthorized");
    expect(classifyError(422, { code: "WALLET_NOT_CONFIGURED" }, headers()).kind).toBe(
      "wallet_not_configured"
    );
  });

  it("defaults an unattributed failure to not-retryable", () => {
    // Conservative on purpose: a misclassified retry can broadcast twice.
    const error = classifyError(418, {}, headers());
    expect(error.kind).toBe("unknown");
    expect(error.retryable).toBe(false);
  });
});
