import { createHash } from 'node:crypto';
import { BaseUnitsSchema } from '../../../packages/contracts/src/core.js';
import { SolanaPublicKeySchema, SolanaSignatureSchema } from '../../../packages/contracts/src/finance-provenance.js';
import { parseSolanaJson, solanaJsonObject, solanaJsonArray, solanaJsonString, solanaIntegerText } from '../../../packages/adapters/src/solana/lossless-json.js';
import { SOLANA_RPC_MAX_BYTES } from '../../../packages/adapters/src/solana/types.js';
import { buildPaidTransferMessage, validatePaidTransferIntent, verifiedPaidTransferIntent, type PaidTransferIntent, type VerifiedPaidTransferWire } from './solana-transfer.js';

export type PaidToolRpcCommand = { method: 'getLatestBlockhash' | 'getBlockHeight'; minimumSlot: string } |
  { method: 'getFeeForMessage'; intent: PaidTransferIntent } |
  { method: 'simulateTransaction' | 'sendTransaction'; wire: VerifiedPaidTransferWire };
export type PreparedPaidToolRpc = Readonly<{ id: string; method: PaidToolRpcCommand['method']; payload: string; effect: 'read' | 'broadcast' }>;
type Affinity = { method: PaidToolRpcCommand['method']; minimumSlot: string; signature?: string; maximumFeeLamports?: string };
const prepared = new WeakMap<PreparedPaidToolRpc, Affinity>();
export class PaidToolRpcError extends Error {
  constructor(readonly code: 'REQUEST_INVALID' | 'RESPONSE_INVALID' | 'RPC_ERROR' | 'NOT_READY' | 'SIMULATION_FAILED' | 'FEE_EXCEEDED') {
    super(`Paid-tool RPC evidence rejected: ${code}`); this.name = 'PaidToolRpcError';
  }
}
function assert(value: unknown, code: PaidToolRpcError['code'] = 'RESPONSE_INVALID'): void { if (!value) throw new PaidToolRpcError(code); }
/** Inert request bytes only: no endpoint, fetch, key or signing method exists.
 * Preparing broadcast bytes does not authorize their transmission. A private
 * caller must recheck the recorded dispatch permit immediately before send. */
export function preparePaidToolRpc(id: string, command: PaidToolRpcCommand): PreparedPaidToolRpc {
  assert(typeof id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(id), 'REQUEST_INVALID');
  let params: string, affinity: Affinity;
  switch (command.method) {
    case 'getLatestBlockhash':
    case 'getBlockHeight': {
      assert(Object.keys(command).sort().join(',') === 'method,minimumSlot', 'REQUEST_INVALID');
      const minimumSlot = BaseUnitsSchema.parse(command.minimumSlot);
      affinity = { method: command.method, minimumSlot }; params = `[{"commitment":"finalized","minContextSlot":${minimumSlot}}]`; break;
    }
    case 'getFeeForMessage': {
      assert(Object.keys(command).sort().join(',') === 'intent,method', 'REQUEST_INVALID');
      const intent = validatePaidTransferIntent(command.intent), message = buildPaidTransferMessage(intent);
      affinity = { method: command.method, minimumSlot: intent.minimumAccountSlot, maximumFeeLamports: intent.maximumFeeLamports };
      params = `[${JSON.stringify(message.messageBase64)},{"commitment":"finalized","minContextSlot":${intent.minimumAccountSlot}}]`; break;
    }
    case 'simulateTransaction':
    case 'sendTransaction': {
      assert(Object.keys(command).sort().join(',') === 'method,wire', 'REQUEST_INVALID');
      const intent = verifiedPaidTransferIntent(command.wire);
      affinity = { method: command.method, minimumSlot: intent.minimumAccountSlot, signature: command.wire.signature };
      const settings = command.method === 'simulateTransaction'
        ? `"sigVerify":true,"replaceRecentBlockhash":false,"commitment":"finalized"`
        : `"skipPreflight":false,"preflightCommitment":"finalized","maxRetries":0`;
      params = `[${JSON.stringify(command.wire.wireBase64)},{"encoding":"base64",${settings},"minContextSlot":${intent.minimumAccountSlot}}]`; break;
    }
    default: throw new PaidToolRpcError('REQUEST_INVALID');
  }
  const request = Object.freeze({ id, method: command.method, payload: `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(command.method)},"params":${params}}`, effect: command.method === 'sendTransaction' ? 'broadcast' as const : 'read' as const });
  prepared.set(request, affinity); return request;
}
/** Raw bytes are bounded and losslessly parsed; duplicate keys, mismatched IDs,
 * replaced blockhashes and apparent-but-unconfirmed signatures are refused.
 * Returned send acknowledgement is never a finalized-payment result. */
