/**
 * Runs the settlement agent and its demo console.
 *
 *   KEEPERHUB_API_KEY=kh_... node --experimental-strip-types src/index.ts
 *
 * Agent:   http://localhost:8787/.well-known/agent-card.json
 * Console: http://localhost:8787/demo
 */

import { serve } from "@hono/node-server";

import { createDemo } from "./demo.ts";
import { buildSeller, CHAIN_ID } from "./seller.ts";

const PORT = Number(process.env.PORT ?? 8787);

let seller = await buildSeller();

const demo = createDemo({
  getSeller: () => seller,
  // A restart in the sense that matters here: a new runtime, and with it an
  // empty Lucid idempotency store. Swapped before the old one is closed so no
  // request lands on a closed runtime.
  restart: async () => {
    const previous = seller;
    seller = await buildSeller();
    await previous.runtime.close();
    console.log("[settlement-agent] restarted: Lucid idempotency store is now empty");
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
