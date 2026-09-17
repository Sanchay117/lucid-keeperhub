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

import { CHAIN_ID, type Seller } from "./seller.ts";

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

export function createDemo(options: {
  getSeller: () => Seller;
  restart: () => Promise<void>;
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
      return json({ balances: Object.fromEntries(entries) });
    }

    return json({ error: "not found" }, 404);
  };
}
