/**
 * The seller: a Lucid agent that other agents pay to move value onchain.
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
 * Built by a function rather than at module scope so the demo console can
 * restart it: a fresh runtime has a fresh, empty Lucid idempotency store, which
 * is exactly the condition under which the KeeperHub layer has to hold.
 */

import { createAgent } from "@lucid-agents/core";
import { createAgentApp } from "@lucid-agents/hono";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";
import { keeperhub } from "lucid-keeperhub";
import { z } from "zod";

export const CHAIN_ID = Number(process.env.KEEPERHUB_CHAIN_ID ?? 11155111);

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x EVM address");

const SettleInput = z.object({
  recipient: address,
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "amount must be a plain decimal, in whole units, not wei"),
  /** ERC-20 to settle in. Omitted means the chain's native token. */
  tokenAddress: address.optional(),
});

const SettleOutput = z.object({
  status: z.enum(["settled", "failed", "unconfirmed"]),
  executionId: z.string(),
  transactionHash: z.string().optional(),
  transactionLink: z.string().optional(),
  /** True when KeeperHub replayed a stored outcome instead of re-executing. */
  replayed: z.boolean(),
  sponsored: z.boolean().optional(),
  /** What the KeeperHub idempotency key was anchored to. */
  workIdSource: z.string().optional(),
  gasEstimate: z.string().optional(),
  error: z.string().optional(),
});

export type Seller = Awaited<ReturnType<typeof buildSeller>>;

export async function buildSeller() {
  const builder = createAgent({
    name: "keeperhub-settlement-agent",
    version: "1.0.0",
    description:
      "Executes onchain value transfer deterministically through KeeperHub, with dry-run preflight and a per-execution audit trail.",
  })
    .use(http())
    // A settlement a buyer cannot safely retry is refused rather than sent.
    .use(keeperhub({ defaultChainId: CHAIN_ID, requireIdempotencyKey: true }));

  // Priced only when the operator configured an x402 facilitator, following
  // Lucid's own conditional-payments pattern, so the agent runs with a
  // KeeperHub key alone.
  const paymentsConfig = paymentsFromEnv();
  if (paymentsConfig) builder.use(payments({ config: paymentsConfig }));

  const runtime = await builder
    .addEntrypoint({
      key: "settle",
      description: "Move value onchain through KeeperHub and return the transaction as proof.",
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
      handler: async (ctx) => {
        // Passing the whole context lets the extension anchor the KeeperHub
        // key to the buyer's Idempotency-Key. `runId` would not do: Lucid
        // mints a new one for every HTTP request, retries included.
        const outcome = await ctx.runtime.keeperhub.settle(
          {
            chainId: CHAIN_ID,
            recipientAddress: ctx.input.recipient,
            amount: ctx.input.amount,
            ...(ctx.input.tokenAddress ? { tokenAddress: ctx.input.tokenAddress } : {}),
          },
          { context: ctx }
        );

        return {
          output: {
            status: outcome.status,
            executionId: outcome.executionId,
            transactionHash: outcome.transactionHash,
            transactionLink: outcome.transactionLink,
            replayed: outcome.replayed,
            sponsored: outcome.sponsored,
            workIdSource: outcome.workIdSource,
            gasEstimate: outcome.gasEstimate,
            error: outcome.error,
          },
        };
      },
    })
    .addEntrypoint({
      key: "quote",
      description:
        "Dry-run a settlement against live chain state. Returns the gas estimate, or the reason it would fail, without broadcasting.",
      input: SettleInput,
      output: z.object({
        ok: z.boolean(),
        gasEstimate: z.string().optional(),
        from: z.string().optional(),
        reason: z.string().optional(),
      }),
      handler: async (ctx) => ({
        output: await ctx.runtime.keeperhub.simulate({
          chainId: CHAIN_ID,
          recipientAddress: ctx.input.recipient,
          amount: ctx.input.amount,
          ...(ctx.input.tokenAddress ? { tokenAddress: ctx.input.tokenAddress } : {}),
        }),
      }),
    })
    .build();

  const { app } = await createAgentApp(runtime);
  return { runtime, app, paymentsEnabled: Boolean(paymentsConfig) };
}
