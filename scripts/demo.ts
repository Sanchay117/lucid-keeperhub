/**
 * End-to-end demo: proves value moved through KeeperHub and prints the link.
 *
 * This is the script to run on camera. It walks the full settlement path and
 * narrates each step, including the two that are easy to skip and expensive to
 * get wrong -- the dry run, and the idempotent replay.
 *
 * Usage:
 *   cp .env.example .env   # fill in KEEPERHUB_API_KEY and DEMO_RECIPIENT
 *   npm run demo           # builds, then runs this with .env loaded
 */

// Imports the built package: Node strips types but does not rewrite the `.js`
// specifiers the sources use for NodeNext, so the sources cannot run directly.
import { KeeperHubClient, settleTransfer } from "../dist/index.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
};

const line = (label: string, value: unknown) =>
  console.log(`  ${label.padEnd(18)} ${String(value)}`);

async function main() {
  const apiKey = required("KEEPERHUB_API_KEY");
  const recipient = required("DEMO_RECIPIENT");
  const chainId = Number(process.env.KEEPERHUB_CHAIN_ID ?? 84532);
  const amount = process.env.DEMO_AMOUNT ?? "0.0001";

  const client = new KeeperHubClient({
    apiKey,
    ...(process.env.KEEPERHUB_BASE_URL ? { baseUrl: process.env.KEEPERHUB_BASE_URL } : {}),
  });

  const request = { chainId, recipientAddress: recipient, amount };

  console.log("\n=== KeeperHub x Lucid Agents: settlement demo ===\n");
  line("chain", chainId);
  line("recipient", recipient);
  line("amount", amount);

  // 1. Spend cap. A cap that is already exhausted turns every settlement below
  //    into a 403, and finding that out here is cheaper than mid-demo.
  console.log("\n[1/4] Reading the organization spend cap");
  try {
    const cap = await client.getSpendCap();
    line("effective cap wei", cap.effectiveDailyCapWei ?? "(unconfigured)");
  } catch (error) {
    line("cap lookup", `skipped (${error instanceof Error ? error.message : error})`);
  }

  // 2. Dry run. No signature, no broadcast, no audit row.
  console.log("\n[2/4] Dry run -- validates against live chain state, spends nothing");
  try {
    const simulation = await client.simulateTransfer(request);
    line("would revert", simulation.wouldRevert);
    line("gas estimate", simulation.gasEstimate);
    line("from", simulation.from);
  } catch (error) {
    console.error("  Dry run failed:", error instanceof Error ? error.message : error);
    console.error("  Nothing was broadcast. Fix the above and re-run.");
    process.exit(1);
  }

  // 3. Settle for real. The workId is what makes step 4 safe.
  const workId = `demo-${Date.now()}`;
  console.log(`\n[3/4] Settling through KeeperHub (workId=${workId})`);
  const outcome = await settleTransfer(client, request, { workId });

  line("status", outcome.status);
  line("execution id", outcome.executionId);
  line("tx hash", outcome.transactionHash ?? "(none)");
  line("sponsored", outcome.sponsored ?? false);
  line("replayed", outcome.replayed);

  if (outcome.transactionLink) {
    console.log(`\n  PROOF: ${outcome.transactionLink}\n`);
  }

  if (outcome.status !== "settled") {
    console.error(`  Settlement did not complete: ${outcome.error ?? "unknown"}`);
    process.exit(1);
  }

  // 4. The part worth watching: replay the exact same work. A hand-rolled
  //    signer sends a second transaction here. This returns the first one.
  console.log("[4/4] Replaying the identical call -- must NOT send a second transaction");
  const replay = await settleTransfer(client, request, { workId });

  line("status", replay.status);
  line("tx hash", replay.transactionHash ?? "(none)");
  line("replayed flag", replay.replayed);

  const sameTx = replay.transactionHash === outcome.transactionHash;
  console.log(
    `\n  ${sameTx ? "PASS" : "FAIL"}: replay returned the ${sameTx ? "same" : "a DIFFERENT"} transaction\n`
  );

  process.exit(sameTx ? 0 : 1);
}

await main();
