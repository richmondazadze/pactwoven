import { BaseUnitsSchema } from '@pactwoven/contracts';
import { isSolanaJsonNumber, solanaIntegerText, solanaJsonArray, solanaJsonObject, solanaJsonString, solanaSmallInteger,
  type SolanaJsonObject, type SolanaJsonValue } from './lossless-json.js';
import { canonicalSolanaIdentity, decodeSolanaInstructionData } from './token-accounts.js';
import { rejectSolana, type SolanaCompiledInstruction, type SolanaHistoricalTokenBalance, type SolanaTransactionEvidence } from './types.js';

const key = (value: SolanaJsonValue | undefined) => canonicalSolanaIdentity(solanaJsonString(value, 44));
const keys = (value: SolanaJsonValue | undefined) => solanaJsonArray(value, 256).map(key);
function unique(values: readonly (string | number)[]): void {
  if (new Set(values).size !== values.length) rejectSolana('INVALID_SCHEMA');
}
export function solanaExecutionStatus(error: SolanaJsonValue | undefined): 'succeeded' | 'failed' {
  if (error === null) return 'succeeded';
  if (typeof error !== 'string' && (typeof error !== 'object' || error === undefined || Array.isArray(error) || isSolanaJsonNumber(error))) rejectSolana('INVALID_SCHEMA');
  return 'failed';
}
function tokenBalances(value: SolanaJsonValue | undefined, accountCount: number): readonly SolanaHistoricalTokenBalance[] | null {
  if (value === undefined || value === null) return null;
  const rows = solanaJsonArray(value, 256).map(entry => {
    const row = solanaJsonObject(entry, ['accountIndex', 'mint', 'owner', 'programId', 'uiTokenAmount'], ['accountIndex', 'mint', 'uiTokenAmount']);
    const amount = solanaJsonObject(row.uiTokenAmount, ['amount', 'decimals', 'uiAmount', 'uiAmountString'], ['amount', 'decimals']);
    let amountBaseUnits: string;
    try { amountBaseUnits = BaseUnitsSchema.parse(solanaJsonString(amount.amount, 20)); }
    catch { return rejectSolana('INVALID_INTEGER'); }
    if (amount.uiAmount !== undefined && amount.uiAmount !== null && !isSolanaJsonNumber(amount.uiAmount)) rejectSolana('INVALID_SCHEMA');
    if (amount.uiAmountString !== undefined) solanaJsonString(amount.uiAmountString, 128);
    return Object.freeze({ accountIndex: solanaSmallInteger(row.accountIndex, accountCount - 1), mint: key(row.mint),
      owner: row.owner === undefined ? null : key(row.owner), tokenProgram: row.programId === undefined ? null : key(row.programId),
      amountBaseUnits, decimals: solanaSmallInteger(amount.decimals, 255) });
  });
  unique(rows.map(row => row.accountIndex));
  return Object.freeze(rows);
}
function instruction(value: SolanaJsonValue, outer: number, inner: number | null, accountCount: number): SolanaCompiledInstruction {
  const item = solanaJsonObject(value, ['programIdIndex', 'accounts', 'data', 'stackHeight'], ['programIdIndex', 'accounts', 'data']);
  const stackHeight = item.stackHeight === undefined || item.stackHeight === null ? null : solanaSmallInteger(item.stackHeight, 64, 1);
  if (inner === null && stackHeight !== null && stackHeight !== 1) rejectSolana('INVALID_SCHEMA');
  return Object.freeze({ outerInstructionIndex: outer, innerInstructionOrdinal: inner,
    programIdIndex: solanaSmallInteger(item.programIdIndex, Math.min(255, accountCount - 1)),
    accountIndexes: Object.freeze(solanaJsonArray(item.accounts, 256).map(index => solanaSmallInteger(index, Math.min(255, accountCount - 1)))),
    dataHex: decodeSolanaInstructionData(solanaJsonString(item.data, 14_029), inner === null ? 1232 : 10_240), stackHeight });
}
function checkStatus(meta: SolanaJsonObject, status: 'succeeded' | 'failed'): void {
  if (meta.status === undefined) return;
  const value = solanaJsonObject(meta.status, ['Ok', 'Err'], []);
  if (Object.keys(value).length !== 1 || (status === 'succeeded' ? !Object.hasOwn(value, 'Ok') || value.Ok !== null
    : !Object.hasOwn(value, 'Err') || value.Err === null)) rejectSolana('INVALID_SCHEMA');
}