export function decodePaidToolRpc(request: PreparedPaidToolRpc, bytesInput: Uint8Array, evidenceRef: string) {
  const affinity = prepared.get(request); assert(affinity && typeof evidenceRef === 'string' && evidenceRef.length > 0 && evidenceRef.length <= 512, 'REQUEST_INVALID');
  assert(bytesInput instanceof Uint8Array && bytesInput.length <= SOLANA_RPC_MAX_BYTES);
  const bytes = Buffer.from(bytesInput), envelope = solanaJsonObject(parseSolanaJson(bytes), ['jsonrpc', 'id', 'result', 'error'], ['jsonrpc', 'id']);
  assert(envelope.jsonrpc === '2.0' && envelope.id === request.id && Object.hasOwn(envelope, 'result') !== Object.hasOwn(envelope, 'error'));
  if (Object.hasOwn(envelope, 'error')) { const error = solanaJsonObject(envelope.error, ['code', 'message', 'data'], ['code', 'message']); solanaIntegerText(error.code, true); solanaJsonString(error.message, 4096); throw new PaidToolRpcError('RPC_ERROR'); }
  assert(envelope.result !== null, 'NOT_READY');
  const evidence = { reference: evidenceRef, sha256: createHash('sha256').update(bytes).digest('hex'), payloadHex: bytes.toString('hex') };
  const contextual = () => {
    const result = solanaJsonObject(envelope.result, ['context', 'value']), context = solanaJsonObject(result.context, ['slot', 'apiVersion'], ['slot']);
    const slot = solanaIntegerText(context.slot); assert(BigInt(slot) >= BigInt(affinity!.minimumSlot), 'NOT_READY');
    if (context.apiVersion !== undefined) solanaJsonString(context.apiVersion, 64);
    return { result, slot };
  };
  switch (affinity!.method) {
    case 'getLatestBlockhash': {
      const { result, slot } = contextual(), value = solanaJsonObject(result.value, ['blockhash', 'lastValidBlockHeight']);
      const blockhash = SolanaPublicKeySchema.parse(solanaJsonString(value.blockhash, 44));
      return Object.freeze({ method: 'getLatestBlockhash' as const, slot, blockhash, lastValidBlockHeight: solanaIntegerText(value.lastValidBlockHeight), evidence });
    }
    case 'getBlockHeight': return Object.freeze({ method: 'getBlockHeight' as const, blockHeight: solanaIntegerText(envelope.result), evidence });
    case 'getFeeForMessage': {
      const { result, slot } = contextual(); assert(result.value !== null, 'NOT_READY'); const feeLamports = solanaIntegerText(result.value);
      assert(BigInt(feeLamports) > 0n && BigInt(feeLamports) <= BigInt(affinity!.maximumFeeLamports!), 'FEE_EXCEEDED');
      return Object.freeze({ method: 'getFeeForMessage' as const, slot, feeLamports, evidence });
    }
    case 'simulateTransaction': {
      const { result, slot } = contextual(), value = solanaJsonObject(result.value,
        ['err', 'logs', 'accounts', 'unitsConsumed', 'returnData', 'innerInstructions', 'replacementBlockhash', 'loadedAccountsDataSize', 'fee', 'preBalances', 'postBalances', 'preTokenBalances', 'postTokenBalances'], ['err']);
      assert(value.err === null, 'SIMULATION_FAILED'); assert(value.replacementBlockhash === undefined || value.replacementBlockhash === null);
      if (value.logs !== undefined && value.logs !== null) for (const log of solanaJsonArray(value.logs, 256)) solanaJsonString(log, 4096);
      if (value.unitsConsumed !== undefined) solanaIntegerText(value.unitsConsumed);
      assert(value.accounts === undefined || value.accounts === null); // No unrequested account snapshots.
      return Object.freeze({ method: 'simulateTransaction' as const, slot, signature: affinity!.signature!, simulated: true as const, finalized: false as const, evidence });
    }
    case 'sendTransaction': {
      const signature = SolanaSignatureSchema.parse(solanaJsonString(envelope.result, 88)); assert(signature === affinity!.signature);
      return Object.freeze({ method: 'sendTransaction' as const, signature, disposition: 'acknowledged_not_finalized' as const, evidence });
    }
  }
}
