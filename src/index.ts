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
  type KeeperHubSlice,
} from "./extension.js";

export { KeeperHubClient, type ExecuteOptions, type KeeperHubClientOptions } from "./client.js";

export {
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
