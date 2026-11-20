import { createPublicKey, verify } from 'node:crypto';
import { base58, publicKeyBytes } from '../independent-layout.js';
import { CAPS, RPC_URL, check, durableWrite, evidenceJson, fixturePath, key, record, sha256, string,
  type FixtureId } from './manifest.js';

export function losslessParse(text: string): unknown {
  let supported = false;
  const parse = JSON.parse as (text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown) => unknown;
  parse('9007199254740993', (_, value, context) => { supported = context?.source === '9007199254740993'; return value; });
  check(supported, 'Lossless native JSON unavailable');
  return parse(text, (_, value, context) => {
    if (typeof value !== 'number') return value;
    const source = context.source;
    check(typeof source === 'string', 'Missing numeric token');
    if (/^-?(0|[1-9][0-9]*)$/.test(source)) return BigInt(source);
    check(Number.isFinite(value), 'Nonfinite JSON number');
    return value;
  });
}
export function losslessStringify(input: unknown): string {
  const raw = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
  check(raw, 'Native raw JSON unavailable');
  return JSON.stringify(input, (_, v: unknown) => typeof v === 'bigint' ? raw(v.toString()) : v);
}
export function u64(input: unknown): bigint {
  check(typeof input === 'bigint' || (typeof input === 'string' && /^(0|[1-9][0-9]*)$/.test(input)), 'Expected lossless unsigned integer');
  const n = BigInt(input); check(n >= 0n && n <= (1n << 64n) - 1n, 'Integer outside u64'); return n;
}
export function fromBase64(input: unknown, max: number = CAPS.responseBytes): Buffer {
  const value = string(input);
  check(value.length <= Math.ceil(max / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'Invalid/bounded base64');
  const bytes = Buffer.from(value, 'base64');
  check(bytes.length <= max && bytes.toString('base64') === value, 'Noncanonical base64'); return bytes;
}
export function verifyEd25519(publicBytes: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  check(publicBytes.length === 32 && signature.length === 64, 'Wrong signature/key width');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes]);
  return verify(null, message, createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature);
}
export interface WireIdentity {
  wireBase64: string; messageBase64: string; wireSha256: string; messageSha256: string; signature: string;
  signerAddresses: string[]; blockhash: string; instructions: { program: string; accounts: string[]; dataHex: string }[];
}
// Independent legacy parser: deliberately does not reuse Kit's encoder or transaction decoder.
export function inspectWire(wire: Uint8Array, verifySignatures = true): WireIdentity {
  check(wire.length > 0 && wire.length <= CAPS.wireBytes, 'Wire exceeds packet cap');
  const b = Buffer.from(wire); let cursor = 0;
  const take = (count: number) => { check(count >= 0 && cursor + count <= b.length, 'Truncated wire'); const r = b.subarray(cursor, cursor + count); cursor += count; return r; };
  const byte = () => take(1)[0]!;
  const shortvec = () => {
    let result = 0; let shift = 0;
    for (let i = 0; i < 3; i++) {
      const current = byte(); result |= (current & 127) << shift;
      if ((current & 128) === 0) { check((i === 0 || current !== 0) && result <= 65535, 'Noncanonical shortvec'); return result; }
      shift += 7;
    }
    throw new Error('Oversize shortvec');
  };
  const signatureCount = shortvec();
  check(signatureCount >= 1 && signatureCount <= 8, 'Unreviewed signer count');
  const signatures = Array.from({ length: signatureCount }, () => take(64));
  const messageOffset = cursor;
  const required = byte(), readonlySigned = byte(), readonlyUnsigned = byte();
  check((required & 128) === 0 && required === signatureCount && readonlySigned < required, 'Legacy header/signature mismatch');
  const keyCount = shortvec(); check(keyCount >= required && keyCount <= 64 && readonlyUnsigned <= keyCount - required, 'Invalid account header');
  const keys = Array.from({ length: keyCount }, () => take(32));
  check(new Set(keys.map(base58)).size === keys.length, 'Duplicate static account');
  const blockhash = base58(take(32));
  const count = shortvec(); check(count >= 1 && count <= CAPS.instructions, 'Instruction cap exceeded');
  const instructions = Array.from({ length: count }, () => {
    const programIndex = byte(); check(programIndex < keyCount, 'Bad program index');
    const accountCount = shortvec(); check(accountCount <= 32, 'Too many instruction accounts');
    const indices = [...take(accountCount)]; check(indices.every(n => n < keyCount), 'Bad account index');
    const data = take(shortvec());
    return { program: base58(keys[programIndex]!), accounts: indices.map(n => base58(keys[n]!)), dataHex: data.toString('hex') };
  });
  check(cursor === b.length, 'Trailing transaction bytes');
  const message = b.subarray(messageOffset);
  if (verifySignatures) signatures.forEach((s, i) => check(verifyEd25519(keys[i]!, message, s), 'Invalid exact-message signature'));
  return { wireBase64: b.toString('base64'), messageBase64: message.toString('base64'), wireSha256: sha256(b),
    messageSha256: sha256(message), signature: base58(signatures[0]!), signerAddresses: keys.slice(0, required).map(base58), blockhash, instructions };
}

