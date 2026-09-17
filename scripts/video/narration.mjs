/**
 * Voiceover for the demo video, synthesized with Deepgram Flux TTS through
 * OpenRouter's speech endpoint. Clips are cached by content hash, so editing
 * one line only re-synthesizes that line.
 *
 * Spelling here is for the ear, not the eye: "x402" is written the way it is
 * said, and identifiers are spelled as words.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

export const VOICE = process.env.TTS_VOICE ?? "flux-sienna-en";
const MODEL = "deepgram/flux-tts:free";

export const LINES = {
  title: "This is lucid keeperhub: deterministic onchain settlement for Lucid Agents, executed through KeeperHub.",
  gap: "Lucid Agents, from Daydreams, handles the sale: schemas, payments, and idempotency. By design, it keeps wallets and networks external. So an agent that owes an onchain payout ends up hand-rolling a signer, with the key in memory, no dry run, and no audit trail. And when a buyer retries a timed-out request, it pays twice.",
  integration: "lucid keeperhub is a Lucid extension. Install it, and a paid entrypoint settles with one call, passing its request context. KeeperHub dry-runs, broadcasts, and confirms the transfer, and the buyer gets a transaction hash back.",
  intro: "This is a live Lucid agent that sells payouts. Every button calls its real HTTP entrypoints, on Base Sepolia and Ethereum Sepolia.",
  card: "Buyers discover the capability in the agent card, before they call anything.",
  buy: "First, another agent buys a payout. Lucid answers with an x four-oh-two challenge: one cent in USDC, payable to the seller's KeeperHub wallet. The buyer signs, the facilitator settles the payment, and only then does the handler run.",
  buyDone: "Lucid admitted the payment, and KeeperHub executed the payout. USDC came in on Base Sepolia, and ETH went out on Sepolia, with KeeperHub's execution record: a verified receipt, and sponsored gas.",
  settle: "Now, the unhappy paths. A settle request with an idempotency key. KeeperHub dry-runs it, broadcasts one transfer, and waits for the receipt.",
  settleDone: "One transfer, confirmed.",
  retry: "The buyer retries with the same key. Lucid replays its stored response, and the handler never runs.",
  restart: "Now we restart the seller. Lucid's idempotency store lives in memory, so it's gone, and the retry runs the handler again, with a brand new run ID.",
  restartDone: "But KeeperHub matched the buyer's key to the original transfer, and returned it. No second transaction. This is the bug we found while building the integration: Lucid mints a new run ID for every request, so settlement is anchored to the buyer's key instead.",
  nokey: "A request with no idempotency key can't be made safe to retry, so the seller refuses to send it.",
  overdraw: "And an overdraw. KeeperHub's dry run catches it before anything is broadcast. No transaction, and no gas.",
  summary: "Six requests. One paid purchase and one settle, each executed exactly once.",
  paymentTx: "On a public explorer, here is the value coming in: one cent of USDC, from the buyer agent to the seller's KeeperHub wallet, on Base Sepolia.",
  payoutTx: "And the value going out: the payout KeeperHub executed on Sepolia, from the KeeperHub wallet to the recipient, with the gas paid by a relayer.",
  built: "Under the hood: a typed Lucid extension, two layers of idempotency, a retry policy that can't double-send, and eighty-eight tests against Lucid's real runtimes, including restart and retry, and no settlement before payment.",
  close: "Lucid Agents sells the work. KeeperHub moves the money, once.",
};

function durationMs(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  return Math.round(Number(String(out).trim()) * 1000);
}

/** Synthesizes every line (or reuses the cached clip) and returns file and duration per line. */
export async function synthesize(dir) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  mkdirSync(dir, { recursive: true });

  const clips = {};
  for (const [id, text] of Object.entries(LINES)) {
    const hash = createHash("sha256").update(`${MODEL}|${VOICE}|${text}`).digest("hex").slice(0, 12);
    const file = `${dir}/${id}-${hash}.mp3`;
    if (!existsSync(file)) {
      let lastError;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const res = await fetch("https://openrouter.ai/api/v1/audio/speech", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL, input: text, voice: VOICE, response_format: "mp3" }),
        });
        if (res.ok) {
          writeFileSync(file, Buffer.from(await res.arrayBuffer()));
          lastError = undefined;
          break;
        }
        lastError = `${res.status} ${(await res.text()).slice(0, 200)}`;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      if (lastError) throw new Error(`TTS failed for "${id}": ${lastError}`);
    }
    clips[id] = { file, ms: durationMs(file) };
  }
  return clips;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const clips = await synthesize(new URL("./out/tts", import.meta.url).pathname);
  let total = 0;
  for (const [id, { ms }] of Object.entries(clips)) {
    total += ms;
    console.log(`${id.padEnd(12)} ${(ms / 1000).toFixed(1)}s`);
  }
  console.log(`total narration ${(total / 1000).toFixed(1)}s`);
}
