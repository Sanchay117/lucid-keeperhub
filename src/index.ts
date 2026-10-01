/**
 * lucid-keeperhub -- deterministic onchain settlement for Lucid Agents.
 *
 * @see https://github.com/daydreamsai/lucid-agents
 * @see https://docs.keeperhub.com/api/direct-execution
 */

export {
  keeperhub,
  KEEPERHUB_EXTENSION_URI,
  type EntrypointSettlementConfig,
  type KeeperHubExtensionOptions,
  type KeeperHubSettleOptions,
  type KeeperHubSlice,
} from "./extension.js";

export {
  idempotencyKeyOf,
  resolveWorkId,
  type InvocationContext,
  type ResolvedWorkId,
  type WorkIdSource,
} from "./work-id.js";

export { KeeperHubClient, type ExecuteOptions, type KeeperHubClientOptions } from "./client.js";

export {
  KeeperHubSettlementError,
  settleTransfer,
  type SettleOptions,
  type SettlementOutcome,
} from "./settle.js";

export {
  classifyError,
  KeeperHubError,
  type KeeperHubErrorBody,
  type KeeperHubFailureKind,
} from "./errors.js";

export {
  canonicalizeAddress,
  canonicalizeAmount,
  canonicalizeBody,
  deriveIdempotencyKey,
  type IdempotencyKeyInput,
} from "./idempotency.js";

export type {
  ContractCallRequest,
  ExecutionResult,
  ExecutionStatus,
  ExecutionStatusResult,
  SimulationResult,
  SpendCapResult,
  TransferRequest,
} from "./types.js";
