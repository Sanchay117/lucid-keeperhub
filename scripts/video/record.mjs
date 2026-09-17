/**
 * Records the submission demo video against the live agent and Sepolia.
 *
 *   1. Start the agent:  (examples/settlement-agent) node --experimental-strip-types src/index.ts
 *   2. Record:           node scripts/video/record.mjs
 *
 * Every settle in the recording is a real request to the agent's Lucid
 * entrypoints and a real KeeperHub execution; nothing is mocked or replayed
 * from a fixture. Output: scripts/video/out/lucid-keeperhub-demo.mp4 and a
 * console screenshot at docs/console.png.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CONSOLE_URL ?? "http://localhost:8787";
const OUT = new URL("./out/", import.meta.url).pathname;
const DOCS = new URL("../../docs/", import.meta.url).pathname;
const W = 1920;
const H = 1080;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(DOCS, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);

// ---------- slides ----------

const SLIDE_CSS = `
  html,body{margin:0;height:100%;background:#0a0f1a;color:#e5eaf1;font-family:-apple-system,BlinkMacSystemFont,Inter,"Segoe UI",sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 170px;box-sizing:border-box}
  .kicker{color:#34d399;font-weight:600;font-size:24px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:22px}
  h1{font-size:84px;line-height:1.05;margin:0 0 26px;letter-spacing:-.03em;font-weight:700}
  h2{font-size:58px;line-height:1.12;margin:0 0 40px;letter-spacing:-.02em;font-weight:680}
  p.lead{font-size:34px;line-height:1.4;color:#aab6c8;margin:0;max-width:1400px}
  ul{margin:0;padding:0;list-style:none}
  li{font-size:34px;line-height:1.45;color:#cbd5e1;margin:0 0 22px;padding-left:40px;position:relative}
  li:before{content:"";position:absolute;left:0;top:20px;width:14px;height:14px;border-radius:3px;background:#34d399}
  li.bad:before{background:#f87171}
  li b{color:#fff;font-weight:650}
  pre{font:30px/1.55 ui-monospace,"SF Mono",Menlo,monospace;background:#0d1422;border:1px solid #273449;border-radius:16px;padding:34px 40px;margin:0 0 34px;color:#cbd5e1;white-space:pre}
  .k{color:#7aa7ff}.s{color:#fbbf24}.c{color:#5b687c}.h{color:#34d399;font-weight:700}
  .foot{position:fixed;left:170px;bottom:56px;color:#5b687c;font-size:22px}
`;

async function slide(html, ms) {
  // Leave heavy pages (the explorer) without waiting on their long-lived
  // connections, which never let a "load" event fire.
  await page.goto("about:blank", { waitUntil: "commit" }).catch(() => {});
  await page.setContent(`<!doctype html><style>${SLIDE_CSS}</style><div class="wrap">${html}</div><div class="foot">lucid-keeperhub &middot; KeeperHub Agent Economy Hackathon</div>`, { waitUntil: "domcontentloaded" });
  await wait(ms);
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
  await page.waitForFunction((n) => document.querySelectorAll("#events article").length >= n, n, { timeout: 120_000 });
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some((b) => b.disabled), null, { timeout: 120_000 });
}

// ---------- the video ----------

await slide(`
  <div class="kicker">KeeperHub x Lucid Agents</div>
  <h1>Deterministic onchain settlement<br>for Lucid Agents</h1>
  <p class="lead">A Lucid extension that makes KeeperHub the execution layer for agents that sell onchain work.</p>
`, 6000);

await slide(`
  <div class="kicker">The gap</div>
  <h2>Lucid Agents handles the sale.<br>Nothing handles the money going out.</h2>
  <ul>
    <li>Lucid owns payment admission and fulfillment, and keeps <b>wallets and networks external</b> by design.</li>
    <li class="bad">So a seller that owes an onchain payout hand-rolls a signer: key in memory, no dry run, no audit trail.</li>
    <li class="bad">And a buyer that retries a timed-out request <b>gets paid twice</b>.</li>
  </ul>
`, 11000);

await slide(`
  <div class="kicker">The integration</div>
  <pre><span class="c">// install</span>
createAgent(meta).use(http()).<span class="h">use(keeperhub({ requireIdempotencyKey: true }))</span>

<span class="c">// inside the paid entrypoint</span>
<span class="k">const</span> outcome = <span class="k">await</span> ctx.runtime.keeperhub.<span class="h">settle</span>(
  { recipientAddress, amount },
  { <span class="h">context: ctx</span> }  <span class="c">// keyed to the buyer's Idempotency-Key</span>
);</pre>
  <ul>
    <li>Dry run, broadcast and confirm through <b>KeeperHub</b>. The buyer gets a transaction hash.</li>
    <li>Tests run against the real <b>@lucid-agents/core</b> and <b>@lucid-agents/http</b> runtimes.</li>
  </ul>
`, 12000);

await page.goto(`${BASE}/demo`);
await page.waitForFunction(() => document.getElementById("sender").textContent !== "...", null, { timeout: 30_000 });
// Slightly larger than 1:1 so the console stays legible in a small player.
await page.evaluate(() => (document.documentElement.style.zoom = "1.1"));
await wait(1500);
await caption("A Lucid agent that sells settlement. Every button calls its real Lucid HTTP entrypoints, on Ethereum Sepolia.");
await wait(6000);

await page.evaluate(() => document.getElementById("capability").scrollIntoView({ behavior: "smooth", block: "center" }));
await wait(1200);
await caption("Buyers discover the capability in the A2A agent card before they call anything.");
await wait(5500);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await wait(1200);

let n = await eventCount();
await caption("Dry run through KeeperHub: validated against live chain state. Nothing signed, nothing sent.");
await press("quote");
await untilEvents(n + 1);
await wait(5000);

n = await eventCount();
await caption("Settle. KeeperHub dry-runs, broadcasts one transfer and waits for the receipt...");
await press("settle");
await untilEvents(n + 1);
await caption("One transfer, confirmed. KeeperHub's execution record: verified receipt, gas sponsored. Balance read from the chain.");
await wait(8500);

n = await eventCount();
await caption("The buyer retries with the same Idempotency-Key. Lucid replays its stored response; the handler never runs.");
await press("retry");
await untilEvents(n + 1);
await wait(6500);

n = await eventCount();
await caption("Now restart the seller. Lucid's idempotency store is gone, so the handler runs again with a brand-new runId...");
await press("restart");
await untilEvents(n + 2);
await caption("...and KeeperHub matches the buyer's key to the original transfer. Three requests. Still one transfer.");
await wait(9500);

n = await eventCount();
await caption("A request with no Idempotency-Key cannot be made safe to retry, so the seller refuses to send it.");
await press("nokey");
await untilEvents(n + 1);
await wait(6000);

n = await eventCount();
await caption("Overdraw: asking for more than the wallet holds. KeeperHub's dry run stops it. No transaction, no gas.");
await press("overdraw");
await untilEvents(n + 1);
await wait(6500);

await caption("Five settle requests. One transfer on chain.");
await wait(5000);
await caption("");
await wait(400);
await page.screenshot({ path: `${DOCS}console.png` });

const txLink = await page.evaluate(() => [...document.querySelectorAll("#events a")].map((a) => a.href).find((h) => h.includes("/tx/")));
if (txLink) {
  const hash = txLink.split("/tx/")[1];
  // The internal-transactions tab, not the summary: the transfer is relayed,
  // so the top-level call carries 0 ETH and the value moves one call deeper.
  await page.goto(`https://eth-sepolia.blockscout.com/tx/${hash}?tab=internal`, { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(() => [...document.querySelectorAll("tr")].some((r) => r.innerText.includes("0.0001")), null, { timeout: 60_000 })
    .catch(() => {});
  await wait(1200);
  await caption("On a public explorer: 0.0001 ETH from the KeeperHub wallet to the recipient, submitted by a relayer that paid the gas.");
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("tr")].find((r) => r.innerText.includes("0.0001"));
    if (row) row.style.cssText += ";outline:3px solid #fbbf24;outline-offset:-3px;background:#fffbeb";
  });
  await wait(9000);
}

await slide(`
  <div class="kicker">What was built</div>
  <ul>
    <li><b>keeperhub()</b> Lucid extension: typed runtime slice, build-time validation, A2A capability advertisement.</li>
    <li><b>Two layers of idempotency</b>: Lucid's HTTP store, backed by KeeperHub's execution record keyed to the buyer's request.</li>
    <li><b>Retry policy that cannot double-send</b>, following KeeperHub's error semantics.</li>
    <li><b>85 tests</b>, including settle, restart, retry through the real Lucid HTTP stack: one transfer.</li>
  </ul>
`, 12000);

await slide(`
  <div class="kicker">lucid-keeperhub</div>
  <h2>Lucid Agents sells the work.<br>KeeperHub moves the money, once.</h2>
  <p class="lead">KeeperHub surfaces: Direct Execution API, dry-run simulation, idempotency, execution audit trail.</p>
`, 7000);

const video = page.video();
await context.close();
await browser.close();

const raw = await video.path();
const mp4 = `${OUT}lucid-keeperhub-demo.mp4`;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
console.log(`video: ${mp4}`);
console.log(`screenshot: ${DOCS}console.png`);
