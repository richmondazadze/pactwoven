import type { FinanceProvenanceAppend } from '@pactwoven/contracts';

export const SOLANA_RPC_MAX_BYTES = 131_072;
export const SOLANA_JSON_MAX_DEPTH = 64;
export const SOLANA_JSON_MAX_TOKENS = 16_384;
export type SolanaDecodeCode = 'SIZE_LIMIT' | 'INVALID_UTF8' | 'INVALID_JSON' | 'DEPTH_LIMIT' | 'NODE_LIMIT'
  | 'DUPLICATE_KEY' | 'INVALID_SCHEMA' | 'INVALID_INTEGER' | 'INVALID_IDENTITY' | 'INVALID_ENCODING'
  | 'INVALID_LAYOUT' | 'UNSUPPORTED_ASSET' | 'UNSUPPORTED_VERSION' | 'REQUEST_AFFINITY' | 'GENESIS_MISMATCH' | 'INCOMPLETE_RESPONSE';
export class SolanaDecodeError extends Error {
  constructor(readonly code: SolanaDecodeCode) { super(`Solana evidence rejected: ${code}.`); this.name = 'SolanaDecodeError'; }
}
export function rejectSolana(code: SolanaDecodeCode): never { throw new SolanaDecodeError(code); }

export type SolanaReadCommand =
  | Readonly<{ method: 'getGenesisHash' }>
  | Readonly<{ method: 'getAccountInfo'; address: string; minContextSlot?: string }>
  | Readonly<{ method: 'getMultipleAccounts'; addresses: readonly string[]; minContextSlot?: string }>
  | Readonly<{ method: 'getTransaction'; signature: string }>
  | Readonly<{ method: 'getSignatureStatuses'; signatures: readonly string[] }>;
export type PreparedSolanaRead = Readonly<{ id: string; method: SolanaReadCommand['method']; payload: string }>;
export type SolanaRpcContext = Readonly<{ slot: string; apiVersion: string | null }>;
export type SolanaRpcAccount = Readonly<{
  address: string; owner: string; executable: boolean; lamports: string; rentEpoch: string;
  space: string | null; dataHex: string;
}>;
export type SolanaCompiledInstruction = Readonly<{
  outerInstructionIndex: number; innerInstructionOrdinal: number | null; programIdIndex: number;
  accountIndexes: readonly number[]; dataHex: string; stackHeight: number | null;
}>;
export type SolanaHistoricalTokenBalance = Readonly<{
  accountIndex: number; mint: string; owner: string | null; tokenProgram: string | null;
  amountBaseUnits: string; decimals: number;
}>;
export type SolanaTransactionEvidence = Readonly<{
  version: 'legacy' | 0; slot: string; blockTime: string | null; signature: string;
  staticAccountKeys: readonly string[]; loadedWritable: readonly string[]; loadedReadonly: readonly string[];
  resolvedAccountKeys: readonly string[]; instructions: readonly SolanaCompiledInstruction[];
  innerInstructions: readonly SolanaCompiledInstruction[] | null;
  transactionStatus: 'succeeded' | 'failed' | 'unknown'; feeLamports: string | null;
  logMessages: readonly string[] | null;
  preTokenBalances: readonly SolanaHistoricalTokenBalance[] | null;
  postTokenBalances: readonly SolanaHistoricalTokenBalance[] | null;
  missingMetadata: readonly string[];
}>;
export type SolanaSignatureStatus = Readonly<{
  signature: string; slot: string; confirmations: string | null;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  transactionStatus: 'succeeded' | 'failed';
}>;
export type SolanaReadData =
  | Readonly<{ method: 'getGenesisHash'; genesis: string }>
  | Readonly<{ method: 'getAccountInfo'; context: SolanaRpcContext; account: SolanaRpcAccount | null }>
  | Readonly<{ method: 'getMultipleAccounts'; context: SolanaRpcContext; accounts: readonly (SolanaRpcAccount | null)[] }>
  | Readonly<{ method: 'getTransaction'; transaction: SolanaTransactionEvidence }>
  | Readonly<{ method: 'getSignatureStatuses'; context: SolanaRpcContext; statuses: readonly (SolanaSignatureStatus | null)[] }>;
export type SolanaReadOutcome =
  | Readonly<{ kind: 'decoded'; data: SolanaReadData }>
  | Readonly<{ kind: 'incomplete'; data: SolanaReadData; reasons: readonly string[] }>
  | Readonly<{ kind: 'unavailable'; reason: 'null-result' }>
  | Readonly<{ kind: 'rpc-error'; code: string }>
  | Readonly<{ kind: 'rejected'; code: SolanaDecodeCode }>;
export type SolanaReadEvidence = Readonly<{
  request: PreparedSolanaRead;
  evidence: Readonly<FinanceProvenanceAppend['evidence'] & { payloadHex: string; byteLength: number }> | null;
  outcome: SolanaReadOutcome;
}>;
export type SolanaOriginalMint = Readonly<{
  kind: 'original-mint-layout'; address: string; mintAuthority: string | null; freezeAuthority: string | null;
  supplyBaseUnits: string; decimals: 6; initialized: boolean;
}>;
export type SolanaOriginalTokenAccount = Readonly<{
  kind: 'original-token-account-layout'; address: string; mint: string; authority: string; amountBaseUnits: string;
  state: 'uninitialized' | 'initialized' | 'frozen'; delegate: string | null; delegatedAmountBaseUnits: string;
  nativeReserveBaseUnits: string | null; closeAuthority: string | null;
}>;
