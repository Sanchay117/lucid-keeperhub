/**
 * Records the narrated submission demo video against the live agent.
 *
 *   1. Start the agent:  (examples/settlement-agent) node --experimental-strip-types src/index.ts
 *   2. Record:           node scripts/video/record.mjs   (needs OPENROUTER_API_KEY for the voice)
 *
 * Every purchase and settle in the recording is a real request to the agent's
 * Lucid entrypoints, a real x402 payment on Base Sepolia and a real KeeperHub
 * execution on Sepolia. Nothing is mocked or replayed from a fixture.
 *
 * Voice and picture are kept in sync by construction: each scene starts its
 * narration line, and the next line cannot start until the previous one has
 * finished. The time each line started is recorded and used to place it on the
 * audio track, so no manual alignment is needed.
 *
 * Output: scripts/video/out/lucid-keeperhub-demo.mp4 and docs/console.png.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";

import { LINES, synthesize } from "./narration.mjs";

const BASE = process.env.CONSOLE_URL ?? "http://localhost:8787";
const OUT = new URL("./out/", import.meta.url).pathname;
const DOCS = new URL("../../docs/", import.meta.url).pathname;
const W = 1920;
const H = 1080;

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith(".webm")) rmSync(`${OUT}${f}`);
mkdirSync(DOCS, { recursive: true });

const clips = await synthesize(`${OUT}tts`);
console.log(`narration ready: ${Object.keys(clips).length} lines`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});
const page = await context.newPage();
const t0 = Date.now();
const wait = (ms) => page.waitForTimeout(ms);

// ---------- narration timing ----------

const cues = [];
let speaking; // { id, startedAt, endsAt }

// Stretches of pure waiting (explorer indexing, page loads) are recorded, then
// removed from the final cut. Narration never plays inside one, so the audio
// track only needs its offsets shifted.
const cuts = [];
let cutStartedAt;
const cutBegin = () => (cutStartedAt = Date.now() - t0);
const cutEnd = () => {
  cuts.push([cutStartedAt, Date.now() - t0]);
  cutStartedAt = undefined;
};

/** Starts a narration line, first letting the previous one finish. */
async function say(id) {
  if (!clips[id]) throw new Error(`no narration line "${id}"`);
  if (speaking) {
    const remaining = speaking.endsAt + 350 - Date.now();
    if (remaining > 0) await wait(remaining);
  }
  const startedAt = Date.now();
  cues.push({ id, offsetMs: startedAt - t0 });
  speaking = { id, startedAt, endsAt: startedAt + clips[id].ms };
}

/** Holds the scene until the current line has finished, and at least minMs since it began. */
async function hold(minMs = 0) {
  if (!speaking) return wait(minMs);
  const until = Math.max(speaking.endsAt + 500, speaking.startedAt + minMs);
  const remaining = until - Date.now();
  if (remaining > 0) await wait(remaining);
}

// ---------- slides ----------

const SLIDE_CSS = `
  html,body{margin:0;height:100%;background:#0a0f1a;color:#e5eaf1;font-family:-apple-system,BlinkMacSystemFont,Inter,"Segoe UI",sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 170px;box-sizing:border-box}
  .kicker{color:#34d399;font-weight:600;font-size:24px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:22px}
  h1{font-size:84px;line-height:1.05;margin:0 0 26px;letter-spacing:-.03em;font-weight:700}
  h2{font-size:58px;line-height:1.12;margin:0 0 40px;letter-spacing:-.02em;font-weight:680}
  p.lead{font-size:34px;line-height:1.4;color:#aab6c8;margin:0;max-width:1450px}
  ul{margin:0;padding:0;list-style:none}
  li{font-size:34px;line-height:1.45;color:#cbd5e1;margin:0 0 22px;padding-left:40px;position:relative}
  li:before{content:"";position:absolute;left:0;top:20px;width:14px;height:14px;border-radius:3px;background:#34d399}
  li.bad:before{background:#f87171}
  li b{color:#fff;font-weight:650}
  pre{font:30px/1.55 ui-monospace,"SF Mono",Menlo,monospace;background:#0d1422;border:1px solid #273449;border-radius:16px;padding:34px 40px;margin:0 0 34px;color:#cbd5e1;white-space:pre}
  .k{color:#7aa7ff}.c{color:#5b687c}.h{color:#34d399;font-weight:700}
  .foot{position:fixed;left:170px;bottom:56px;color:#5b687c;font-size:22px}
`;

