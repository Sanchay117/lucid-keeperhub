/**
 * Settlement-as-a-service: a Lucid agent that other agents pay to move value
 * onchain, deterministically.
 *
 * The loop this closes is the whole point of the integration:
 *
 *   buyer agent --x402 USDC--> this Lucid agent --KeeperHub--> onchain transfer
 *                                                     |
 *                                            tx hash + audit trail
 *                                                     |
 *                     <----------- returned to the buyer ---------
 *
 * Value comes in through Lucid's payment admission and goes out through
 * KeeperHub's executor. Neither half is hand-rolled, and the buyer gets a
 * verifiable transaction hash rather than an agent's assurance that it paid.
 *
 * Payments are optional so the agent runs with nothing but a KeeperHub key:
 * without x402 configured the entrypoint is free and still settles for real.
 */

import { serve } from "@hono/node-server";
import { createAgent } from "@lucid-agents/core";
import { createAgentApp } from "@lucid-agents/hono";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";
import { keeperhub } from "lucid-keeperhub";
import { z } from "zod";

const CHAIN_ID = Number(process.env.KEEPERHUB_CHAIN_ID ?? 84532);
const PORT = Number(process.env.PORT ?? 8787);

const SettleInput = z.object({
  recipient: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "recipient must be a 0x EVM address"),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "amount must be a plain decimal, in whole units, not wei"),
  /** ERC-20 to settle in. Omitted means the chain's native token. */
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

const SettleOutput = z.object({
  status: z.enum(["settled", "failed", "unconfirmed"]),
  executionId: z.string(),
  transactionHash: z.string().optional(),
  transactionLink: z.string().optional(),
  /** True when KeeperHub replayed a stored outcome instead of re-executing. */
  replayed: z.boolean(),
  gasEstimate: z.string().optional(),
  error: z.string().optional(),
});

async function main() {
  const builder = createAgent({
    name: "keeperhub-settlement-agent",
    version: "1.0.0",
    description:
      "Executes onchain value transfer deterministically through KeeperHub, with dry-run preflight and a per-execution audit trail.",
  })
    .use(http())
    .use(keeperhub({ defaultChainId: CHAIN_ID }));

  // Priced only when the operator configured an x402 facilitator. Following
  // Lucid's own conditional-payments pattern keeps the agent runnable with a
  // KeeperHub key alone.
  const paymentsConfig = paymentsFromEnv();
  if (paymentsConfig) {
    builder.use(payments({ config: paymentsConfig }));
    console.log("[settlement-agent] x402 payments enabled");
  } else {
    console.log("[settlement-agent] x402 not configured; entrypoint is free");
  }

  const runtime = await builder
    .addEntrypoint({
      key: "settle",
      description:
        "Move value onchain through KeeperHub and return the transaction as proof.",
      input: SettleInput,
      output: SettleOutput,
      ...(paymentsConfig ? { price: "0.01", paymentProtocol: "x402" as const } : {}),
      metadata: {
        keeperhub: {
          settles: true,
          chainId: CHAIN_ID,
          description: "Native or ERC-20 transfer executed by KeeperHub",
        },
      },
      handler: async ({ input, runId, runtime: rt }) => {
        // `runId` is the anchor for the whole guarantee. Lucid holds it stable
        // across a retry of this invocation, so a buyer that retries a timed-out
        // call gets KeeperHub's stored outcome rather than a second transfer.
        const outcome = await rt.keeperhub.settle(
          {
            chainId: CHAIN_ID,
            recipientAddress: input.recipient,
            amount: input.amount,
            ...(input.tokenAddress ? { tokenAddress: input.tokenAddress } : {}),
          },
          { workId: runId }
        );

        return {
          output: {
            status: outcome.status,
            executionId: outcome.executionId,
            transactionHash: outcome.transactionHash,
            transactionLink: outcome.transactionLink,
            replayed: outcome.replayed,
            gasEstimate: outcome.gasEstimate,
            error: outcome.error,
          },
        };
      },
    })
    .addEntrypoint({
      key: "quote",
      description:
        "Dry-run a settlement. Returns the gas estimate, or the revert reason, without broadcasting.",
      input: SettleInput,
      output: z.object({
        ok: z.boolean(),
        gasEstimate: z.string().optional(),
        reason: z.string().optional(),
      }),
      handler: async ({ input, runtime: rt }) => ({
        output: await rt.keeperhub.simulate({
          chainId: CHAIN_ID,
          recipientAddress: input.recipient,
          amount: input.amount,
          ...(input.tokenAddress ? { tokenAddress: input.tokenAddress } : {}),
        }),
      }),
    })
    .build();

  const { app } = await createAgentApp(runtime);

  serve({ fetch: app.fetch, port: PORT });

  console.log(`[settlement-agent] listening on http://localhost:${PORT}`);
  console.log(`[settlement-agent] agent card: http://localhost:${PORT}/.well-known/agent-card.json`);
  console.log(`[settlement-agent] settling on chain ${CHAIN_ID}`);
}

await main();
