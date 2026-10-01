/**
 * Runs the settlement agent and its demo console.
 *
 *   KEEPERHUB_API_KEY=kh_... node --experimental-strip-types src/index.ts
 *
 * Agent:   http://localhost:8787/.well-known/agent-card.json
 * Console: http://localhost:8787/demo
 */

import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";

import { createDemo } from "./demo.ts";
import { createFileIdempotencyStore } from "./idempotency-store.ts";
import { buildSeller, CHAIN_ID } from "./seller.ts";

const PORT = Number(process.env.PORT ?? 8787);

// On disk, so a real restart keeps Lucid's record of paid requests and a
// buyer's retry is replayed instead of charged again.
const idempotencyStore = createFileIdempotencyStore(
  fileURLToPath(new URL("../.data/idempotency.json", import.meta.url))
);

let seller = await buildSeller({ idempotencyStore });

const demo = createDemo({
  getSeller: () => seller,
  // The buyer reaches the seller over real HTTP, as a separate agent would.
  sellerUrl: `http://localhost:${PORT}`,
  // The worst case on purpose: a new runtime that lost Lucid's idempotency
  // store too, so only KeeperHub can stop a second transfer. A real restart
  // keeps the file. Swapped before the old one is closed so no request lands
  // on a closed runtime.
  restart: async () => {
    const previous = seller;
    idempotencyStore.wipe();
    seller = await buildSeller({ idempotencyStore });
    await previous.runtime.close();
    console.log("[settlement-agent] restarted with Lucid's idempotency store wiped");
  },
});

serve({
  port: PORT,
  fetch: (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/demo" || pathname.startsWith("/demo/")) return demo(req);
    return seller.app.fetch(req);
  },
});

console.log(`[settlement-agent] x402 payments ${seller.paymentsEnabled ? "enabled" : "not configured; entrypoints are free"}`);
console.log(`[settlement-agent] settling on chain ${CHAIN_ID}`);
console.log(`[settlement-agent] agent card  http://localhost:${PORT}/.well-known/agent-card.json`);
console.log(`[settlement-agent] demo console http://localhost:${PORT}/demo`);
