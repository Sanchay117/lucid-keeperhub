import { describe, expect, it } from "vitest";

import {
  canonicalizeAddress,
  canonicalizeAmount,
  canonicalizeBody,
  deriveIdempotencyKey,
} from "../idempotency.js";

describe("canonicalizeAmount", () => {
  it("collapses spellings of the same value", () => {
    expect(canonicalizeAmount("0.10")).toBe("0.1");
    expect(canonicalizeAmount("0.1")).toBe("0.1");
    expect(canonicalizeAmount("00.100")).toBe("0.1");
    expect(canonicalizeAmount(" 0.1 ")).toBe("0.1");
    expect(canonicalizeAmount("1.")).toBe("1");
    expect(canonicalizeAmount(".5")).toBe("0.5");
    expect(canonicalizeAmount("+1.0")).toBe("1");
  });

  it("never emits -0, which would hash apart from 0", () => {
    expect(canonicalizeAmount("-0.0")).toBe("0");
    expect(canonicalizeAmount("-0")).toBe("0");
  });

  it("preserves precision rather than routing through Number", () => {
    // Number("0.1000000000000000001") === 0.1, which would change the amount.
    expect(canonicalizeAmount("0.1000000000000000001")).toBe("0.1000000000000000001");
    expect(canonicalizeAmount("123456789012345678901234567890")).toBe(
      "123456789012345678901234567890"
    );
  });

  it("leaves values it cannot safely normalize untouched", () => {
    expect(canonicalizeAmount("1e-1")).toBe("1e-1");
    expect(canonicalizeAmount("abc")).toBe("abc");
    expect(canonicalizeAmount("")).toBe("");
  });
});

describe("canonicalizeAddress", () => {
  it("lowercases EVM addresses", () => {
    expect(canonicalizeAddress("0x742d35Cc6634C0532925a3b844Bc454e4438f44e")).toBe(
      "0x742d35cc6634c0532925a3b844bc454e4438f44e"
    );
  });

  it("leaves non-addresses alone", () => {
    expect(canonicalizeAddress("not-an-address")).toBe("not-an-address");
    expect(canonicalizeAddress("0x123")).toBe("0x123");
  });
});

describe("canonicalizeBody", () => {
  it("orders keys deterministically", () => {
    const a = canonicalizeBody({ b: 1, a: 2, c: 3 });
    const b = canonicalizeBody({ c: 3, a: 2, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("normalizes amounts and addresses in one pass", () => {
    expect(
      canonicalizeBody({
        amount: "0.10",
        recipientAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      })
    ).toEqual({
      amount: "0.1",
      recipientAddress: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
    });
  });

  it("unifies numeric and string chain ids", () => {
    expect(canonicalizeBody({ chainId: 8453 })).toEqual({ chainId: "8453" });
    expect(canonicalizeBody({ chainId: "8453" })).toEqual({ chainId: "8453" });
  });

  it("drops undefined so an absent field and an explicit undefined agree", () => {
    expect(canonicalizeBody({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it("recurses into nested objects", () => {
    expect(canonicalizeBody({ outer: { amount: "1.50", z: 1, a: 2 } })).toEqual({
      outer: { a: 2, amount: "1.5", z: 1 },
    });
  });
});

describe("deriveIdempotencyKey", () => {
  const base = {
    workId: "run_123",
    endpoint: "/api/execute/transfer",
    body: { chainId: 8453, recipientAddress: "0xABCdef0123456789abcDEF0123456789aBCDeF01", amount: "0.1" },
  };

  it("is deterministic for the same work", () => {
    expect(deriveIdempotencyKey(base)).toBe(deriveIdempotencyKey(base));
  });

  it("survives a body reconstructed with different spellings", () => {
    // This is the documented 409 trap: same intent, re-serialized body.
    const reconstructed = {
      ...base,
      body: {
        amount: "0.10",
        chainId: "8453",
        recipientAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
      },
    };
    expect(deriveIdempotencyKey(reconstructed)).toBe(deriveIdempotencyKey(base));
  });

  it("separates genuinely different work", () => {
    const other = { ...base, body: { ...base.body, amount: "0.2" } };
    expect(deriveIdempotencyKey(other)).not.toBe(deriveIdempotencyKey(base));
  });

  it("separates the same work on different endpoints", () => {
    const other = { ...base, endpoint: "/api/execute/contract-call" };
    expect(deriveIdempotencyKey(other)).not.toBe(deriveIdempotencyKey(base));
  });

  it("separates different runs", () => {
    expect(deriveIdempotencyKey({ ...base, workId: "run_456" })).not.toBe(
      deriveIdempotencyKey(base)
    );
  });

  it("buckets occurrences so a cadence slower than the 24h window stays distinct", () => {
    const day = 24 * 60 * 60 * 1000;
    const first = deriveIdempotencyKey({ ...base, occurrenceMs: 0 });
    const sameBucket = deriveIdempotencyKey({ ...base, occurrenceMs: day - 1 });
    const nextBucket = deriveIdempotencyKey({ ...base, occurrenceMs: day });

    expect(sameBucket).toBe(first);
    expect(nextBucket).not.toBe(first);
  });

  it("is prefixed so it is recognisable in the audit trail", () => {
    expect(deriveIdempotencyKey(base)).toMatch(/^lucid-[0-9a-f]{32}$/);
  });
});
