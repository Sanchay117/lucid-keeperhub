import { describe, expect, it, vi } from "vitest";

import { KeeperHubClient } from "../client.js";
import { settleTransfer } from "../settle.js";

function stub(responses: Array<{ status: number; body: unknown }>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  return {
    calls,
    client: new KeeperHubClient({ apiKey: "kh_test", fetch: fetchImpl, sleep: async () => {} }),
  };
}

const request = {
  chainId: 84532,
  recipientAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  amount: "0.01",
};

const okSimulation = {
  status: 200,
  body: { success: true, status: "simulated", from: "0xorg", to: "0xdest", value: "0", gasEstimate: "21000", wouldRevert: false },
};

describe("preflight", () => {
  it("dry-runs before broadcasting and reports the gas estimate", async () => {
    const { client, calls } = stub([
      okSimulation,
      { status: 202, body: { executionId: "e1", status: "completed", transactionHash: "0xabc" } },
      { status: 200, body: { executionId: "e1", status: "completed", type: "transfer", network: "84532", transactionHash: "0xabc", transactionLink: "https://sepolia.basescan.org/tx/0xabc", createdAt: "t" } },
    ]);

    const outcome = await settleTransfer(client, request, { workId: "run_1" });

    expect(calls[0]).toContain("/api/execute/transfer");
    expect(outcome.status).toBe("settled");
    expect(outcome.gasEstimate).toBe("21000");
    expect(outcome.transactionHash).toBe("0xabc");
  });

  it("stops before broadcasting when the dry run reverts", async () => {
    const { client, calls } = stub([
      {
        status: 400,
        body: { failureKind: "revert", wouldRevert: true, revertReason: "Error(ERC20: transfer amount exceeds balance)" },
      },
    ]);

    const outcome = await settleTransfer(client, request, { workId: "run_1" });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("exceeds balance");
    // Nothing was broadcast, so no gas was spent finding this out.
    expect(calls).toHaveLength(1);
  });

  it("still broadcasts when the simulator itself is down", async () => {
    // The simulator being unavailable is not a reason to refuse to pay
    // someone we already owe.
    // A dry run never broadcasts, so the client retries it to exhaustion
    // before giving up and broadcasting anyway.
    const { client } = stub([
      ...Array.from({ length: 4 }, () => ({
        status: 503,
        body: { failureKind: "unavailable", wouldRevert: false },
      })),
      { status: 202, body: { executionId: "e1", status: "completed", transactionHash: "0xabc" } },
      { status: 200, body: { executionId: "e1", status: "completed", type: "transfer", network: "84532", transactionHash: "0xabc", createdAt: "t" } },
    ]);

    const outcome = await settleTransfer(client, request, { workId: "run_1" });
    expect(outcome.status).toBe("settled");
  });

  it("can be disabled", async () => {
    const { client, calls } = stub([
      { status: 202, body: { executionId: "e1", status: "completed", transactionHash: "0xabc" } },
    ]);

    await settleTransfer(client, request, { workId: "run_1", preflight: false, confirm: false });
    expect(calls).toHaveLength(1);
  });
});

describe("proof recovery", () => {
  it("recovers a hash the broadcast response withheld", async () => {
    // A `failed`/`unconfirmed` response carries no hash even when a
    // transaction really was broadcast. Reading the stored execution is the
    // only way to find out, and treating "no hash" as "nothing happened" is
    // how an agent double-pays.
    const { client } = stub([
      okSimulation,
      { status: 202, body: { executionId: "e1", status: "unconfirmed" } },
      {
        status: 200,
        body: {
          executionId: "e1",
          status: "completed",
          type: "transfer",
          network: "84532",
          transactionHash: "0xrecovered",
          transactionLink: "https://sepolia.basescan.org/tx/0xrecovered",
          createdAt: "t",
        },
      },
    ]);

    const outcome = await settleTransfer(client, request, { workId: "run_1" });

    expect(outcome.status).toBe("settled");
    expect(outcome.transactionHash).toBe("0xrecovered");
  });

  it("reports a reverted receipt as failed even though a hash exists", async () => {
    const { client } = stub([
      okSimulation,
      { status: 202, body: { executionId: "e1", status: "completed", transactionHash: "0xabc" } },
      {
        status: 200,
        body: {
          executionId: "e1",
          status: "completed",
          type: "transfer",
          network: "84532",
          transactionHash: "0xabc",
          createdAt: "t",
          receipts: [{ hash: "0xabc", chainId: 84532, verified: true, receiptStatus: "reverted", blockNumber: 1, gasUsed: "21000", verifiedAt: "t" }],
        },
      },
    ]);

    const outcome = await settleTransfer(client, request, { workId: "run_1" });
    expect(outcome.status).toBe("failed");
  });

  it("surfaces sponsorship, without which EOA checks conclude nothing happened", async () => {
    const { client } = stub([
      okSimulation,
      { status: 202, body: { executionId: "e1", status: "completed", transactionHash: "0xabc" } },
      {
        status: 200,
        body: { executionId: "e1", status: "completed", type: "transfer", network: "84532", transactionHash: "0xabc", sponsored: true, createdAt: "t" },
      },
    ]);

    const outcome = await settleTransfer(client, request, { workId: "run_1" });
    expect(outcome.sponsored).toBe(true);
  });
});

describe("duplicate handling", () => {
  it("treats an in-flight duplicate as in-progress, not as a failure", async () => {
    // Reporting this as failed invites exactly the retry that double-sends.
    const { client } = stub([
      okSimulation,
      { status: 409, body: { code: "idempotency_in_progress", retryable: true, originalExecutionId: "e1" } },
      { status: 409, body: { code: "idempotency_in_progress", retryable: true, originalExecutionId: "e1" } },
      { status: 409, body: { code: "idempotency_in_progress", retryable: true, originalExecutionId: "e1" } },
      { status: 409, body: { code: "idempotency_in_progress", retryable: true, originalExecutionId: "e1" } },
    ]);

    const outcome = await settleTransfer(client, request, { workId: "run_1" });

    expect(outcome.status).toBe("unconfirmed");
    expect(outcome.replayed).toBe(true);
  });

  it("flags a replayed settlement so the caller knows nothing new was sent", async () => {
    const { client } = stub([
      okSimulation,
      { status: 202, body: { executionId: "e1", status: "completed", transactionHash: "0xabc", idempotentReplay: true } },
      { status: 200, body: { executionId: "e1", status: "completed", type: "transfer", network: "84532", transactionHash: "0xabc", createdAt: "t" } },
    ]);

    const outcome = await settleTransfer(client, request, { workId: "run_1" });
    expect(outcome.replayed).toBe(true);
    expect(outcome.status).toBe("settled");
  });
});

describe("unrecoverable conditions", () => {
  it("throws rather than reporting a settlement outcome for a bad credential", async () => {
    const { client } = stub([
      okSimulation,
      { status: 403, body: { error: "insufficient_scope", required_scope: "mcp:write", granted_scope: "mcp:read" } },
    ]);

    await expect(settleTransfer(client, request, { workId: "run_1" })).rejects.toMatchObject({
      kind: "insufficient_scope",
    });
  });
});
