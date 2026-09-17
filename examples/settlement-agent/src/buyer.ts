/**
 * The buyer: another agent that pays the seller over x402 for a payout.
 *
 * It holds its own wallet (a throwaway testnet key with faucet USDC) and uses
 * Lucid's own buyer, `createX402Fetch`, so the payment is signed and settled
 * exactly as it would be between two independent Lucid agents: request, 402
 * challenge, signed USDC authorization, facilitator settlement on Base Sepolia,
 * then the seller's handler settles the payout through KeeperHub.
 *
 * The first unpaid request exists only to show the challenge. Lucid answers
 * 402 before it claims the Idempotency-Key, so the probe does not consume it.
 */

import {
  accountFromPrivateKey,
  createX402Fetch,
  decodePaymentRequiredHeader,
  type Hex,
} from "@lucid-agents/payments";

export type PurchaseResult = {
  buyer: string;
  challenge?: {
    amount?: string;
    asset?: string;
    network?: string;
    payTo?: string;
  };
  httpStatus: number;
  /** Decoded x402 PAYMENT-RESPONSE: the facilitator's settlement of the USDC payment. */
  payment?: { success?: boolean; transaction?: string; network?: string; payer?: string };
  runId?: string;
  output?: Record<string, unknown>;
  error?: unknown;
};

function decodeBase64Json(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

export async function buyPayout(options: {
  sellerUrl: string;
  privateKey: Hex;
  recipient: string;
  amount: string;
  idempotencyKey: string;
}): Promise<PurchaseResult> {
  const account = accountFromPrivateKey(options.privateKey);
  const url = `${options.sellerUrl.replace(/\/+$/, "")}/entrypoints/payout/invoke`;
  const init = {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": options.idempotencyKey },
    body: JSON.stringify({ input: { recipient: options.recipient, amount: options.amount } }),
  };

  const probe = await fetch(url, init);
  const required = decodePaymentRequiredHeader(probe.headers.get("PAYMENT-REQUIRED"));
  const offer = (required as { accepts?: Array<Record<string, string>> } | undefined)?.accepts?.[0];

  const paidFetch = createX402Fetch({ account, networks: ["eip155:84532"] });
  const res = await paidFetch(url, init);
  const body = (await res.json().catch(() => ({}))) as {
    run_id?: string;
    output?: Record<string, unknown>;
    error?: unknown;
  };

  const payment = decodeBase64Json(
    res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE")
  ) as PurchaseResult["payment"];

  return {
    buyer: (account as { address: string }).address,
    challenge: offer
      ? { amount: offer.amount, asset: offer.asset, network: offer.network, payTo: offer.payTo }
      : undefined,
    httpStatus: res.status,
    payment,
    runId: body.run_id,
    output: body.output,
    error: body.error,
  };
}
