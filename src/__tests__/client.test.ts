import { describe, expect, it, vi } from "vitest";

import { KeeperHubClient } from "../client.js";
import { KeeperHubError } from "../errors.js";

type Call = { url: string; init: RequestInit };

/** Builds a fetch stub that replays a fixed queue of responses. */
function stubFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("stubFetch: unexpected extra request");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

const client = (responses: Parameters<typeof stubFetch>[0], overrides = {}) => {
  const { fetchImpl, calls } = stubFetch(responses);
  return {
    calls,
    fetchImpl,
    instance: new KeeperHubClient({
      apiKey: "kh_test",
      fetch: fetchImpl,
      sleep: async () => {},
      ...overrides,
    }),
  };
};

const transfer = {
  chainId: 84532,
  recipientAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  amount: "0.10",
};

describe("authentication and headers", () => {
  it("sends the bearer key and a derived idempotency key on a write", async () => {
    const { instance, calls } = client([
      { status: 202, body: { executionId: "e1", status: "completed", transactionHash: "0xabc" } },
    ]);

    await instance.transfer(transfer, { workId: "run_1" });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer kh_test");
    expect(headers["Idempotency-Key"]).toMatch(/^lucid-/);
  });

  it("sends the canonical body, not the caller's spelling", async () => {
    const { instance, calls } = client([
      { status: 202, body: { executionId: "e1", status: "completed" } },
    ]);

    await instance.transfer(transfer, { workId: "run_1" });

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      amount: "0.1",
      chainId: "84532",
      recipientAddress: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
    });
  });

  it("omits the idempotency key when there is no work id", async () => {
    const { instance, calls } = client([
      { status: 202, body: { executionId: "e1", status: "completed" } },
    ]);

    await instance.transfer(transfer);

    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("never sends an idempotency key on a dry run", async () => {
    const { instance, calls } = client([
      { status: 200, body: { success: true, status: "simulated", gasEstimate: "21000" } },
    ]);

    await instance.simulateTransfer(transfer);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string).simulate).toBe(true);
  });
});