export const METHODS = ['getGenesisHash', 'getLatestBlockhash', 'getBlockHeight', 'getFeeForMessage',
  'getMinimumBalanceForRentExemption', 'getMultipleAccounts', 'sendTransaction', 'getSignatureStatuses', 'getTransaction'] as const;
export type Method = typeof METHODS[number];
export type Capture = (name: string, raw: string) => Promise<void>;
export class RpcRejected extends Error { constructor(readonly rpcError: unknown) { super('RPC rejected request'); } }
export class TransportUnknown extends Error { constructor(message = 'Transport outcome unknown') { super(message); } }
export class LostAcknowledgement extends TransportUnknown {}
export class RpcBudgetExhausted extends Error {
  constructor(readonly limit: 'response-bytes' | 'aggregate-response-bytes' | 'rpc-calls' | 'fixture-time') {
    super(`RPC safety budget exhausted: ${limit}`);
  }
}
export interface Rpc { call(method: Method, params?: readonly unknown[]): Promise<unknown> }
export class LocalRpc implements Rpc {
  private sequence = 0;
  private receivedBytes = 0;
  private exhausted: RpcBudgetExhausted | null = null;
  private readonly deadline: number;
  constructor(private readonly capture: Capture, private readonly fetcher: typeof fetch = fetch) { this.deadline = Date.now() + CAPS.fixtureMs; }
  private exhaust(limit: RpcBudgetExhausted['limit']): never {
    this.exhausted ??= new RpcBudgetExhausted(limit);
    throw this.exhausted;
  }
  private assertOpen(): void {
    if (this.exhausted) throw this.exhausted;
    if (Date.now() >= this.deadline) this.exhaust('fixture-time');
    if (this.receivedBytes >= CAPS.totalResponseBytes) this.exhaust('aggregate-response-bytes');
  }
  get usage() { return Object.freeze({ calls: this.sequence, receivedBytes: this.receivedBytes, exhausted: this.exhausted?.limit ?? null }); }
  async call(method: Method, params: readonly unknown[] = []): Promise<unknown> {
    check(METHODS.includes(method), 'Unreviewed RPC method');
    this.assertOpen();
    if (this.sequence >= CAPS.rpcCalls) this.exhaust('rpc-calls');
    this.sequence++;
    const id = `chain0-${String(this.sequence).padStart(5, '0')}`;
    const request = losslessStringify({ jsonrpc: '2.0', id, method, params });
    check(Buffer.byteLength(request) <= 20_000, 'Request cap exceeded');
    await this.capture(`${id}.request.json`, request);
    // Another in-flight call may have exhausted the shared allowance during capture.
    this.assertOpen();
    let raw: string;
    const chunks: Uint8Array[] = []; let total = 0, capturedBytes = 0;
    try {
      const response = await this.fetcher(RPC_URL, { method: 'POST', body: request, headers: { 'content-type': 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(CAPS.requestMs) });
      check(response.body, 'HTTP response body unavailable');
      const reader = response.body.getReader();
      try {
        for (;;) {
          this.assertOpen();
          const part = await reader.read(); if (part.done) break;
          // Charge first, including a chunk that exceeds a limit or precedes stream failure.
          total += part.value.byteLength; this.receivedBytes += part.value.byteLength;
          const kept = Math.min(part.value.byteLength, CAPS.responseBytes - capturedBytes);
          if (kept > 0) { chunks.push(part.value.subarray(0, kept)); capturedBytes += kept; }
          if (total > CAPS.responseBytes) this.exhaust('response-bytes');
          this.assertOpen();
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = Buffer.concat(chunks);
      await this.capture(`${id}.response.base64`, bytes.toString('base64'));
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      check(response.ok, 'HTTP response unavailable');
    } catch (error) {
      if (capturedBytes > 0) await this.capture(`${id}.partial-response.base64`, Buffer.concat(chunks).toString('base64'));
      const exhaustion = error instanceof RpcBudgetExhausted ? error : this.exhausted;
      if (exhaustion) {
        await this.capture(`${id}.budget-exhausted.json`, evidenceJson({ classification: 'resource-exhausted', limit: exhaustion.limit,
          responseBytes: total, capturedPrefixBytes: capturedBytes, aggregateReceivedBytes: this.receivedBytes }));
        throw exhaustion;
      }
      await this.capture(`${id}.transport.json`, evidenceJson({ classification: 'transport-unknown',
        responseBytes: total, capturedPrefixBytes: capturedBytes, aggregateReceivedBytes: this.receivedBytes }));
      throw new TransportUnknown();
    }
    await this.capture(`${id}.response.json`, raw);
    const envelope = record(losslessParse(raw));
    check(envelope['jsonrpc'] === '2.0' && envelope['id'] === id, 'RPC response identity mismatch');
    if ('error' in envelope) { check(!('result' in envelope), 'Ambiguous RPC response'); throw new RpcRejected(envelope['error']); }
    check('result' in envelope, 'Missing RPC result'); return envelope['result'];
  }
}
export function capturedRpc(id: FixtureId): LocalRpc {
  return new LocalRpc((name, raw) => durableWrite(fixturePath(id, `evidence/rpc/${name}`), raw));
}
export interface AccountState { lamports: string; owner: string; executable: boolean; rentEpoch: string; dataBase64: string }
export interface Snapshot { slot: string; accounts: Record<string, AccountState | null> }
export function accountState(value: unknown): AccountState | null {
  if (value === null) return null;
  const v = record(value); const data = v['data'];
  check(Array.isArray(data) && data.length === 2 && data[1] === 'base64' && typeof v['executable'] === 'boolean', 'Invalid RPC account encoding');
  return { lamports: u64(v['lamports']).toString(), owner: key(v['owner']), executable: v['executable'],
    rentEpoch: u64(v['rentEpoch']).toString(), dataBase64: fromBase64(data[0]).toString('base64') };
}
export async function snapshot(rpc: Rpc, addresses: readonly string[], minContextSlot = 0n): Promise<Snapshot> {
  check(addresses.length >= 1 && addresses.length <= 40 && new Set(addresses).size === addresses.length, 'Snapshot address bound');
  addresses.forEach(key);
  const r = record(await rpc.call('getMultipleAccounts', [addresses, { commitment: 'finalized', encoding: 'base64', minContextSlot }]));
  const slot = u64(record(r['context'])['slot']); check(slot >= minContextSlot, 'Stale snapshot');
  check(Array.isArray(r['value']) && r['value'].length === addresses.length, 'Incomplete snapshot');
  return { slot: slot.toString(), accounts: Object.fromEntries(addresses.map((address, i) => [address, accountState((r['value'] as unknown[])[i])])) };
}
export interface Finalized {
  classification: 'finalized-success' | 'finalized-program-failure'; signature: string; slot: string; err: unknown;
  fee: string; logs: string[]; wireBase64: string;
}
export interface Unknown { classification: 'unknown'; reason: string }
export function proveFinalized(original: WireIdentity, statusInput: unknown, transactionInput: unknown): Finalized | Unknown {
  if (statusInput === null || transactionInput === null) return { classification: 'unknown', reason: 'Missing or pruned original evidence' };
  const status = record(statusInput), tx = record(transactionInput);
  if (status['confirmationStatus'] !== 'finalized') return { classification: 'unknown', reason: 'Original transaction is not finalized' };
  const meta = record(tx['meta']);
  check('err' in status && 'err' in meta, 'Missing execution error fields');
  const wire = tx['transaction'];
  check(Array.isArray(wire) && wire.length === 2 && wire[1] === 'base64', 'Transaction is not original wire format');
  const identity = inspectWire(fromBase64(wire[0], CAPS.wireBytes));
  check(identity.wireBase64 === original.wireBase64 && identity.messageSha256 === original.messageSha256
    && identity.signature === original.signature, 'Returned transaction is not the original signed wire');
  check(u64(status['slot']) === u64(tx['slot']), 'Status/transaction slot mismatch');
  check(evidenceJson(status['err']) === evidenceJson(meta['err']), 'Status/transaction error mismatch');
  check(Array.isArray(meta['logMessages']) && meta['logMessages'].every(l => typeof l === 'string'), 'Missing execution logs');
  return { classification: meta['err'] === null ? 'finalized-success' : 'finalized-program-failure', signature: original.signature,
    slot: u64(tx['slot']).toString(), err: meta['err'], fee: u64(meta['fee']).toString(), logs: meta['logMessages'], wireBase64: identity.wireBase64 };
}
export async function recoverOriginal(rpc: Rpc, original: WireIdentity, polls = 45,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 500))): Promise<Finalized | Unknown> {
  check(Number.isInteger(polls) && polls >= 1 && polls <= 90, 'Recovery polling cap');
  for (let i = 0; i < polls; i++) {
    try {
      const statuses = record(await rpc.call('getSignatureStatuses', [[original.signature], { searchTransactionHistory: true }]));
      check(Array.isArray(statuses['value']) && statuses['value'].length === 1, 'Invalid original status response');
      const status = statuses['value'][0];
      if (status !== null && record(status)['confirmationStatus'] === 'finalized') {
        const transaction = await rpc.call('getTransaction', [original.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
        const proof = proveFinalized(original, status, transaction);
        if (proof.classification !== 'unknown') return proof;
      }
    } catch (e) { if (!(e instanceof TransportUnknown || e instanceof RpcRejected)) throw e; }
    if (i + 1 < polls) await pause();
  }
  return { classification: 'unknown', reason: 'Finalized original evidence unavailable within bounded recovery' };
}
export async function submitOriginal(rpc: Rpc, original: WireIdentity, loseAcknowledgement = false): Promise<void> {
  const signature = await rpc.call('sendTransaction', [original.wireBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]);
  check(signature === original.signature, 'Submission signature mismatch');
  // Test-only fault is injected after actual acceptance, with the real acknowledgement already captured.
  if (loseAcknowledgement) throw new LostAcknowledgement('Test-only lost acknowledgement after accepted submission');
}
export function rollback(before: Snapshot, after: Snapshot, payer: string, fee: bigint): void {
  check(u64(after.slot) >= u64(before.slot), 'Rollback snapshot moved backwards');
  check(Object.keys(before.accounts).sort().join(',') === Object.keys(after.accounts).sort().join(','), 'Rollback coverage mismatch');
  for (const [address, previous] of Object.entries(before.accounts)) {
    const current = after.accounts[address];
    check(current !== undefined, 'Missing rollback account');
    if (address === payer) {
      check(previous !== null && current !== null && u64(previous.lamports) - u64(current.lamports) === fee, 'Unexpected payer debit on failure');
      check(evidenceJson({ ...previous, lamports: '0' }) === evidenceJson({ ...current, lamports: '0' }), 'Payer metadata changed');
    } else check(evidenceJson(previous) === evidenceJson(current), `Failure altered account ${address}`);
  }
}
