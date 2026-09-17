/**
 * Settlement must never run before payment admission.
 *
 * Through the real `@lucid-agents/payments` x402 extension: a priced
 * entrypoint that settles through KeeperHub is called without a payment, and
 * with a payment the facilitator rejects. In both cases the seller must answer
 * without the handler running, so KeeperHub is never asked to move anything.
 * Only the facilitator and KeeperHub are stubbed.
 */

import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments } from "@lucid-agents/payments";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { keeperhub } from "../extension.js";

const FACILITATOR = "https://facilitator.test";
const PAY_TO = "0xFAd73E872d13Dc05f4ECdec4880e9Dd8Be8F2396";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** A facilitator that supports exact payments on Base Sepolia and rejects every payment. */
function stubFacilitator() {
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
        return json({ isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" });
      }
      return json({ error: "unexpected" }, 404);
    })
  );
  return calls;
}

async function startSeller() {
  const keeperhubCalls: string[] = [];
  const keeperhubFetch = vi.fn(async (url: string | URL | Request) => {
    keeperhubCalls.push(String(url));
    return json({ executionId: "exec1", status: "completed", transactionHash: "0xabc" }, 202);
  }) as unknown as typeof globalThis.fetch;

  const handler = vi.fn(async (ctx: any) => {
    const outcome = await ctx.runtime.keeperhub.settle(
      { chainId: 11155111, recipientAddress: ctx.input.recipient, amount: ctx.input.amount },
      { context: ctx, pollIntervalMs: 0 }
    );
    return { output: { status: outcome.status } };
  });

  const runtime = await createAgent({ name: "seller", version: "1.0.0" })
    .use(http())
    // Installed before payments on purpose: the extension's own ordering has
    // to put settlement after payment admission.
    .use(keeperhub({ apiKey: "kh_test", defaultChainId: 11155111, fetch: keeperhubFetch, sleep: async () => {} }))
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
        headers: { "content-type": "application/json", "Idempotency-Key": "order-ordering-test-000000001", ...headers },
        body: JSON.stringify({ input: { recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", amount: "0.0001" } }),
      }),
      { key: "payout" }
    );

  return { runtime, invoke, handler, keeperhubCalls };
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

    const res = await seller.invoke({
      "PAYMENT-SIGNATURE": Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepted: { scheme: "exact", network: "eip155:84532", amount: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } },
          payload: { signature: "0x00", authorization: { from: "0x9535a33d8E46DAAC768F8FCc88c2cC9B764A769e", to: PAY_TO, value: "10000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` } },
        })
      ).toString("base64"),
    });

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