describe("retry policy", () => {
  it("retries an in-progress duplicate under the SAME key", async () => {
    const { instance, calls } = client([
      { status: 409, body: { code: "idempotency_in_progress", retryable: true } },
      { status: 202, body: { executionId: "e1", status: "completed", transactionHash: "0xabc" } },
    ]);

    const result = await instance.transfer(transfer, { workId: "run_1" });

    expect(result.executionId).toBe("e1");
    expect(calls).toHaveLength(2);
    const first = (calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"];
    const second = (calls[1]!.init.headers as Record<string, string>)["Idempotency-Key"];
    // Rotating here would escape the in-progress guard on a request that may
    // already have broadcast.
    expect(second).toBe(first);
  });

  it("honours Retry-After on a rate limit", async () => {
    const sleep = vi.fn(async () => {});
    const { instance } = client(
      [
        { status: 429, body: { error: "Rate limit exceeded" }, headers: { "retry-after": "3" } },
        { status: 202, body: { executionId: "e1", status: "completed" } },
      ],
      { sleep }
    );

    await instance.transfer(transfer, { workId: "run_1" });

    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("never retries a failure that carries a transaction hash", async () => {
    // The hash means a transaction is already live. A retry signs a second one.
    const { instance, calls } = client([
      {
        status: 500,
        body: { error: "Timed out waiting for receipt", transactionHash: "0xlive" },
      },
    ]);

    await expect(instance.transfer(transfer, { workId: "run_1" })).rejects.toBeInstanceOf(
      KeeperHubError
    );
    expect(calls).toHaveLength(1);
  });

  it("does not retry a revert", async () => {
    const { instance, calls } = client([
      {
        status: 400,
        body: { failureKind: "revert", wouldRevert: true, revertReason: "Error(nope)" },
      },
    ]);

    await expect(instance.transfer(transfer, { workId: "run_1" })).rejects.toMatchObject({
      kind: "revert",
    });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a transport failure when there is no idempotency key", async () => {
    // Without a key a retry cannot be matched to the first attempt, so it is
    // a fresh request that could double-send.
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof globalThis.fetch;
    const instance = new KeeperHubClient({ apiKey: "kh_test", fetch: fetchImpl, sleep: async () => {} });

    await expect(instance.transfer(transfer)).rejects.toBeInstanceOf(KeeperHubError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a transport failure when a key makes the retry safe", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify({ executionId: "e1", status: "completed" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const instance = new KeeperHubClient({ apiKey: "kh_test", fetch: fetchImpl, sleep: async () => {} });
    const result = await instance.transfer(transfer, { workId: "run_1" });

    expect(result.executionId).toBe("e1");
    expect(attempt).toBe(2);
  });

  it("gives up after maxAttempts", async () => {
    const { instance, calls } = client(
      Array.from({ length: 3 }, () => ({
        status: 429 as const,
        body: { error: "Rate limit exceeded" },
      })),
      { maxAttempts: 3 }
    );

    await expect(instance.transfer(transfer, { workId: "run_1" })).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(calls).toHaveLength(3);
  });
});

describe("replay marker", () => {
  it("surfaces idempotentReplay so a caller can tell a replay from fresh work", async () => {
    const { instance } = client([
      {
        status: 202,
        body: { executionId: "e1", status: "completed", transactionHash: "0xabc", idempotentReplay: true },
      },
    ]);

    const result = await instance.transfer(transfer, { workId: "run_1" });
    expect(result.idempotentReplay).toBe(true);
  });
});

describe("scope and configuration errors", () => {
  it("does not retry an insufficient-scope refusal", async () => {
    const { instance, calls } = client([
      {
        status: 403,
        body: { error: "insufficient_scope", required_scope: "mcp:write", granted_scope: "mcp:read" },
      },
    ]);

    await expect(instance.transfer(transfer, { workId: "run_1" })).rejects.toMatchObject({
      kind: "insufficient_scope",
      requiredScope: "mcp:write",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses to construct without an api key", () => {
    expect(() => new KeeperHubClient({ apiKey: "" })).toThrow(/requires an apiKey/);
  });
});

describe("repeat safety", () => {
  it("does not retry a 5xx on an unkeyed write", async () => {
    // Without a key KeeperHub cannot match a retry to the original request, so
    // a 500 that may have broadcast must not be repeated.
    const { instance, calls } = client([
      { status: 500, body: { error: "upstream exploded" } },
      { status: 202, body: { executionId: "e1", status: "completed" } },
    ]);

    await expect(instance.transfer(transfer)).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
  });

  it("does retry a 5xx on a keyed write", async () => {
    const { instance, calls } = client([
      { status: 500, body: { error: "upstream exploded" } },
      { status: 202, body: { executionId: "e1", status: "completed" } },
    ]);

    const result = await instance.transfer(transfer, { workId: "run_1" });
    expect(result.executionId).toBe("e1");
    expect(calls).toHaveLength(2);
  });

  it("retries a 5xx on a dry run, which cannot broadcast", async () => {
    const { instance, calls } = client([
      { status: 503, body: { failureKind: "unavailable" } },
      { status: 200, body: { success: true, status: "simulated", gasEstimate: "21000" } },
    ]);

    const result = await instance.simulateTransfer(transfer);
    expect(result.gasEstimate).toBe("21000");
    expect(calls).toHaveLength(2);
  });

  it("retries a rate limit even on an unkeyed write, which was never executed", async () => {
    const { instance, calls } = client([
      { status: 429, body: { error: "Rate limit exceeded" } },
      { status: 202, body: { executionId: "e1", status: "completed" } },
    ]);

    await instance.transfer(transfer);
    expect(calls).toHaveLength(2);
  });
});
