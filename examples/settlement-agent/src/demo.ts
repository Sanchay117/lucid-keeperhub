/**
 * Demo console routes, mounted beside the agent at /demo.
 *
 * The console is a buyer's view of the seller. Every settle and quote it runs
 * goes through the agent's real Lucid HTTP entrypoints from the browser; these
 * routes only add what a buyer cannot reach on its own: a restart switch, the
 * KeeperHub execution record, and onchain balances as independent evidence of
 * how many transfers actually happened.
 */

import { readFileSync } from "node:fs";

import type { Hex } from "@lucid-agents/payments";

import { buyPayout } from "./buyer.ts";
import { CHAIN_ID, PAYOUT_PRICE, type Seller } from "./seller.ts";

/** USDC on Base Sepolia, the asset buyers pay in over x402. */
const PAYMENT_RPC = "https://sepolia.base.org";
const PAYMENT_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYMENT_EXPLORER = "https://base-sepolia.blockscout.com";

const CHAINS: Record<number, { name: string; rpc: string; explorer: string }> = {
  11155111: {
    name: "Ethereum Sepolia",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
  84532: {
    name: "Base Sepolia",
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
};

const html = readFileSync(new URL("./demo.html", import.meta.url), "utf8");

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function nativeBalance(rpc: string, address: string): Promise<string | null> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
    });
    const body = (await res.json()) as { result?: string };
    return body.result ? BigInt(body.result).toString() : null;
  } catch {
    return null;
  }
}

async function usdcBalance(address: string): Promise<string | null> {
  try {
    const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
    const res = await fetch(PAYMENT_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: PAYMENT_USDC, data }, "latest"] }),
    });
    const body = (await res.json()) as { result?: string };
    return body.result && body.result !== "0x" ? BigInt(body.result).toString() : null;
  } catch {
    return null;
  }
}

export function createDemo(options: {
  getSeller: () => Seller;
  restart: () => Promise<void>;
  sellerUrl: string;
}) {
  const chain = CHAINS[CHAIN_ID];
  let sender: string | undefined;
  let restarts = 0;

  return async function demo(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/demo";

    if (path === "/demo" && req.method === "GET") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (path === "/demo/api/info" && req.method === "GET") {
      const recipient = process.env.DEMO_RECIPIENT ?? "";
      if (!sender && /^0x[0-9a-fA-F]{40}$/.test(recipient)) {
        // A dry run is the one call that names the org wallet without moving
        // anything or writing an execution row.
        const quote = await options
          .getSeller()
          .runtime.keeperhub.simulate({ chainId: CHAIN_ID, recipientAddress: recipient, amount: "0" })
          .catch(() => undefined);
        sender = quote?.from;
      }
      const card = options.getSeller().runtime.manifest.build(url.origin);
      return json({
        chainId: CHAIN_ID,
        chainName: chain?.name ?? `chain ${CHAIN_ID}`,
        explorer: chain?.explorer,
        sender,
        recipient,
        amount: process.env.DEMO_AMOUNT ?? "0.0001",
        restarts,
        paymentsEnabled: options.getSeller().paymentsEnabled,
        buyer: process.env.BUYER_ADDRESS,
        payTo: process.env.PAYMENTS_RECEIVABLE_ADDRESS,
        payoutPrice: PAYOUT_PRICE,
        paymentExplorer: PAYMENT_EXPLORER,
        capability: card.capabilities?.extensions ?? [],
      });
    }

    if (path === "/demo/api/restart" && req.method === "POST") {
      await options.restart();
      restarts += 1;
      return json({ restarted: true, restarts });
    }

    const execution = path.match(/^\/demo\/api\/execution\/([A-Za-z0-9_-]+)$/);
    if (execution && req.method === "GET") {
      try {
        return json(await options.getSeller().runtime.keeperhub.status(execution[1]!));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
    }

    if (path === "/demo/api/balances" && req.method === "GET") {
      const addresses = (url.searchParams.get("addresses") ?? "")
        .split(",")
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
      if (!chain) return json({ balances: {} });
      const entries = await Promise.all(
        addresses.map(async (a) => [a.toLowerCase(), await nativeBalance(chain.rpc, a)] as const)
      );
      const usdc = await Promise.all(
        addresses.map(async (a) => [a.toLowerCase(), await usdcBalance(a)] as const)
      );
      return json({ balances: Object.fromEntries(entries), usdc: Object.fromEntries(usdc) });
    }

    if (path === "/demo/api/buy" && req.method === "POST") {
      const privateKey = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
      if (!privateKey || !options.getSeller().paymentsEnabled) {
        return json({ error: "x402 is not configured: set BUYER_PRIVATE_KEY and PAYMENTS_* in .env" }, 400);
      }
      const input = (await req.json().catch(() => ({}))) as Record<string, string>;

      // Checked here because Lucid reports a buyer's insufficient USDC as a
      // 503 "verification temporarily unavailable" rather than a 402, which
      // reads like an outage when it is an empty wallet.
      const buyer = process.env.BUYER_ADDRESS;
      const needed = BigInt(Math.round(Number(PAYOUT_PRICE) * 1_000_000));
      const held = buyer ? await usdcBalance(buyer) : null;
      if (held !== null && BigInt(held) < needed) {
        return json(
          {
            error: `Buyer wallet ${buyer} holds ${Number(held) / 1e6} USDC on Base Sepolia and needs ${PAYOUT_PRICE}. Fund it at faucet.circle.com.`,
          },
          400
        );
      }

      try {
        const result = await buyPayout({
          sellerUrl: options.sellerUrl,
          privateKey,
          recipient: input.recipient ?? "",
          amount: input.amount ?? "",
          idempotencyKey: input.idempotencyKey ?? "",
        });
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
    }

    return json({ error: "not found" }, 404);
  };
}
