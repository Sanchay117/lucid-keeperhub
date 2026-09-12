/** Shared request and response shapes for the KeeperHub Direct Execution API. */

/** Terminal-ish status an execution can report. */
export type ExecutionStatus =
  | "completed"
  | "failed"
  | "unconfirmed"
  | "pending"
  | "simulated";

/** A broadcast execution, as returned by the execute endpoints (HTTP 202). */
export type ExecutionResult = {
  executionId: string;
  status: ExecutionStatus;
  /**
   * Present only when the step reported success. A `failed` or `unconfirmed`
   * response carries neither hash nor link even when a transaction really was
   * broadcast -- recover those from `getStatus`, which reads the stored
   * execution rather than the step result.
   */
  transactionHash?: string;
  transactionLink?: string;
  /**
   * Set by KeeperHub only on a replayed response. Its absence means "this
   * outcome just happened"; its presence means no new transaction was sent.
   */
  idempotentReplay?: boolean;
};

/** A dry run. No row is written, no funds reserved, no hash produced. */
export type SimulationResult = {
  success: true;
  status: "simulated";
  /** The org wallet KeeperHub would send from. */
  from: string;
  /** Low-level call target -- for an ERC-20 transfer this is the token, not the recipient. */
  to: string;
  /** Native value in wei. */
  value: string;
  /** Estimated gas units, decimal string. */
  gasEstimate: string;
  simulatedReturnValue: unknown;
  wouldRevert: false;
};

/** Full stored execution record. */
export type ExecutionStatusResult = {
  executionId: string;
  status: ExecutionStatus;
  type: string;
  network: string;
  transactionHash?: string | null;
  transactionLink?: string | null;
  /**
   * A sponsored execution is broadcast through a relayer or smart account, so
   * it never touches the org EOA's nonce or balance and will not show up in a
   * block explorer's `txlist` for that address. When this is true, the hash is
   * the only authoritative proof -- checking EOA state concludes, wrongly,
   * that nothing happened.
   */
  sponsored?: boolean;
  retryCount?: number;
  receipts?: Array<{
    hash: string;
    chainId: number;
    verified: boolean;
    receiptStatus: "success" | "reverted" | string;
    blockNumber: number;
    gasUsed: string;
    verifiedAt: string;
  }>;
  gasUsedWei?: string | null;
  gasPriceWei?: string | null;
  estimatedCostUsd?: number | null;
  result?: unknown;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
};

/** `POST /api/execute/transfer` */
export type TransferRequest = {
  /** Numeric chain id. The legacy `network` alias is deprecated; we never send it. */
  chainId: number | string;
  recipientAddress: string;
  /** Human-readable units, e.g. "0.1" for 0.1 ETH. Not wei. */
  amount: string;
  /** ERC-20 contract. Omit for a native transfer. */
  tokenAddress?: string;
  /** JSON string of `{decimals, symbol}` for non-standard tokens. */
  tokenConfig?: string;
  gasLimitMultiplier?: string;
};

/** `POST /api/execute/contract-call` */
export type ContractCallRequest = {
  contractAddress: string;
  chainId: number | string;
  functionName: string;
  /** JSON-encoded array of arguments. */
  functionArgs?: string;
  /** JSON-encoded ABI. */
  abi?: string;
  /** Native value to attach, in ether units. */
  value?: string;
  gasLimitMultiplier?: string;
};

/** Daily native-value spending caps, from `GET /api/analytics/spend-cap`. */
export type SpendCapResult = {
  /** What enforcement actually uses. A null `dailyCapWei` means unconfigured, not unbounded. */
  effectiveDailyCapWei?: string | null;
  effectiveDailySolanaCapLamports?: string | null;
  dailyCapWei?: string | null;
  spentTodayWei?: string | null;
  [key: string]: unknown;
};
