import { describe, expect, it } from 'vitest';
import { encodeSolanaBase58, FINANCE_DEVNET_ASSET } from '@pactwoven/contracts';
import { physicalAssetKey, provenanceHex } from '@pactwoven/domain';
import { decodeSolanaReadResponse, prepareSolanaRead } from './rpc-read.js';
import { SOLANA_RPC_MAX_BYTES, type PreparedSolanaRead, type SolanaReadCommand } from './types.js';

const address = (n: number) => encodeSolanaBase58(new Uint8Array(32).fill(n));
const signature = (n: number) => encodeSolanaBase58(new Uint8Array(64).fill(n));
const bytes = (text: string) => new TextEncoder().encode(text);
const response = (result: unknown, id = 'probe') => bytes(JSON.stringify({ jsonrpc: '2.0', id, result }));
const account = { data: ['', 'base64'], owner: address(2), executable: false, lamports: 0, rentEpoch: 0, space: 0 };
describe('inert Solana read request/response affinity', () => {
  it('uses the canonical accepted physical identity without a new key implementation', async () => {
    expect(await physicalAssetKey(FINANCE_DEVNET_ASSET)).toBe('34ee730cf90d3d55ea2d34e911aa4ad941aafb29668bf4056cfa88c6cf0492e4');
    const read = prepareSolanaRead('probe', { method: 'getGenesisHash' });
    expect((await decodeSolanaReadResponse(read, response(FINANCE_DEVNET_ASSET.genesis), 'fixture:genesis')).outcome.kind).toBe('decoded');
    expect((await decodeSolanaReadResponse(read, response(address(9)), 'fixture:wrong-chain')).outcome).toEqual({ kind: 'rejected', code: 'GENESIS_MISMATCH' });
  });
  it('only prepares fixed read methods/encodings, exact integer params and historical status lookup', () => {
    const read = prepareSolanaRead('probe', { method: 'getAccountInfo', address: address(2), minContextSlot: '18446744073709551615' });
    expect(read.payload).toContain('"minContextSlot":18446744073709551615'); expect(read.payload).toContain('"commitment":"finalized"');
    expect(prepareSolanaRead('probe', { method: 'getTransaction', signature: signature(1) }).payload).toContain('"maxSupportedTransactionVersion":0');
    const statuses = prepareSolanaRead('probe', { method: 'getSignatureStatuses', signatures: [signature(1)] });
    expect(statuses.payload).toContain('"searchTransactionHistory":true'); expect(statuses.payload).not.toContain('commitment');
    for (const command of [{ method: 'sendTransaction' }, { method: 'requestAirdrop' }, { method: 'getGenesisHash', url: 'https://example.com' },
      { method: 'getAccountInfo', address: address(2), commitment: 'processed' }, { method: 'getAccountInfo', address: address(2), encoding: 'jsonParsed' }])
      expect(() => prepareSolanaRead('probe', command as unknown as SolanaReadCommand)).toThrow();
    expect(() => prepareSolanaRead('probe', { method: 'getAccountInfo', address: address(2), minContextSlot: '1e2' })).toThrow();
    expect(() => prepareSolanaRead('probe', { method: 'getMultipleAccounts', addresses: Array(9).fill(address(2)) })).toThrow();
    expect(() => prepareSolanaRead('probe', { method: 'getSignatureStatuses', signatures: [signature(1), signature(1)] })).toThrow();
  });
  it('rejects forged prepared requests and mismatched IDs/envelopes/method result schemas', async () => {
    const read = prepareSolanaRead('probe', { method: 'getGenesisHash' });
    await expect(decodeSolanaReadResponse({ ...read } as PreparedSolanaRead, response(FINANCE_DEVNET_ASSET.genesis), 'fixture:forged')).rejects.toThrow();
    for (const body of [response(FINANCE_DEVNET_ASSET.genesis, 'other'), bytes('{"jsonrpc":"1.0","id":"probe","result":null}'),
      bytes('{"jsonrpc":"2.0","id":1,"result":null}'), bytes('{"jsonrpc":"2.0","id":"probe","result":null,"error":null}'),
      bytes('{"jsonrpc":"2.0","id":"probe"}'), bytes('[]'), response({ context: { slot: 1 }, value: account })]) {
      const result = await decodeSolanaReadResponse(read, body, 'fixture:bad-envelope');
      expect(result.outcome.kind).toBe('rejected'); expect(result.evidence?.payloadHex).toBe(provenanceHex(body));
    }
  });
  it('retains RPC errors and null results without payment/failure/zero-balance inference', async () => {
    const read = prepareSolanaRead('probe', { method: 'getTransaction', signature: signature(1) });
    expect((await decodeSolanaReadResponse(read, response(null), 'fixture:null')).outcome).toEqual({ kind: 'unavailable', reason: 'null-result' });
    const error = bytes('{"jsonrpc":"2.0","id":"probe","error":{"code":-32004,"message":"not available"}}');
    expect((await decodeSolanaReadResponse(read, error, 'fixture:error')).outcome).toEqual({ kind: 'rpc-error', code: '-32004' });
    const missing = prepareSolanaRead('probe', { method: 'getAccountInfo', address: address(2) });
    const outcome = (await decodeSolanaReadResponse(missing, response({ context: { slot: 1 }, value: null }), 'fixture:account-null')).outcome;
    expect(outcome).toMatchObject({ kind: 'incomplete', data: { account: null }, reasons: ['account-unavailable'] });
  });
  it('preserves exact u64 context, lamports and rent epoch; enforces minimum bank and byte-length affinity', async () => {
    const read = prepareSolanaRead('probe', { method: 'getAccountInfo', address: address(2), minContextSlot: '9007199254740993' });
    const raw = `{"jsonrpc":"2.0","id":"probe","result":{"context":{"slot":9007199254740993},"value":{"data":["","base64"],"owner":"${address(2)}","executable":false,"lamports":18446744073709551615,"rentEpoch":18446744073709551615,"space":0}}}`;
    expect((await decodeSolanaReadResponse(read, bytes(raw), 'fixture:u64')).outcome).toMatchObject({ kind: 'decoded', data: { context: { slot: '9007199254740993' }, account: { lamports: '18446744073709551615', rentEpoch: '18446744073709551615' } } });
    expect((await decodeSolanaReadResponse(read, bytes(raw.replace('"slot":9007199254740993', '"slot":1')), 'fixture:stale')).outcome).toEqual({ kind: 'rejected', code: 'INCOMPLETE_RESPONSE' });
    expect((await decodeSolanaReadResponse(read, bytes(raw.replace('"space":0', '"space":1')), 'fixture:length')).outcome.kind).toBe('rejected');
  });
  it('captures exact bytes and immutable request configuration before asynchronous digest', async () => {
    const addresses = [address(2), address(3)];
    const read = prepareSolanaRead('probe', { method: 'getMultipleAccounts', addresses });
    addresses.reverse();
    const input = response({ context: { slot: 1 }, value: [account, account] }); const original = new Uint8Array(input);
    const pending = decodeSolanaReadResponse(read, input, 'fixture:snapshot'); input.fill(0);
    const result = await pending;
    expect(result.evidence?.payloadHex).toBe(provenanceHex(original));
    expect(result.evidence?.sha256).toBe(provenanceHex(new Uint8Array(await crypto.subtle.digest('SHA-256', original))));
    expect(result.outcome).toMatchObject({ kind: 'decoded', data: { accounts: [{ address: address(2) }, { address: address(3) }] } });
    expect(Object.isFrozen(read)).toBe(true); expect(() => Object.assign(read, { method: 'sendTransaction' })).toThrow();
    expect((await decodeSolanaReadResponse(read, response({ context: { slot: 1 }, value: [account] }), 'fixture:count')).outcome.kind).toBe('rejected');
  });
  it('caps retained bytes exactly, preserves malformed UTF-8 and refuses an oversized evidence digest', async () => {
    const read = prepareSolanaRead('probe', { method: 'getGenesisHash' });
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 'probe', result: FINANCE_DEVNET_ASSET.genesis });
    expect((await decodeSolanaReadResponse(read, bytes(raw.padEnd(SOLANA_RPC_MAX_BYTES)), 'fixture:max')).evidence?.byteLength).toBe(SOLANA_RPC_MAX_BYTES);
    expect(await decodeSolanaReadResponse(read, new Uint8Array(SOLANA_RPC_MAX_BYTES + 1), 'fixture:too-large')).toMatchObject({ evidence: null, outcome: { kind: 'rejected', code: 'SIZE_LIMIT' } });
    const bad = await decodeSolanaReadResponse(read, Uint8Array.of(255), 'fixture:bad-utf8');
    expect(bad.evidence?.payloadHex).toBe('ff'); expect(bad.outcome).toEqual({ kind: 'rejected', code: 'INVALID_UTF8' });
  });
  it('does not infer finality from confirmations:null or upgrade provisional status', async () => {
    const read = prepareSolanaRead('probe', { method: 'getSignatureStatuses', signatures: [signature(1), signature(2)] });
    const value = { context: { slot: 100 }, value: [{ slot: 90, confirmations: null, err: null, confirmationStatus: 'confirmed' }, null] };
    expect((await decodeSolanaReadResponse(read, response(value), 'fixture:statuses')).outcome).toMatchObject({ kind: 'incomplete', data: { statuses: [{ confirmationStatus: 'confirmed', transactionStatus: 'succeeded' }, null] } });
    value.value[0] = { slot: 90, confirmations: null, err: null, confirmationStatus: 'invalid' };
    expect((await decodeSolanaReadResponse(read, response(value), 'fixture:invalid-status')).outcome.kind).toBe('rejected');
  });
});
