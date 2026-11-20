import { BaseUnitsSchema, FINANCE_DEVNET_ASSET } from '@pactwoven/contracts';
import { provenanceHex } from '@pactwoven/domain';
import { parseSolanaJson, solanaIntegerText, solanaJsonArray, solanaJsonObject, solanaJsonString,
  type SolanaJsonObject, type SolanaJsonValue } from './lossless-json.js';
import { canonicalSolanaIdentity, decodeSolanaBase64 } from './token-accounts.js';
import { decodeSolanaTransactionEvidence, solanaExecutionStatus } from './transaction-evidence.js';
import { SOLANA_RPC_MAX_BYTES, SolanaDecodeError, rejectSolana, type PreparedSolanaRead, type SolanaReadCommand,
  type SolanaReadData, type SolanaReadEvidence, type SolanaReadOutcome, type SolanaRpcAccount, type SolanaRpcContext,
  type SolanaSignatureStatus } from './types.js';

const prepared = new WeakMap<PreparedSolanaRead, SolanaReadCommand>();
const idPattern = /^[A-Za-z0-9._:-]{1,64}$/;
function exactKeys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) rejectSolana('REQUEST_AFFINITY');
}
function minimumSlot(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try { return BaseUnitsSchema.parse(value); } catch { return rejectSolana('INVALID_INTEGER'); }
}
function idList(values: readonly string[], limit: number, size: 32 | 64): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > limit) rejectSolana('REQUEST_AFFINITY');
  const copied = values.map(value => canonicalSolanaIdentity(value, size));
  if (new Set(copied).size !== copied.length) rejectSolana('REQUEST_AFFINITY');
  return Object.freeze(copied);
}
/** Creates inert request bytes, not a client. There is no generic method, URL or transport argument. */
export function prepareSolanaRead(id: string, input: SolanaReadCommand): PreparedSolanaRead {
  if (typeof id !== 'string' || !idPattern.test(id) || typeof input !== 'object' || input === null) rejectSolana('REQUEST_AFFINITY');
  let copied: SolanaReadCommand;
  try { copied = structuredClone(input); } catch { return rejectSolana('REQUEST_AFFINITY'); }
  let command: SolanaReadCommand, params: string;
  switch (copied.method) {
    case 'getGenesisHash':
      exactKeys(copied, ['method']); command = Object.freeze({ method: copied.method }); params = '[]'; break;
    case 'getAccountInfo': {
      exactKeys(copied, ['method', 'address', 'minContextSlot']);
      const address = canonicalSolanaIdentity(copied.address), slot = minimumSlot(copied.minContextSlot);
      command = Object.freeze({ method: copied.method, address, ...(slot === undefined ? {} : { minContextSlot: slot }) });
      params = `[${JSON.stringify(address)},{"encoding":"base64","commitment":"finalized"${slot === undefined ? '' : `,"minContextSlot":${slot}`}}]`; break;
    }
    case 'getMultipleAccounts': {
      exactKeys(copied, ['method', 'addresses', 'minContextSlot']);
      const addresses = idList(copied.addresses, 8, 32), slot = minimumSlot(copied.minContextSlot);
      command = Object.freeze({ method: copied.method, addresses, ...(slot === undefined ? {} : { minContextSlot: slot }) });
      params = `[${JSON.stringify(addresses)},{"encoding":"base64","commitment":"finalized"${slot === undefined ? '' : `,"minContextSlot":${slot}`}}]`; break;
    }
    case 'getTransaction': {
      exactKeys(copied, ['method', 'signature']); const signature = canonicalSolanaIdentity(copied.signature, 64);
      command = Object.freeze({ method: copied.method, signature });
      params = `[${JSON.stringify(signature)},{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}]`; break;
    }
    case 'getSignatureStatuses': {
      exactKeys(copied, ['method', 'signatures']); const signatures = idList(copied.signatures, 32, 64);
      command = Object.freeze({ method: copied.method, signatures });
      params = `[${JSON.stringify(signatures)},{"searchTransactionHistory":true}]`; break;
    }
    default: return rejectSolana('REQUEST_AFFINITY');
  }
  const request = Object.freeze({ id, method: command.method, payload: `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(command.method)},"params":${params}}` });
  prepared.set(request, command); return request;
}
function context(value: SolanaJsonValue | undefined, minSlot?: string): SolanaRpcContext {
  const item = solanaJsonObject(value, ['slot', 'apiVersion'], ['slot']);
  const slot = solanaIntegerText(item.slot);
  if (minSlot !== undefined && BigInt(slot) < BigInt(minSlot)) rejectSolana('INCOMPLETE_RESPONSE');
  return Object.freeze({ slot, apiVersion: item.apiVersion === undefined ? null : solanaJsonString(item.apiVersion, 64) });
}
function account(value: SolanaJsonValue, address: string): SolanaRpcAccount | null {
  if (value === null) return null;
  const item = solanaJsonObject(value, ['data', 'owner', 'executable', 'lamports', 'rentEpoch', 'space'], ['data', 'owner', 'executable', 'lamports', 'rentEpoch']);
  const data = solanaJsonArray(item.data, 2);
  if (data.length !== 2 || data[1] !== 'base64' || typeof item.executable !== 'boolean') rejectSolana('INVALID_SCHEMA');
  const dataHex = decodeSolanaBase64(solanaJsonString(data[0], 174_764));
  const space = item.space === undefined ? null : solanaIntegerText(item.space);
  if (space !== null && BigInt(space) !== BigInt(dataHex.length / 2)) rejectSolana('INVALID_LAYOUT');
  return Object.freeze({ address, owner: canonicalSolanaIdentity(solanaJsonString(item.owner, 44)), executable: item.executable,
    lamports: solanaIntegerText(item.lamports), rentEpoch: solanaIntegerText(item.rentEpoch), space, dataHex });
}
function signatureStatus(value: SolanaJsonValue, signature: string): SolanaSignatureStatus | null {
  if (value === null) return null;
  const item = solanaJsonObject(value, ['slot', 'confirmations', 'err', 'status', 'confirmationStatus'], ['slot', 'confirmations', 'err']);
  const transactionStatus = solanaExecutionStatus(item.err);
  if (item.status !== undefined) {
    const status = solanaJsonObject(item.status, ['Ok', 'Err'], []);
    if (Object.keys(status).length !== 1 || (transactionStatus === 'succeeded' ? !Object.hasOwn(status, 'Ok') || status.Ok !== null
      : !Object.hasOwn(status, 'Err') || status.Err === null)) rejectSolana('INVALID_SCHEMA');
  }
  const confirmationStatus = item.confirmationStatus ?? null;
  if (confirmationStatus !== null && !['processed', 'confirmed', 'finalized'].includes(confirmationStatus as string)) rejectSolana('INVALID_SCHEMA');
  return Object.freeze({ signature, slot: solanaIntegerText(item.slot),
    confirmations: item.confirmations === null ? null : solanaIntegerText(item.confirmations),
    confirmationStatus: confirmationStatus as SolanaSignatureStatus['confirmationStatus'], transactionStatus });
}
function decoded(data: SolanaReadData, reasons: readonly string[] = []): SolanaReadOutcome {
  return reasons.length ? Object.freeze({ kind: 'incomplete', data, reasons: Object.freeze([...reasons]) }) : Object.freeze({ kind: 'decoded', data });
}
function responseOutcome(request: PreparedSolanaRead, command: SolanaReadCommand, body: SolanaJsonValue): SolanaReadOutcome {
  const envelope = solanaJsonObject(body, ['jsonrpc', 'id', 'result', 'error'], ['jsonrpc', 'id']);
  if (envelope.jsonrpc !== '2.0' || envelope.id !== request.id) rejectSolana('REQUEST_AFFINITY');
  if (Object.hasOwn(envelope, 'result') === Object.hasOwn(envelope, 'error')) rejectSolana('INVALID_SCHEMA');
  if (Object.hasOwn(envelope, 'error')) {
    const error = solanaJsonObject(envelope.error, ['code', 'message', 'data'], ['code', 'message']);
    const code = solanaIntegerText(error.code, true);
    if (BigInt(code) < -2_147_483_648n || BigInt(code) > 2_147_483_647n) rejectSolana('INVALID_INTEGER');
    solanaJsonString(error.message, 4096);
    return Object.freeze({ kind: 'rpc-error', code });
  }
  const value = envelope.result!;
  if (value === null) return Object.freeze({ kind: 'unavailable', reason: 'null-result' });
  switch (command.method) {
    case 'getGenesisHash': {
      const genesis = canonicalSolanaIdentity(solanaJsonString(value, 44));
      if (genesis !== FINANCE_DEVNET_ASSET.genesis) rejectSolana('GENESIS_MISMATCH');
      return decoded(Object.freeze({ method: command.method, genesis }));
    }
    case 'getAccountInfo': {
      const result = solanaJsonObject(value, ['context', 'value']);
      const observed = account(result.value!, command.address);
      return decoded(Object.freeze({ method: command.method, context: context(result.context, command.minContextSlot), account: observed }), observed === null ? ['account-unavailable'] : []);
    }
    case 'getMultipleAccounts': {
      const result = solanaJsonObject(value, ['context', 'value']), values = solanaJsonArray(result.value, 8);
      if (values.length !== command.addresses.length) rejectSolana('REQUEST_AFFINITY');
      const accounts = Object.freeze(values.map((item, index) => account(item, command.addresses[index]!)));
      return decoded(Object.freeze({ method: command.method, context: context(result.context, command.minContextSlot), accounts }), accounts.some(item => item === null) ? ['account-unavailable'] : []);
    }
    case 'getTransaction': {
      const transaction = decodeSolanaTransactionEvidence(value, command.signature);
      return decoded(Object.freeze({ method: command.method, transaction }), transaction.missingMetadata);
    }
    case 'getSignatureStatuses': {
      const result = solanaJsonObject(value, ['context', 'value']), values = solanaJsonArray(result.value, 32);
      if (values.length !== command.signatures.length) rejectSolana('REQUEST_AFFINITY');
      const statuses = Object.freeze(values.map((item, index) => signatureStatus(item, command.signatures[index]!)));
      return decoded(Object.freeze({ method: command.method, context: context(result.context), statuses }),
        statuses.some(item => item === null || item.confirmationStatus === null) ? ['signature-status-incomplete'] : []);
    }
  }
}
/** Copies all mutable bytes before hashing. No caller byte buffer survives into the async continuation. */
export async function decodeSolanaReadResponse(request: PreparedSolanaRead, input: Uint8Array, evidenceReference: string): Promise<SolanaReadEvidence> {
  const command = prepared.get(request);
  if (!command || typeof evidenceReference !== 'string' || evidenceReference.length < 1 || evidenceReference.length > 512) rejectSolana('REQUEST_AFFINITY');
  if (!(input instanceof Uint8Array) || input.byteLength > SOLANA_RPC_MAX_BYTES) {
    return Object.freeze({ request, evidence: null, outcome: Object.freeze({ kind: 'rejected', code: 'SIZE_LIMIT' }) });
  }
  const snapshot = new Uint8Array(input), payloadHex = provenanceHex(snapshot);
  let outcome: SolanaReadOutcome;
  try { outcome = responseOutcome(request, command, parseSolanaJson(snapshot)); }
  catch (error) { outcome = Object.freeze({ kind: 'rejected', code: error instanceof SolanaDecodeError ? error.code : 'INVALID_SCHEMA' }); }
  const sha256 = provenanceHex(new Uint8Array(await crypto.subtle.digest('SHA-256', snapshot)));
  return Object.freeze({ request, evidence: Object.freeze({ reference: evidenceReference, sha256, payloadHex, byteLength: snapshot.length }), outcome });
}
