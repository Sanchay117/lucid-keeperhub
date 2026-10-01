/**
 * Settlement must never run before payment admission, and the buyer must be
 * charged only for a payout that happened, once.
 *
 * Through the real `@lucid-agents/payments` x402 extension: a priced
 * entrypoint that settles through KeeperHub is called without a payment, with
 * a payment the facilitator rejects, and with payments the facilitator
 * accepts. Only the facilitator and KeeperHub are stubbed, so "charged" here
 * means Lucid asked the facilitator to settle the buyer's USDC authorization.
 */

import { createAgent } from "@lucid-agents/core";
import { createInMemoryHttpIdempotencyStore, http } from "@lucid-agents/http";
import { payments } from "@lucid-agents/payments";
import type { HttpIdempotencyStore } from "@lucid-agents/types/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { keeperhub } from "../extension.js";

const FACILITATOR = "https://facilitator.test";
const PAY_TO = "0xFAd73E872d13Dc05f4ECdec4880e9Dd8Be8F2396";
const BUYER = "0x9535a33d8E46DAAC768F8FCc88c2cC9B764A769e";
const BUYER_KEY = "order-ordering-test-000000001";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** A facilitator that supports exact payments on Base Sepolia and verifies (or rejects) every payment. */
function stubFacilitator(accept = false) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const href = String(url instanceof Request ? url.url : url);
      calls.push(href);
      if (href.startsWith(`${FACILITATOR}/supported`)) {
        return json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
      }
      if (href.startsWith(`${FACILITATOR}/verify`)) {
        return accept
          ? json({ isValid: true, payer: BUYER })
          : json({ isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" });
      }
      if (href.startsWith(`${FACILITATOR}/settle`)) {
        return json({ success: true, payer: BUYER, transaction: `0x${"ab".repeat(32)}`, network: "eip155:84532" });
      }
      return json({ error: "unexpected" }, 404);
    })
  );
  return { calls, charges: () => calls.filter((href) => href.startsWith(`${FACILITATOR}/settle`)).length };
}

/** A signed USDC authorization; each nonce is a separate payment. */
function paymentSignature(nonceByte = "00") {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: { scheme: "exact", network: "eip155:84532", amount: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } },
      payload: { signature: "0x00", authorization: { from: BUYER, to: PAY_TO, value: "10000", validAfter: "0", validBefore: "9999999999", nonce: `0x${nonceByte.repeat(32)}` } },
    })
  ).toString("base64");
}

