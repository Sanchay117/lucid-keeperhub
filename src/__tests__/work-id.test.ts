import { describe, expect, it } from "vitest";

import { idempotencyKeyOf, resolveWorkId } from "../work-id.js";

const KEY = "order-7f3a1c9e-0001-4b2a";

describe("idempotencyKeyOf", () => {
  it("reads the header from a Headers instance, as @lucid-agents/http passes it", () => {
    const headers = new Headers({ "Idempotency-Key": KEY });
    expect(idempotencyKeyOf({ key: "settle", metadata: { headers } })).toBe(KEY);
  });

  it("reads it case-insensitively from a plain object", () => {
    expect(idempotencyKeyOf({ key: "settle", metadata: { headers: { "idempotency-key": KEY } } })).toBe(KEY);
  });

  it("ignores a blank header", () => {
    expect(idempotencyKeyOf({ key: "settle", metadata: { headers: new Headers({ "Idempotency-Key": "  " }) } })).toBeUndefined();
  });

  it("is undefined when there is no metadata", () => {
    expect(idempotencyKeyOf({ key: "settle" })).toBeUndefined();
  });
});

describe("resolveWorkId", () => {
  const withKey = (extra: Record<string, unknown> = {}) => ({
    key: "settle",
    runId: "run-1",
    metadata: { headers: new Headers({ "Idempotency-Key": KEY }) },
    ...extra,
  });

  it("prefers the buyer's Idempotency-Key over runId", () => {
    expect(resolveWorkId(withKey())).toEqual({
      workId: `idem|settle|anonymous|${KEY}`,
      source: "idempotency-key",
    });
  });

  it("ignores runId once a key is present, so a retry with a new runId matches", () => {
    // This is the whole point: @lucid-agents/http mints a new runId per request.
    expect(resolveWorkId(withKey({ runId: "run-2" })).workId).toBe(resolveWorkId(withKey()).workId);
  });

  it("scopes the key by verified caller, so two buyers picking one key stay apart", () => {
    const alice = resolveWorkId(withKey({ auth: { address: "0xAAAA", chainId: "eip155:8453" } }));
    const bob = resolveWorkId(withKey({ auth: { address: "0xBBBB", chainId: "eip155:8453" } }));
    expect(alice.workId).not.toBe(bob.workId);
  });

  it("treats caller address case-insensitively", () => {
    const upper = resolveWorkId(withKey({ auth: { address: "0xABCD", chainId: "eip155:1" } }));
    const lower = resolveWorkId(withKey({ auth: { address: "0xabcd", chainId: "eip155:1" } }));
    expect(upper.workId).toBe(lower.workId);
  });

  it("scopes by entrypoint", () => {
    expect(resolveWorkId(withKey({ key: "refund" })).workId).not.toBe(resolveWorkId(withKey()).workId);
  });

  it("falls back to runId and says so", () => {
    expect(resolveWorkId({ key: "settle", runId: "run-1" })).toEqual({
      workId: "run|settle|run-1",
      source: "run-id",
    });
  });

  it("refuses when there is nothing to anchor a retry to", () => {
    expect(() => resolveWorkId({ key: "settle" })).toThrow(/neither an Idempotency-Key header nor a runId/);
  });
});
