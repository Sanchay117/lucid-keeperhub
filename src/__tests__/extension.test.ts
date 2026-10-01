/**
 * These tests run against the real `@lucid-agents/core` runtime rather than a
 * stand-in. That is the point: the extension contract (slice conflicts,
 * ordering, entrypoint hooks, manifest composition) is enforced by Lucid's own
 * builder, so a mock would prove nothing about whether this actually installs.
 */

import { createAgent } from "@lucid-agents/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { keeperhub, KEEPERHUB_EXTENSION_URI } from "../extension.js";
import { KeeperHubSettlementError } from "../settle.js";

const meta = { name: "settlement-agent", version: "1.0.0", description: "test" };

function fetchStub(responses: Array<{ status: number; body: unknown }>) {
  return vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

const options = (fetch: typeof globalThis.fetch) => ({
  apiKey: "kh_test",
  defaultChainId: 84532,
  fetch,
  sleep: async () => {},
});

describe("installation", () => {
  it("installs into a real Lucid runtime and contributes its slice", async () => {
    const runtime = await createAgent(meta)
      .use(keeperhub(options(fetchStub([]))))
      .build();

    expect(runtime.keeperhub).toBeDefined();
    expect(typeof runtime.keeperhub.settle).toBe("function");
    await runtime.close();
  });

  it("refuses to build without an API key", async () => {
    const previous = process.env.KEEPERHUB_API_KEY;
    delete process.env.KEEPERHUB_API_KEY;
    try {
      await expect(
        createAgent(meta).use(keeperhub({ defaultChainId: 84532 })).build()
      ).rejects.toThrow(/KEEPERHUB_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.KEEPERHUB_API_KEY = previous;
    }
  });

  it("reads the API key from the environment", async () => {
    process.env.KEEPERHUB_API_KEY = "kh_from_env";
    try {
      const runtime = await createAgent(meta)
        .use(keeperhub({ defaultChainId: 84532, fetch: fetchStub([]) }))
        .build();
      expect(runtime.keeperhub.client).toBeDefined();
      await runtime.close();
    } finally {
      delete process.env.KEEPERHUB_API_KEY;
    }
  });
});

describe("entrypoint validation", () => {
  it("tracks entrypoints that declare settlement", async () => {
    const runtime = await createAgent(meta)
      .use(keeperhub(options(fetchStub([]))))
      .addEntrypoint({
        key: "payout",
        input: z.object({ to: z.string() }),
        metadata: { keeperhub: { settles: true } },
        handler: async () => ({ output: {} }),
      })
      .addEntrypoint({
        key: "quote",
        input: z.object({ of: z.string() }),
        handler: async () => ({ output: {} }),
      })
      .build();

    expect(runtime.keeperhub.settlingEntrypoints()).toEqual(["payout"]);
    await runtime.close();
  });

  it("rejects a settling entrypoint that names no chain, at build time", async () => {
    // Discovering this at the first paid invocation is the expensive version:
    // the buyer has already been charged.
    await expect(
      createAgent(meta)
        .use(keeperhub({ apiKey: "kh_test", fetch: fetchStub([]) }))
        .addEntrypoint({
          key: "payout",
          metadata: { keeperhub: { settles: true } },
          handler: async () => ({ output: {} }),
        })
        .build()
    ).rejects.toThrow(/declares KeeperHub settlement but no chain/);
  });

  it("accepts a per-entrypoint chain without a global default", async () => {
    const runtime = await createAgent(meta)
      .use(keeperhub({ apiKey: "kh_test", fetch: fetchStub([]) }))
      .addEntrypoint({
        key: "payout",
        metadata: { keeperhub: { settles: true, chainId: 8453 } },
        handler: async () => ({ output: {} }),
      })
      .build();

    expect(runtime.keeperhub.settlingEntrypoints()).toEqual(["payout"]);
    await runtime.close();
  });
});

describe("discovery", () => {
  it("advertises settlement in the agent card so buyers can find it", async () => {
    const runtime = await createAgent(meta)
      .use(keeperhub(options(fetchStub([]))))
      .addEntrypoint({
        key: "payout",
        metadata: { keeperhub: { settles: true } },
        handler: async () => ({ output: {} }),
      })
      .build();

    const card = runtime.manifest.build("https://agent.example");
    const advertised = card.capabilities?.extensions?.find(
      (e) => (e as { uri?: string }).uri === KEEPERHUB_EXTENSION_URI
    ) as { params?: Record<string, unknown> } | undefined;

    expect(advertised).toBeDefined();
    expect(advertised?.params?.settlingEntrypoints).toEqual(["payout"]);
    expect(advertised?.params?.auditTrail).toBe(true);
    expect(advertised?.params?.defaultChainId).toBe("84532");
    await runtime.close();
  });

  it("says nothing when no entrypoint settles", async () => {
    const runtime = await createAgent(meta)
      .use(keeperhub(options(fetchStub([]))))
      .addEntrypoint({ key: "quote", handler: async () => ({ output: {} }) })
      .build();

    const card = runtime.manifest.build("https://agent.example");
    const advertised = card.capabilities?.extensions?.find(
      (e) => (e as { uri?: string }).uri === KEEPERHUB_EXTENSION_URI
    );
    expect(advertised).toBeUndefined();
    await runtime.close();
  });

  it("can be silenced", async () => {
    const runtime = await createAgent(meta)
      .use(keeperhub({ ...options(fetchStub([])), advertise: false }))
      .addEntrypoint({
        key: "payout",
        metadata: { keeperhub: { settles: true } },
        handler: async () => ({ output: {} }),
      })
      .build();

    const card = runtime.manifest.build("https://agent.example");
    const advertised = card.capabilities?.extensions?.find(
      (e) => (e as { uri?: string }).uri === KEEPERHUB_EXTENSION_URI
    );
    expect(advertised).toBeUndefined();
    await runtime.close();
  });
});

describe("settlement from inside a handler", () => {
  it("settles using the invocation runId as the idempotency anchor", async () => {
    const fetch = fetchStub([
      { status: 200, body: { success: true, status: "simulated", gasEstimate: "21000", wouldRevert: false } },
      { status: 202, body: { executionId: "e1", status: "completed", transactionHash: "0xabc" } },
      {
        status: 200,
        body: {
          executionId: "e1",
          status: "completed",
          type: "transfer",
          network: "84532",
          transactionHash: "0xabc",
          transactionLink: "https://sepolia.basescan.org/tx/0xabc",
          createdAt: "t",
        },
      },
    ]);

    const runtime = await createAgent(meta)
      .use(keeperhub(options(fetch)))
      .build();

    const outcome = await runtime.keeperhub.settle(
      { chainId: 84532, recipientAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", amount: "0.01" },
      { workId: "run_abc" }
    );

    expect(outcome.status).toBe("settled");
    expect(outcome.transactionHash).toBe("0xabc");
    expect(outcome.transactionLink).toContain("basescan");
    await runtime.close();
  });

  it("applies defaultChainId when a call omits the chain", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(init?.body as string);
      return new Response(
        JSON.stringify({ success: true, status: "simulated", gasEstimate: "21000" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof globalThis.fetch;

    const runtime = await createAgent(meta).use(keeperhub(options(fetch))).build();

    await runtime.keeperhub.simulate({
      recipientAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      amount: "0.01",
    } as never);

    expect(JSON.parse(calls[0]!).chainId).toBe("84532");
    await runtime.close();
  });

  it("throws when no value was transferred, so a priced entrypoint charges nothing", async () => {
    const fetch = fetchStub([
      { status: 400, body: { code: "insufficient_balance", error: "Insufficient balance" } },
    ]);
    const runtime = await createAgent(meta).use(keeperhub(options(fetch))).build();

    const settling = runtime.keeperhub.settle(
      { chainId: 84532, recipientAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", amount: "1000" },
      { workId: "run_abc" }
    );

    await expect(settling).rejects.toBeInstanceOf(KeeperHubSettlementError);
    await expect(settling).rejects.toMatchObject({ outcome: { status: "failed" } });
    await runtime.close();
  });

  it("resolves an unconfirmed settlement rather than throwing, since value may be moving", async () => {
    const gatewayError = { status: 502, body: { error: "Bad gateway" } };
    const fetch = fetchStub([
      { status: 200, body: { success: true, status: "simulated", gasEstimate: "21000", wouldRevert: false } },
      gatewayError,
      gatewayError,
      gatewayError,
      gatewayError,
    ]);
    const runtime = await createAgent(meta).use(keeperhub(options(fetch))).build();

    const outcome = await runtime.keeperhub.settle(
      { chainId: 84532, recipientAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", amount: "0.01" },
      { workId: "run_abc" }
    );

    expect(outcome.status).toBe("unconfirmed");
    await runtime.close();
  });

  it("reports a dry-run revert without throwing", async () => {
    const fetch = fetchStub([
      { status: 400, body: { failureKind: "revert", wouldRevert: true, revertReason: "Error(nope)" } },
    ]);

    const runtime = await createAgent(meta).use(keeperhub(options(fetch))).build();

    const result = await runtime.keeperhub.simulate({
      chainId: 84532,
      recipientAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      amount: "0.01",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("nope");
    await runtime.close();
  });
});
