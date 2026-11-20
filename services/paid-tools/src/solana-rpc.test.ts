import { describe, expect, it } from 'vitest';
import { preparePaidToolRpc, decodePaidToolRpc } from './solana-rpc.js';
import { transferFixture, publicAddress } from './solana-fixtures.test-support.js';

const envelope = (id: string, result: unknown) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));
describe('inert paid-tool RPC request/response helpers', () => {
  it('prepares finalized blockhash and lossless block-height reads', () => {
    const request = preparePaidToolRpc('latest', { method: 'getLatestBlockhash', minimumSlot: '9007199254740993' });
    expect(request.effect).toBe('read'); expect(request.payload).toContain('"minContextSlot":9007199254740993');
    const bytes = Buffer.from('{"jsonrpc":"2.0","id":"latest","result":{"context":{"slot":9007199254740993},"value":{"blockhash":"' + publicAddress(4) + '","lastValidBlockHeight":9007199254740994}}}');
    expect(decodePaidToolRpc(request, bytes, 'evidence')).toMatchObject({ method: 'getLatestBlockhash', lastValidBlockHeight: '9007199254740994', slot: '9007199254740993' });
    const height = preparePaidToolRpc('height', { method: 'getBlockHeight', minimumSlot: '100' });
    expect(decodePaidToolRpc(height, envelope('height', 150), 'evidence')).toMatchObject({ blockHeight: '150' });
  });
  it('binds fee observation to exact message request and cap', () => {
    const f = transferFixture(), request = preparePaidToolRpc('fee', { method: 'getFeeForMessage', intent: f.intent });
    expect(request.payload).toContain(f.message.messageBase64);
    expect(decodePaidToolRpc(request, envelope('fee', { context: { slot: 120 }, value: 5000 }), 'evidence')).toMatchObject({ feeLamports: '5000' });
    expect(() => decodePaidToolRpc(request, envelope('fee', { context: { slot: 120 }, value: 15001 }), 'evidence')).toThrow();
    expect(() => decodePaidToolRpc(request, envelope('fee', { context: { slot: 120 }, value: null }), 'evidence')).toThrow();
    expect(() => decodePaidToolRpc(request, envelope('fee', { context: { slot: 99 }, value: 5000 }), 'evidence')).toThrow();
  });
  it('simulates only verified exact signed bytes without blockhash replacement', () => {
    const f = transferFixture(), request = preparePaidToolRpc('simulation', { method: 'simulateTransaction', wire: f.wire });
    expect(JSON.parse(request.payload).params[1]).toMatchObject({ sigVerify: true, replaceRecentBlockhash: false, commitment: 'finalized' });
    expect(decodePaidToolRpc(request, envelope('simulation', { context: { slot: 120 }, value: { err: null, logs: [], unitsConsumed: 100 } }), 'evidence')).toMatchObject({ simulated: true, finalized: false });
    for (const value of [{ err: 'InstructionError' }, { err: null, replacementBlockhash: { blockhash: publicAddress(6), lastValidBlockHeight: 301 } }]) {
      expect(() => decodePaidToolRpc(request, envelope('simulation', { context: { slot: 120 }, value }), 'evidence')).toThrow();
    }
    expect(() => preparePaidToolRpc('simulation', { method: 'simulateTransaction', wire: { ...f.wire } })).toThrow();
  });
  it('broadcast preparation has zero retries and acknowledgement is not finality', () => {
    const f = transferFixture(), request = preparePaidToolRpc('send', { method: 'sendTransaction', wire: f.wire });
    expect(request.effect).toBe('broadcast');
    expect(JSON.parse(request.payload).params[1]).toMatchObject({ maxRetries: 0, skipPreflight: false, preflightCommitment: 'finalized' });
    expect(decodePaidToolRpc(request, envelope('send', f.wire.signature), 'evidence')).toMatchObject({ disposition: 'acknowledged_not_finalized', signature: f.wire.signature });
    expect(() => decodePaidToolRpc(request, envelope('send', '1'.repeat(64)), 'evidence')).toThrow();
  });
  it('rejects affinity, duplicate JSON keys, errors and unprepared request objects', () => {
    const request = preparePaidToolRpc('height', { method: 'getBlockHeight', minimumSlot: '100' });
    for (const bytes of [envelope('wrong', 150), Buffer.from('{"jsonrpc":"2.0","id":"height","result":150,"result":151}'),
      Buffer.from('{"jsonrpc":"2.0","id":"height","error":{"code":-32000,"message":"not ready"}}')]) {
      expect(() => decodePaidToolRpc(request, bytes, 'evidence')).toThrow();
    }
    expect(() => decodePaidToolRpc({ ...request }, envelope('height', 150), 'evidence')).toThrow();
  });
});
