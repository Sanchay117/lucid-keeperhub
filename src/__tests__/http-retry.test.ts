/**
 * End to end through the real Lucid HTTP stack: `@lucid-agents/core` +
 * `@lucid-agents/http`, invoked with real `Request` objects. Only KeeperHub is
 * stubbed.
 *
 * The scenario is the one that costs money. A buyer's request settles, the
 * seller process restarts (dropping Lucid's in-memory idempotency store), and
 * the buyer retries. Lucid runs the handler again with a brand-new runId. The
 * question is whether KeeperHub sees the retry as the same work.
 */

import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { keeperhub } from "../extension.js";

const RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const BUYER_KEY = "buyer-order-2c1f9d7a-4e11";

type Sent = { url: string; idempotencyKey?: string };

/** A KeeperHub stub that behaves like the real one on idempotency: same key, same outcome. */
function keeperhubStub() {
  const sent: Sent[] = [];
  const executionsByKey = new Map<string, string>();
  let broadcasts = 0;

  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    sent.push({ url: href, idempotencyKey: headers["Idempotency-Key"] });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

    if (href.endsWith("/api/execute/transfer") && body.simulate === true) {
      return json({ success: true, status: "simulated", gasEstimate: "21000", wouldRevert: false });
    }
    if (href.endsWith("/api/execute/transfer")) {
      const key = headers["Idempotency-Key"];
      const existing = key ? executionsByKey.get(key) : undefined;
      if (existing) {
        return json({ executionId: existing, status: "completed", transactionHash: `0x${existing}`, idempotentReplay: true }, 202);
      }
      broadcasts += 1;
      const executionId = `exec${broadcasts}`;
      if (key) executionsByKey.set(key, executionId);
      return json({ executionId, status: "completed", transactionHash: `0x${executionId}` }, 202);
    }
    const status = href.match(/\/api\/execute\/([^/]+)\/status$/);
    if (status) {
      return json({ executionId: status[1], status: "completed", type: "transfer", network: "11155111", transactionHash: `0x${status[1]}`, createdAt: "t" });
    }
    return json({ error: "unexpected" }, 404);
  }) as unknown as typeof globalThis.fetch;

  return { fetch, sent, broadcasts: () => broadcasts };
}

/** Builds a seller. Calling it again is a restart: a fresh runtime and a fresh Lucid idempotency store. */
async function startSeller(fetch: typeof globalThis.fetch, extra: { requireIdempotencyKey?: boolean } = {}) {
  const runtime = await createAgent({ name: "seller", version: "1.0.0" })
    .use(http())
    .use(keeperhub({ apiKey: "kh_test", defaultChainId: 11155111, fetch, sleep: async () => {}, ...extra }))
    .addEntrypoint({
      key: "settle",
      input: z.object({ recipient: z.string(), amount: z.string() }),
      output: z.object({
        status: z.string(),
        transactionHash: z.string().optional(),
        replayed: z.boolean(),
        workIdSource: z.string().optional(),
        error: z.string().optional(),
      }),
      metadata: { keeperhub: { settles: true } },
      handler: async (ctx) => {
        const outcome = await ctx.runtime.keeperhub.settle(
          { chainId: 11155111, recipientAddress: ctx.input.recipient, amount: ctx.input.amount },
          { context: ctx, pollIntervalMs: 0 }
        );
        return {
          output: {
            status: outcome.status,
            transactionHash: outcome.transactionHash,
            replayed: outcome.replayed,
            workIdSource: outcome.workIdSource,
            error: outcome.error,
          },
        };
      },
    })
    .build();

  const invoke = async (headers: Record<string, string> = {}) => {
    const res = await runtime.http.handlers.invoke(
      new Request("http://seller.local/entrypoints/settle/invoke", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ input: { recipient: RECIPIENT, amount: "0.0001" } }),
      }),
      { key: "settle" }
    );
    return { res, body: (await res.json()) as { run_id: string; output: Record<string, unknown> } };
  };

  return { runtime, invoke };
}

describe("buyer retries through @lucid-agents/http", () => {
  it("anchors the KeeperHub key to the buyer's Idempotency-Key", async () => {
    const kh = keeperhubStub();
    const seller = await startSeller(kh.fetch);

    const { body } = await seller.invoke({ "Idempotency-Key": BUYER_KEY });

    expect(body.output.status).toBe("settled");
    expect(body.output.workIdSource).toBe("idempotency-key");
    await seller.runtime.close();
  });

  it("does not re-run the handler when Lucid still remembers the key", async () => {
    const kh = keeperhubStub();
    const seller = await startSeller(kh.fetch);

    const first = await seller.invoke({ "Idempotency-Key": BUYER_KEY });
    const retry = await seller.invoke({ "Idempotency-Key": BUYER_KEY });

    expect(retry.res.headers.get("Idempotency-Replayed")).toBe("true");
    expect(retry.body.output.transactionHash).toBe(first.body.output.transactionHash);
    expect(kh.broadcasts()).toBe(1);
    await seller.runtime.close();
  });

  it("still sends one transfer when the seller restarts between the request and the retry", async () => {
    const kh = keeperhubStub();

    const before = await startSeller(kh.fetch);
    const first = await before.invoke({ "Idempotency-Key": BUYER_KEY });
    await before.runtime.close();

    // Restart: new runtime, empty Lucid idempotency store.
    const after = await startSeller(kh.fetch);
    const retry = await after.invoke({ "Idempotency-Key": BUYER_KEY });

    // Lucid had forgotten, so the handler really did run again, with a new runId...
    expect(retry.res.headers.get("Idempotency-Replayed")).toBeNull();
    expect(retry.body.run_id).not.toBe(first.body.run_id);

    // ...and KeeperHub still recognised it as the same work.
    const keys = kh.sent.filter((s) => s.url.endsWith("/api/execute/transfer") && s.idempotencyKey).map((s) => s.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(retry.body.output.replayed).toBe(true);
    expect(retry.body.output.transactionHash).toBe(first.body.output.transactionHash);
    expect(kh.broadcasts()).toBe(1);
    await after.runtime.close();
  });

  it("would have sent two transfers if the key were anchored to runId", async () => {
    // The control: the same restart without an Idempotency-Key header falls back
    // to runId, and a new runId is new work. This is why runId is not enough.
    const kh = keeperhubStub();

    const before = await startSeller(kh.fetch);
    await before.invoke();
    await before.runtime.close();

    const after = await startSeller(kh.fetch);
    const retry = await after.invoke();

    expect(retry.body.output.workIdSource).toBe("run-id");
    expect(kh.broadcasts()).toBe(2);
    await after.runtime.close();
  });

  it("refuses to settle without a key when the seller requires one", async () => {
    const kh = keeperhubStub();
    const seller = await startSeller(kh.fetch, { requireIdempotencyKey: true });

    const { body } = await seller.invoke();

    expect(body.output.status).toBe("failed");
    expect(body.output.error).toMatch(/Idempotency-Key header required/);
    expect(kh.broadcasts()).toBe(0);
    expect(kh.sent).toHaveLength(0);
    await seller.runtime.close();
  });
});