async function slide(id, html, minMs) {
  // Leave heavy pages (the explorer) without waiting on their long-lived
  // connections, which never let a "load" event fire.
  await page.goto("about:blank", { waitUntil: "commit" }).catch(() => {});
  await page.setContent(
    `<!doctype html><style>${SLIDE_CSS}</style><div class="wrap">${html}</div><div class="foot">lucid-keeperhub &middot; KeeperHub Agent Economy Hackathon</div>`,
    { waitUntil: "domcontentloaded" }
  );
  if (cutStartedAt !== undefined) cutEnd();
  await wait(500);
  await say(id);
  await hold(minMs);
}

// ---------- console helpers ----------

async function caption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById("__cap");
    if (!el) {
      const style = document.createElement("style");
      style.textContent = `
        #__cap{position:fixed;left:50%;top:14px;transform:translateX(-50%);width:min(1500px,calc(100% - 160px));
          background:rgba(6,10,18,.95);color:#f1f5f9;border:1px solid #334155;border-radius:14px;padding:15px 26px;
          font:500 25px/1.4 -apple-system,BlinkMacSystemFont,Inter,sans-serif;text-align:center;
          box-shadow:0 18px 50px rgba(0,0,0,.55);z-index:99999;transition:opacity .25s}
        .__ring{outline:3px solid #fbbf24 !important;outline-offset:4px}`;
      document.head.append(style);
      el = document.createElement("div");
      el.id = "__cap";
      document.body.append(el);
    }
    el.style.opacity = t ? "1" : "0";
    if (t) el.textContent = t;
  }, text);
}

async function press(id) {
  const selector = `#${id}`;
  await page.evaluate((s) => document.querySelector(s).classList.add("__ring"), selector);
  await wait(900);
  await page.click(selector);
  await wait(400);
  await page.evaluate((s) => document.querySelector(s).classList.remove("__ring"), selector);
}

const eventCount = () => page.evaluate(() => document.querySelectorAll("#events article").length);

async function untilEvents(n) {
  await page.waitForFunction((n) => document.querySelectorAll("#events article").length >= n, n, { timeout: 180_000 });
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some((b) => b.disabled), null, { timeout: 180_000 });
}

async function waitIndexed(apiUrl, isReady, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(apiUrl);
      if (res.ok && isReady(await res.json())) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return false;
}

/**
 * Shows a transaction on Blockscout once the explorer has indexed it. Fresh
 * transactions render "Something went wrong" until then, so the wait, the
 * navigation and any reloads all happen inside a cut.
 */