/** KeeperHub, deduplicating on the Idempotency-Key the way the real API does. */
function keeperhubStub(outcome: "completed" | "insufficient_balance" = "completed") {
  const calls: string[] = [];
  const executionsByKey = new Map<string, string>();
  let broadcasts = 0;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    if (outcome === "insufficient_balance") {
      return json({ code: "insufficient_balance", error: "Insufficient balance" }, 400);
    }
    if (href.endsWith("/api/execute/transfer") && body.simulate === true) {
      return json({ success: true, status: "simulated", gasEstimate: "21000", wouldRevert: false });
    }
    if (href.endsWith("/api/execute/transfer")) {
      const key = headers["Idempotency-Key"];
      const existing = key ? executionsByKey.get(key) : undefined;
      if (existing) return json({ executionId: existing, status: "completed", transactionHash: `0x${existing}`, idempotentReplay: true }, 202);
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
  return { fetch, calls, broadcasts: () => broadcasts };
}

async function startSeller(
  kh = keeperhubStub(),
  store?: HttpIdempotencyStore
) {
  const handler = vi.fn(async (ctx: any) => {
    const outcome = await ctx.runtime.keeperhub.settle(
      { chainId: 11155111, recipientAddress: ctx.input.recipient, amount: ctx.input.amount },
      { context: ctx, pollIntervalMs: 0 }
    );
    return { output: { status: outcome.status } };
  });

  const runtime = await createAgent({ name: "seller", version: "1.0.0" })
    .use(http(store ? { idempotency: { store } } : undefined))
    // Installed before payments on purpose: the extension's own ordering has
    // to put settlement after payment admission.
    .use(keeperhub({ apiKey: "kh_test", defaultChainId: 11155111, fetch: kh.fetch, sleep: async () => {} }))
    .use(payments({ config: { facilitatorUrl: FACILITATOR, network: "eip155:84532", payTo: PAY_TO } as never }))
    .addEntrypoint({
      key: "payout",
      input: z.object({ recipient: z.string(), amount: z.string() }),
      output: z.object({ status: z.string() }),
      price: "0.01",
      paymentProtocol: "x402",
      metadata: { keeperhub: { settles: true } },
      handler,
    })
    .build();

  const invoke = (headers: Record<string, string> = {}) =>
    runtime.http.handlers.invoke(
      new Request("http://seller.local/entrypoints/payout/invoke", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": BUYER_KEY, ...headers },
        body: JSON.stringify({ input: { recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", amount: "0.0001" } }),
      }),
      { key: "payout" }
    );

  return { runtime, invoke, handler, keeperhubCalls: kh.calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("x402 payment admission before KeeperHub settlement", () => {
  it("answers an unpaid request with a 402 challenge and never settles", async () => {
    stubFacilitator();
    const seller = await startSeller();

    const res = await seller.invoke();

    expect(res.status).toBe(402);
    const challenge = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString());
    expect(challenge.accepts[0]).toMatchObject({ network: "eip155:84532", amount: "10000", payTo: PAY_TO });
    expect(seller.handler).not.toHaveBeenCalled();
    expect(seller.keeperhubCalls).toHaveLength(0);
    await seller.runtime.close();
  });

  it("never settles when the facilitator rejects the payment", async () => {
    stubFacilitator();
    const seller = await startSeller();

    const res = await seller.invoke({ "PAYMENT-SIGNATURE": paymentSignature() });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(seller.handler).not.toHaveBeenCalled();
    expect(seller.keeperhubCalls).toHaveLength(0);
    await seller.runtime.close();
  });

  it("orders the keeperhub extension after payments regardless of install order", async () => {
    stubFacilitator();
    const seller = await startSeller();
    // If settlement could run first, the unpaid request above would have
    // reached the handler. This asserts the declared constraint directly.
    const ext = keeperhub({ apiKey: "kh_test" });
    expect(ext.after).toContain("payments");
    await seller.runtime.close();
  });
});

describe("charging the buyer", () => {
  it("charges once for a payout that settled", async () => {
    const facilitator = stubFacilitator(true);
    const seller = await startSeller();

    const res = await seller.invoke({ "PAYMENT-SIGNATURE": paymentSignature("01") });

    expect(res.status).toBe(200);
    expect(facilitator.charges()).toBe(1);
    await seller.runtime.close();
  });

  it("does not charge for a payout that failed", async () => {
    const facilitator = stubFacilitator(true);
    const seller = await startSeller(keeperhubStub("insufficient_balance"));

    const res = await seller.invoke({ "PAYMENT-SIGNATURE": paymentSignature("01") });

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/no value was transferred/);
    expect(facilitator.charges()).toBe(0);
    await seller.runtime.close();
  });

  it("does not charge a paid retry after a restart when the idempotency store survives it", async () => {
    // One store shared by both runtimes stands in for a durable store. Its
    // `close` is left out because the in-memory one clears itself on close,
    // which a store on disk or in a database does not.
    const facilitator = stubFacilitator(true);
    const kh = keeperhubStub();
    const { claim, complete, release } = createInMemoryHttpIdempotencyStore();
    const store: HttpIdempotencyStore = { claim, complete, release };

    const before = await startSeller(kh, store);
    await before.invoke({ "PAYMENT-SIGNATURE": paymentSignature("01") });
    await before.runtime.close();

    // The buyer's x402 client signs a fresh authorization for the retry.
    const after = await startSeller(kh, store);
    const retry = await after.invoke({ "PAYMENT-SIGNATURE": paymentSignature("02") });

    expect(retry.headers.get("Idempotency-Replayed")).toBe("true");
    expect(after.handler).not.toHaveBeenCalled();
    expect(kh.broadcasts()).toBe(1);
    expect(facilitator.charges()).toBe(1);
    await after.runtime.close();
  });

  it("charges a paid retry again when the store does not survive, though KeeperHub still sends once", async () => {
    // The control, and the reason a paid deployment needs a durable store.
    const facilitator = stubFacilitator(true);
    const kh = keeperhubStub();

    const before = await startSeller(kh);
    await before.invoke({ "PAYMENT-SIGNATURE": paymentSignature("01") });
    await before.runtime.close();

    const after = await startSeller(kh);
    await after.invoke({ "PAYMENT-SIGNATURE": paymentSignature("02") });

    expect(kh.broadcasts()).toBe(1);
    expect(facilitator.charges()).toBe(2);
    await after.runtime.close();
  });
});
