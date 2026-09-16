# lucid-keeperhub

**Deterministic onchain settlement for [Lucid Agents](https://github.com/daydreamsai/lucid-agents), executed through [KeeperHub](https://keeperhub.com).**

A Lucid extension that gives a selling agent somewhere safe to put the onchain
half of its work.

```ts
const runtime = await createAgent({ name: 'payout', version: '1.0.0' })
  .use(http())
  .use(keeperhub({ defaultChainId: 84532 }))
  .addEntrypoint({
    key: 'settle',
    input: z.object({ recipient: z.string(), amount: z.string() }),
    metadata: { keeperhub: { settles: true } },
    handler: async ({ input, runId, runtime }) => {
      const outcome = await runtime.keeperhub.settle(
        { recipientAddress: input.recipient, amount: input.amount },
        { workId: runId },          // <- the whole guarantee hangs off this
      );
      return { output: { tx: outcome.transactionLink } };
    },
  })
  .build();
```

---

## Why this exists

Lucid Agents is explicit about its boundary. From the project README:

> It provides one runtime for schemas, payment admission, policy, idempotency,
> fulfillment, discovery, and accounting **while wallets, payment protocols,
> networks, and facilitators remain external.**

That boundary is a good one, but it leaves a hole on the fulfillment side. An
agent that *sells onchain work* — a payout service, a rebalancer, a treasury
bot, anything where delivery means moving value — has nowhere to put the
execution. In practice it ends up doing this inside the handler:

```ts
// The status quo, and every problem with it
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const tx = await wallet.sendTransaction({ to: input.recipient, value });
```

Private key in process memory. No dry run, so a revert is discovered by paying
gas for it. No nonce management, so a stuck transaction wedges the agent. No
audit trail, so "did we pay them?" is answered by grepping logs. And no
idempotency, so **a buyer who retries a timed-out call gets paid twice.**

That last one is not hypothetical. It is the default behaviour of the code
above, and an LLM-driven caller retries far more eagerly than a human does.

This extension replaces that block with KeeperHub: non-custodial Turnkey
wallets, dry-run preflight, nonce management, private routing, retries with
backoff, and a per-execution audit trail — reached through one typed runtime
slice.

## What it does that a wrapper does not

Five things here are load-bearing. Each exists because of a documented
KeeperHub behaviour that a naive client gets wrong.

### 1. Idempotency keys anchored to the Lucid `runId`

KeeperHub deduplicates fund-moving requests on a caller-supplied
`Idempotency-Key`, and its docs are blunt about the trap:

> A UUID generated per attempt does not survive a retry: the second attempt
> generates a different UUID, so the request is treated as new and executes
> again.

Lucid already hands every handler a `runId` that is stable across a retry of
that invocation. Passing it as `workId` is the entire fix — the key is derived
from the work rather than persisted before it, so any process can reproduce it.

### 2. Body canonicalization, which closes the 409 trap

KeeperHub hashes the request body to detect conflicts, and normalizes key order
but **not values**. So a body that is *rebuilt* rather than replayed conflicts
with work already in flight:

> `hashRequest` normalizes key order but not values, so `"0.1"` against
> `"0.10"`, `network` in place of `chainId`, or a reworded memo all produce a
> conflict for work that is already under way.

The documented remedy is to canonicalize the body and keep the key. This
package canonicalizes amounts (string-based, so precision is never lost to a
float round-trip), lowercases addresses, and unifies chain-id spellings — then
derives the key from that same canonical form, so the key and the body can
never disagree about what the work is.

### 3. Two-phase settlement, with proof recovered rather than assumed

The execute endpoints return a transaction hash **only when the step reported
success**. A `failed` or `unconfirmed` response carries none — including when a
transaction really was broadcast and only its receipt could not be confirmed.
Treating "no hash" as "nothing happened" is precisely how an agent double-pays.

`settleTransfer` therefore always reads the stored execution back. It also
surfaces `sponsored`, without which verification goes wrong in the other
direction: a sponsored execution never touches the org EOA's nonce or balance,
so checking EOA state concludes nothing happened even on success.

### 4. A retry policy that cannot double-send

| Condition | Retried? | Why |
| --- | --- | --- |
| `429` rate limit | yes | Rejected before execution; repeating is safe. |
| `5xx` / dropped connection, **with** an idempotency key | yes | KeeperHub can match the retry to the original. |
| `5xx` / dropped connection, **without** a key | **no** | May have executed. Nothing can match the retry. |
| Any failure carrying a `transactionHash` | **no** | A transaction is already live; a retry signs a second. |
| `idempotency_in_progress` | yes, **same key** | Rotating escapes the in-progress guard. |
| Revert, scope, spend cap | no | Repeating cannot change the outcome. |

Failures that cannot be attributed default to *not* retryable. A misclassified
retry on a value-moving call is strictly worse than an error a human looks at.

### 5. Discovery, so buyers can find deterministic settlement

The extension's `onManifestBuild` hook adds a capability entry to the A2A agent
card:

```json
{
  "uri": "https://docs.keeperhub.com/api/direct-execution",
  "params": {
    "settlingEntrypoints": ["settle"],
    "defaultChainId": "84532",
    "auditTrail": true, "dryRun": true, "idempotent": true
  }
}
```

A buying agent reading `/.well-known/agent-card.json` learns that this seller
settles deterministically and publishes an audit trail — without invoking
anything to find out. In an agent economy where sellers are chosen
programmatically, that is the difference between a claim and a discoverable
property.

## Install

```bash
npm install lucid-keeperhub
```

> **Pin zod to `4.4.3`.** `@lucid-agents/core@5` depends on exactly `zod@4.4.3`
> (a hard dependency, not a peer). Any other 4.x resolves a second copy under
> `@lucid-agents/core/node_modules`, and the two are nominally incompatible —
> every `addEntrypoint` schema then fails to typecheck with a confusing
> `$ZodCheck` mismatch. Add `"overrides": { "zod": "4.4.3" }` to your
> `package.json`.

A KeeperHub organization API key is required. Create one under **Settings >
Developer**. Broadcasting needs the `mcp:write` scope; a dry run works with
`mcp:read`, so a read-only key is a safe way to try this out.

```bash
export KEEPERHUB_API_KEY=kh_...
```

## API

### `keeperhub(options)`

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `$KEEPERHUB_API_KEY` | Organization API key. |
| `baseUrl` | `https://app.keeperhub.com` | Override for self-hosted. |
| `defaultChainId` | — | Chain used when a call omits one. |
| `advertise` | `true` | Publish the capability in the agent card. |
| `settlementDefaults` | — | `preflight`, `confirm`, `maxPolls`, `pollIntervalMs`. |
| `maxAttempts` | `4` | Attempts for retryable failures. |
| `timeoutMs` | `60000` | Per-request timeout. |

Ordered `after: ['payments', 'mpp']` — settlement is fulfillment, so it must
not run before payment admission has decided whether the invocation is entitled
to be fulfilled.

### `runtime.keeperhub`

| Method | Purpose |
| --- | --- |
| `settle(request, options)` | Preflight, broadcast, confirm. Pass `{ workId: runId }`. |
| `simulate(request, signal?)` | Dry run. Never signs. Safe under `mcp:read`. |
| `status(executionId)` | The stored execution — authoritative for a hash. |
| `spendCap()` | Daily native-value caps. |
| `settlingEntrypoints()` | Entrypoints that declared settlement. |
| `client` | The underlying `KeeperHubClient`. |

`settle` resolves rather than throwing for onchain failure — a reverted
transfer is an outcome to report to a buyer, not an exception. It throws only
for conditions no per-request handling can fix: bad credentials, insufficient
scope, unprovisioned wallet.

### Declaring settlement on an entrypoint

```ts
metadata: { keeperhub: { settles: true, chainId: 8453 } }
```

Validated at **build time**, not first invocation. An entrypoint that declares
settlement but can name no chain fails the build — discovering that after
taking a buyer's money is the expensive version.

## Run the example

A complete agent that sells settlement for x402 USDC and delivers it through
KeeperHub. Payments are optional, so it runs with a KeeperHub key alone.

```bash
npm install && npm run build
cd examples/settlement-agent
npm install
KEEPERHUB_API_KEY=kh_... node --experimental-strip-types src/index.ts
```

```bash
curl localhost:8787/.well-known/agent-card.json     # see the advertised capability
curl -X POST localhost:8787/entrypoints/quote/invoke \
  -H 'Content-Type: application/json' \
  -d '{"input":{"recipient":"0x...","amount":"0.001"}}'
```

Set `PAYMENTS_FACILITATOR_URL`, `PAYMENTS_RECEIVABLE_ADDRESS` and
`PAYMENTS_NETWORK` to price the `settle` entrypoint in x402 USDC.

## Run the demo

Settles for real and prints a block-explorer link, then replays the identical
call to show no second transaction is sent.

```bash
cp .env.example .env      # KEEPERHUB_API_KEY, DEMO_RECIPIENT
npm run demo
```

## Develop

```bash
npm install
npm run type-check
npm test          # 69 tests
npm run build
```

Tests run against the real `@lucid-agents/core` runtime rather than a stand-in:
the extension contract — slice conflicts, ordering, entrypoint hooks, manifest
composition — is enforced by Lucid's own builder, so a mock would prove nothing
about whether this actually installs.

## Limitations

Stated plainly, because they are the honest edges:

- **Transfers are the settled path.** `contractCall` is exposed on the client
  and typed, but `settle()` wraps transfers only. Arbitrary contract calls go
  through `runtime.keeperhub.client.contractCall` without the two-phase wrapper.
- **EVM only.** KeeperHub's Solana path exists; nothing here targets it.
- **Polling, not webhooks.** `settle` polls the status endpoint. KeeperHub
  workflows can call back; wiring that to a Lucid entrypoint is the obvious
  next step and is not done.
- **Scientific-notation amounts pass through uncanonicalized.** There is no
  single unambiguous decimal form to produce without arbitrary-precision
  arithmetic, so `1e-1` is left alone rather than guessed at. Send plain
  decimals.
- **The 24h replay window is the caller's problem for slow cadences.**
  `occurrenceMs` buckets keys for work recurring slower than a day, but you
  have to pass it.

## License

MIT