async function explorerScene(id, { url, apiUrl, isReady, rowText, text }) {
  await hold();
  cutBegin();
  const indexed = await waitIndexed(apiUrl, isReady, 25 * 60_000);
  let visible = false;
  for (let attempt = 1; indexed && attempt <= 4 && !visible; attempt += 1) {
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    visible = await page
      .waitForFunction((t) => [...document.querySelectorAll("tr")].some((r) => r.innerText.includes(t)), rowText, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!visible) {
    cutEnd();
    console.log(`skipping explorer scene "${id}": not indexed`);
    return;
  }
  await page.evaluate((t) => {
    const row = [...document.querySelectorAll("tr")].find((r) => r.innerText.includes(t));
    if (row) row.style.cssText += ";outline:3px solid #fbbf24;outline-offset:-3px;background:#fffbeb";
  }, rowText);
  await wait(300);
  cutEnd();
  await wait(700);
  await caption(text);
  await say(id);
  await hold(6000);
}

// ---------- the video ----------

await slide("title", `
  <div class="kicker">KeeperHub x Lucid Agents</div>
  <h1>Deterministic onchain settlement<br>for Lucid Agents</h1>
  <p class="lead">A Lucid extension that makes KeeperHub the execution layer for agents that sell onchain work.</p>
`, 5000);

await slide("gap", `
  <div class="kicker">The gap</div>
  <h2>Lucid Agents handles the sale.<br>Nothing handles the money going out.</h2>
  <ul>
    <li>Lucid owns payment admission and fulfillment, and keeps <b>wallets and networks external</b> by design.</li>
    <li class="bad">So a seller that owes an onchain payout hand-rolls a signer: key in memory, no dry run, no audit trail.</li>
    <li class="bad">And a buyer that retries a timed-out request <b>gets paid twice</b>.</li>
  </ul>
`, 8000);

await slide("integration", `
  <div class="kicker">The integration</div>
  <pre><span class="c">// install</span>
createAgent(meta).use(http()).use(payments()).<span class="h">use(keeperhub({ requireIdempotencyKey: true }))</span>

<span class="c">// inside the paid entrypoint</span>
<span class="k">const</span> outcome = <span class="k">await</span> ctx.runtime.keeperhub.<span class="h">settle</span>(
  { recipientAddress, amount },
  { <span class="h">context: ctx</span> }  <span class="c">// keyed to the buyer's Idempotency-Key</span>
);</pre>
  <ul>
    <li>Dry run, broadcast and confirm through <b>KeeperHub</b>. The buyer gets a transaction hash.</li>
    <li>Settlement runs only after Lucid has admitted the buyer's <b>x402</b> payment.</li>
  </ul>
`, 8000);

await page.goto(`${BASE}/demo`);
await page.waitForFunction(() => document.getElementById("sender").textContent !== "...", null, { timeout: 30_000 });
await page.waitForFunction(() => !document.getElementById("stat-paid").textContent.includes("..."), null, { timeout: 30_000 }).catch(() => {});
await wait(1000);
await caption("A live Lucid agent that sells payouts. Every button calls its real HTTP entrypoints.");
await say("intro");
await hold(4000);

await page.evaluate(() => document.getElementById("capability").scrollIntoView({ behavior: "smooth", block: "center" }));
await wait(1000);
await caption("Buyers discover the capability in the A2A agent card before they call anything.");
await say("card");
await hold(3000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await wait(1000);

let n = await eventCount();
await caption("Another agent buys a payout: an x402 challenge for $0.01 USDC on Base Sepolia, payable to the seller's KeeperHub wallet.");
await say("buy");
await press("buy");
await untilEvents(n + 1);
await hold();
await caption("Payment admitted by Lucid, payout executed by KeeperHub. USDC in on Base Sepolia, ETH out on Sepolia.");
await say("buyDone");
await hold(4000);

n = await eventCount();
await caption("Now the unhappy paths. A settle request with an Idempotency-Key.");
await say("settle");
await press("settle");
await untilEvents(n + 1);
await hold();
await caption("One transfer, confirmed, with KeeperHub's execution record.");
await say("settleDone");
await hold(3500);

n = await eventCount();
await caption("Retry with the same Idempotency-Key: Lucid replays its stored response. The handler never runs.");
await say("retry");
await press("retry");
await untilEvents(n + 1);
await hold(3000);

n = await eventCount();
await caption("Restart the seller. Lucid's in-memory idempotency store is gone, so the handler runs again with a new runId...");
await say("restart");
await press("restart");
await untilEvents(n + 2);
await hold();
await caption("...and KeeperHub matches the buyer's key to the original transfer. No second transaction.");
await say("restartDone");
await hold(4000);

n = await eventCount();
await caption("No Idempotency-Key: nothing could make a retry safe, so the seller refuses to send.");
await say("nokey");
await press("nokey");
await untilEvents(n + 1);
await hold(3000);

n = await eventCount();
await caption("Overdraw: KeeperHub's dry run stops it. No transaction, no gas.");
await say("overdraw");
await press("overdraw");
await untilEvents(n + 1);
await hold(3000);

await caption("Six requests. One paid purchase and one settle, each executed exactly once.");
await say("summary");
await hold(3000);
await caption("");
await wait(400);
await page.screenshot({ path: `${DOCS}console.png` });

const links = await page.evaluate(() => {
  const purchase = [...document.querySelectorAll("#events article")].find((a) => a.innerText.includes("bought a payout"));
  const hrefs = purchase ? [...purchase.querySelectorAll("a")].map((a) => a.href) : [];
  return {
    payment: hrefs.find((h) => h.includes("base-sepolia.blockscout.com/tx/")),
    payout: hrefs.find((h) => h.includes("/tx/") && !h.includes("base-sepolia")),
  };
});
console.log("purchase links:", JSON.stringify(links));

if (links.payment) {
  const hash = links.payment.split("/tx/")[1];
  await explorerScene("paymentTx", {
    url: `https://base-sepolia.blockscout.com/tx/${hash}?tab=token_transfers`,
    apiUrl: `https://base-sepolia.blockscout.com/api/v2/transactions/${hash}/token-transfers`,
    isReady: (d) => (d.items ?? []).length > 0,
    rowText: "USDC",
    text: "Value in: the x402 payment on Base Sepolia, 0.01 USDC from the buyer agent to the seller's KeeperHub wallet.",
  });
}
if (links.payout) {
  // Internal transactions, not the summary: the payout is relayed, so the
  // top-level call carries 0 ETH and the value moves one call deeper.
  const hash = links.payout.split("/tx/")[1];
  await explorerScene("payoutTx", {
    url: `https://eth-sepolia.blockscout.com/tx/${hash}?tab=internal`,
    apiUrl: `https://eth-sepolia.blockscout.com/api/v2/transactions/${hash}/internal-transactions`,
    isReady: (d) => (d.items ?? []).some((i) => i.value === "100000000000000"),
    rowText: "0.0001",
    text: "Value out: the payout KeeperHub executed on Sepolia, from the KeeperHub wallet to the recipient, gas paid by a relayer.",
  });
}

await hold();
cutBegin();
await slide("built", `
  <div class="kicker">What was built</div>
  <ul>
    <li><b>keeperhub()</b> Lucid extension: typed runtime slice, build-time validation, A2A capability advertisement.</li>
    <li><b>Agent-to-agent commerce</b>: a buyer pays over Lucid's x402 flow; KeeperHub executes what was bought.</li>
    <li><b>Two layers of idempotency</b>: Lucid's HTTP store, backed by KeeperHub's execution record keyed to the buyer's request.</li>
    <li><b>88 tests</b> against real Lucid runtimes: restart-and-retry sends one transfer; no settlement before x402 admission.</li>
  </ul>
`, 8000);

await slide("close", `
  <div class="kicker">lucid-keeperhub</div>
  <h2>Lucid Agents sells the work.<br>KeeperHub moves the money, once.</h2>
  <p class="lead">Lucid: extension API, x402 payments, HTTP idempotency, A2A agent card.<br>KeeperHub: Direct Execution API, dry runs, idempotency, execution audit trail.</p>
`, 6000);
await wait(1200);

const video = page.video();
await context.close();
await browser.close();
const raw = await video.path();

// ---------- mux narration onto the recording ----------

const cutBefore = (ms) => cuts.filter(([, end]) => end <= ms).reduce((sum, [a, b]) => sum + (b - a), 0);

const keep = [];
let cursor = 0;
for (const [a, b] of cuts) {
  if (a > cursor) keep.push([cursor, a]);
  cursor = b;
}
keep.push([cursor, null]);

const filters = [
  `[0:v]split=${keep.length}${keep.map((_, i) => `[s${i}]`).join("")}`,
  ...keep.map(([a, b], i) => `[s${i}]trim=start=${a / 1000}${b === null ? "" : `:end=${b / 1000}`},setpts=PTS-STARTPTS[v${i}]`),
  `${keep.map((_, i) => `[v${i}]`).join("")}concat=n=${keep.length}:v=1:a=0[vout]`,
];

const inputs = ["-i", raw];
cues.forEach((cue, i) => {
  inputs.push("-i", clips[cue.id].file);
  filters.push(`[${i + 1}:a]aresample=48000,adelay=${cue.offsetMs - cutBefore(cue.offsetMs)}:all=1[a${i}]`);
});
filters.push(`${cues.map((_, i) => `[a${i}]`).join("")}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`);
console.log(`cuts removed: ${cuts.map(([a, b]) => `${(a / 1000).toFixed(1)}-${(b / 1000).toFixed(1)}s`).join(", ") || "none"}`);

const mp4 = `${OUT}lucid-keeperhub-demo.mp4`;
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error",
  ...inputs,
  "-filter_complex", filters.join(";"),
  "-map", "[vout]", "-map", "[aout]",
  "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "160k",
  "-movflags", "+faststart",
  mp4,
]);
console.log(`video: ${mp4}`);
console.log(`cues: ${cues.map((c) => `${c.id}@${(c.offsetMs / 1000).toFixed(1)}s`).join(" ")}`);
console.log(`screenshot: ${DOCS}console.png`);