/** Structural RPC evidence only. This never establishes transfer or CPI success. */
export function decodeSolanaTransactionEvidence(value: SolanaJsonValue, expectedSignature: string): SolanaTransactionEvidence {
  canonicalSolanaIdentity(expectedSignature, 64);
  const result = solanaJsonObject(value, ['slot', 'blockTime', 'version', 'transaction', 'meta', 'transactionIndex'], ['slot', 'version', 'transaction']);
  // Optional provider metadata; it never establishes transfer or finality.
  if (result.transactionIndex !== undefined) solanaSmallInteger(result.transactionIndex, Number.MAX_SAFE_INTEGER);
  const version = result.version === 'legacy' ? 'legacy' : isSolanaJsonNumber(result.version) && result.version.lexeme === '0' ? 0 : rejectSolana('UNSUPPORTED_VERSION');
  const transaction = solanaJsonObject(result.transaction, ['signatures', 'message']);
  const signatures = solanaJsonArray(transaction.signatures, 255).map(signature => canonicalSolanaIdentity(solanaJsonString(signature, 88), 64));
  if (signatures.length < 1 || signatures[0] !== expectedSignature) rejectSolana('REQUEST_AFFINITY');
  unique(signatures);
  const message = solanaJsonObject(transaction.message, ['accountKeys', 'header', 'recentBlockhash', 'instructions', 'addressTableLookups'], ['accountKeys', 'header', 'recentBlockhash', 'instructions']);
  key(message.recentBlockhash);
  const staticAccountKeys = keys(message.accountKeys);
  if (staticAccountKeys.length < 1) rejectSolana('INVALID_SCHEMA');
  unique(staticAccountKeys);
  const header = solanaJsonObject(message.header, ['numRequiredSignatures', 'numReadonlySignedAccounts', 'numReadonlyUnsignedAccounts']);
  const signers = solanaSmallInteger(header.numRequiredSignatures, Math.min(255, staticAccountKeys.length), 1);
  if (signers !== signatures.length) rejectSolana('INVALID_SCHEMA');
  solanaSmallInteger(header.numReadonlySignedAccounts, signers - 1);
  solanaSmallInteger(header.numReadonlyUnsignedAccounts, staticAccountKeys.length - signers);
  let loadedWritableCount = 0, loadedReadonlyCount = 0;
  if (message.addressTableLookups !== undefined) {
    const lookups = solanaJsonArray(message.addressTableLookups, 256);
    if (version === 'legacy' && lookups.length) rejectSolana('INVALID_SCHEMA');
    const tableKeys: string[] = [];
    for (const entry of lookups) {
      const lookup = solanaJsonObject(entry, ['accountKey', 'writableIndexes', 'readonlyIndexes']);
      tableKeys.push(key(lookup.accountKey));
      const writable = solanaJsonArray(lookup.writableIndexes, 256).map(index => solanaSmallInteger(index, 255));
      const readonly = solanaJsonArray(lookup.readonlyIndexes, 256).map(index => solanaSmallInteger(index, 255));
      unique([...writable, ...readonly]);
      loadedWritableCount += writable.length; loadedReadonlyCount += readonly.length;
    }
    unique(tableKeys);
  } else if (version === 0) rejectSolana('INCOMPLETE_RESPONSE');
  const missing: string[] = [];
  const meta = result.meta === null || result.meta === undefined ? null : solanaJsonObject(result.meta,
    ['err', 'status', 'fee', 'preBalances', 'postBalances', 'innerInstructions', 'logMessages', 'preTokenBalances', 'postTokenBalances',
      'rewards', 'loadedAddresses', 'returnData', 'computeUnitsConsumed', 'costUnits'], ['err', 'fee', 'preBalances', 'postBalances']);
  const loaded = meta?.loadedAddresses === undefined ? null : solanaJsonObject(meta.loadedAddresses, ['writable', 'readonly']);
  if (version === 0 && !loaded) rejectSolana('INCOMPLETE_RESPONSE');
  const loadedWritable = loaded ? keys(loaded.writable) : [], loadedReadonly = loaded ? keys(loaded.readonly) : [];
  if (loadedWritable.length !== loadedWritableCount || loadedReadonly.length !== loadedReadonlyCount) rejectSolana('INVALID_SCHEMA');
  const resolvedAccountKeys = [...staticAccountKeys, ...loadedWritable, ...loadedReadonly];
  if (resolvedAccountKeys.length > 256) rejectSolana('INVALID_SCHEMA');
  unique(resolvedAccountKeys);
  const rawInstructions = solanaJsonArray(message.instructions, 65_535);
  const instructions = rawInstructions.map((entry, index) => instruction(entry, index, null, resolvedAccountKeys.length));
  let innerInstructions: SolanaCompiledInstruction[] | null = null;
  if (meta?.innerInstructions !== undefined && meta.innerInstructions !== null) {
    innerInstructions = [];
    const outerIndexes: number[] = [];
    for (const entry of solanaJsonArray(meta.innerInstructions, instructions.length)) {
      const group = solanaJsonObject(entry, ['index', 'instructions']);
      const outer = solanaSmallInteger(group.index, instructions.length - 1);
      outerIndexes.push(outer);
      solanaJsonArray(group.instructions, 65_535).forEach((inner, ordinal) => innerInstructions!.push(instruction(inner, outer, ordinal, resolvedAccountKeys.length)));
    }
    unique(outerIndexes);
  } else missing.push('innerInstructions');
  const logMessages = meta?.logMessages === undefined || meta.logMessages === null ? null
    : Object.freeze(solanaJsonArray(meta.logMessages, 4096).map(line => solanaJsonString(line, 16_384)));
  if (logMessages === null) missing.push('logMessages');
  const preTokenBalances = tokenBalances(meta?.preTokenBalances, resolvedAccountKeys.length);
  const postTokenBalances = tokenBalances(meta?.postTokenBalances, resolvedAccountKeys.length);
  if (preTokenBalances === null) missing.push('preTokenBalances');
  if (postTokenBalances === null) missing.push('postTokenBalances');
  let transactionStatus: 'succeeded' | 'failed' | 'unknown' = 'unknown', feeLamports: string | null = null;
  if (meta) {
    transactionStatus = solanaExecutionStatus(meta.err); checkStatus(meta, transactionStatus);
    feeLamports = solanaIntegerText(meta.fee);
    for (const name of ['preBalances', 'postBalances'] as const) {
      const balances = solanaJsonArray(meta[name], 256);
      if (balances.length !== resolvedAccountKeys.length) rejectSolana('INVALID_SCHEMA');
      balances.forEach(balance => solanaIntegerText(balance));
    }
    for (const name of ['computeUnitsConsumed', 'costUnits'] as const) if (meta[name] !== undefined) solanaIntegerText(meta[name]);
  } else missing.push('meta');
  return Object.freeze({ version, slot: solanaIntegerText(result.slot),
    blockTime: result.blockTime === undefined || result.blockTime === null ? null : solanaIntegerText(result.blockTime, true),
    signature: expectedSignature, staticAccountKeys: Object.freeze(staticAccountKeys), loadedWritable: Object.freeze(loadedWritable),
    loadedReadonly: Object.freeze(loadedReadonly), resolvedAccountKeys: Object.freeze(resolvedAccountKeys), instructions: Object.freeze(instructions),
    innerInstructions: innerInstructions === null ? null : Object.freeze(innerInstructions), transactionStatus, feeLamports,
    logMessages, preTokenBalances, postTokenBalances, missingMetadata: Object.freeze(missing) });
}
