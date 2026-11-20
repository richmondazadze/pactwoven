import { describe, expect, it } from 'vitest';
import { encodeSolanaBase58, FINANCE_DEVNET_ASSET } from '@pactwoven/contracts';
import { parseSolanaJson } from './lossless-json.js';
import { decodeSolanaTransactionEvidence } from './transaction-evidence.js';

const address = (n: number) => encodeSolanaBase58(new Uint8Array(32).fill(n));
const signature = encodeSolanaBase58(new Uint8Array(64).fill(7));
const json = (value: unknown) => parseSolanaJson(new TextEncoder().encode(JSON.stringify(value)));
function fixture(version: 'legacy' | 0 = 'legacy') {
  const count = version === 0 ? 5 : 3;
  return {
    slot: 200, blockTime: null, version,
    transaction: { signatures: [signature], message: {
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      accountKeys: [address(1), address(2), address(3)], recentBlockhash: address(8),
      instructions: [{ programIdIndex: 2, accounts: [0, 1], data: '1' }],
      ...(version === 0 ? { addressTableLookups: [{ accountKey: address(4), writableIndexes: [2], readonlyIndexes: [3] }] } : {}),
    } },
    meta: { err: null, fee: 5000, preBalances: Array<number>(count).fill(10), postBalances: Array<number>(count).fill(10),
      loadedAddresses: { writable: version === 0 ? [address(5)] : [], readonly: version === 0 ? [address(6)] : [] },
      innerInstructions: [{ index: 0, instructions: [
        { programIdIndex: 2, accounts: [0], data: '', stackHeight: 2 },
        { programIdIndex: 2, accounts: [0, 1], data: '111', stackHeight: 2 },
      ] }], logMessages: ['Program example invoke [1]', 'Program example success'],
      preTokenBalances: [{ accountIndex: 1, mint: FINANCE_DEVNET_ASSET.mint, uiTokenAmount: { amount: '18446744073709551615', decimals: 6, uiAmount: null } }],
      postTokenBalances: [] as unknown[],
    },
  };
}
const decode = (value: unknown) => decodeSolanaTransactionEvidence(json(value), signature);
describe('inert transaction metadata and original instruction positions', () => {
  it('preserves all original inner ordinals including non-transfer entries and separates top-level/inner-zero', () => {
    const result = decode(fixture());
    expect(result.instructions[0]).toMatchObject({ outerInstructionIndex: 0, innerInstructionOrdinal: null });
    expect(result.innerInstructions).toHaveLength(2);
    expect(result.innerInstructions![0]).toMatchObject({ outerInstructionIndex: 0, innerInstructionOrdinal: 0, dataHex: '' });
    expect(result.innerInstructions![1]).toMatchObject({ outerInstructionIndex: 0, innerInstructionOrdinal: 1, dataHex: '000000' });
    expect(result.transactionStatus).toBe('succeeded'); expect(Object.isFrozen(result.innerInstructions)).toBe(true);
    expect(result).not.toHaveProperty('fact'); expect(result).not.toHaveProperty('execution');
  });
  it('accepts only a bounded nonnegative integer transaction index without changing evidence meaning', () => {
    for (const version of ['legacy', 0] as const) {
      const source = fixture(version), baseline = decode(source);
      for (const transactionIndex of [0, 5, Number.MAX_SAFE_INTEGER]) expect(decode({ ...source, transactionIndex })).toEqual(baseline);
      for (const transactionIndex of [null, false, '5', [], {}, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => decode({ ...source, transactionIndex })).toThrow();
      }
      expect(() => decode({ ...source, transactionIndex: 5, unexpectedIndex: 1 })).toThrow();
      const text = JSON.stringify({ ...source, transactionIndex: 5 });
      for (const numeric of ['5e0', '5.0', '-0', 'NaN', 'Infinity', '9007199254740992', '18446744073709551615']) {
        expect(() => decodeSolanaTransactionEvidence(parseSolanaJson(new TextEncoder().encode(text.replace('"transactionIndex":5', `"transactionIndex":${numeric}`))), signature)).toThrow();
      }
      expect(() => decodeSolanaTransactionEvidence(parseSolanaJson(new TextEncoder().encode(text.replace('"transactionIndex":5', '"transactionIndex":5,"transactionIndex":6'))), signature)).toThrow();
    }
  });
  it('resolves v0 in static then all writable then all readonly order', () => {
    const source = fixture(0);
    source.transaction.message.instructions[0]!.accounts = [3, 4];
    const result = decode(source);
    expect(result.resolvedAccountKeys).toEqual([address(1), address(2), address(3), address(5), address(6)]);
    expect(result.instructions[0]?.accountIndexes).toEqual([3, 4]);
    const withTwoTables = fixture(0);
    withTwoTables.transaction.message.addressTableLookups!.push({ accountKey: address(9), writableIndexes: [4], readonlyIndexes: [5] });
    withTwoTables.meta.loadedAddresses.writable.push(address(10)); withTwoTables.meta.loadedAddresses.readonly.push(address(11));
    withTwoTables.meta.preBalances.push(10, 10); withTwoTables.meta.postBalances.push(10, 10);
    expect(decode(withTwoTables).resolvedAccountKeys).toEqual([address(1), address(2), address(3), address(5), address(10), address(6), address(11)]);
  });
  it('rejects unresolved lookup data, inconsistent counts, duplicate tables and unsupported versions', () => {
    const source = fixture(0);
    const { loadedAddresses: omitted, ...noLoaded } = source.meta; void omitted;
    expect(() => decode({ ...source, meta: noLoaded })).toThrow();
    expect(() => decode({ ...source, meta: { ...source.meta, loadedAddresses: { writable: [], readonly: [] } } })).toThrow();
    expect(() => decode({ ...source, version: 1 })).toThrow();
    source.transaction.message.addressTableLookups!.push(source.transaction.message.addressTableLookups![0]!);
    expect(() => decode(source)).toThrow();
    const legacy = fixture(); expect(() => decode({ ...legacy, transaction: { ...legacy.transaction, message: { ...legacy.transaction.message, addressTableLookups: [{ accountKey: address(4), writableIndexes: [0], readonlyIndexes: [] }] } } })).toThrow();
  });
  it('rejects incorrect signature/header/account/instruction affinity', () => {
    const source = fixture();
    expect(() => decode({ ...source, transaction: { ...source.transaction, signatures: [encodeSolanaBase58(new Uint8Array(64).fill(8))] } })).toThrow();
    expect(() => decode({ ...source, transaction: { ...source.transaction, signatures: ['too-short'] } })).toThrow();
    for (const header of [{ numRequiredSignatures: 2, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      { numRequiredSignatures: 1, numReadonlySignedAccounts: 1, numReadonlyUnsignedAccounts: 0 }]) {
      expect(() => decode({ ...source, transaction: { ...source.transaction, message: { ...source.transaction.message, header } } })).toThrow();
    }
    source.transaction.message.instructions[0]!.programIdIndex = 3; expect(() => decode(source)).toThrow();
    source.transaction.message.instructions[0]!.programIdIndex = 2; source.transaction.message.instructions[0]!.accounts = [256]; expect(() => decode(source)).toThrow();
    source.transaction.message.instructions[0]!.accounts = [0]; source.transaction.message.instructions[0]!.data = '0OIl'; expect(() => decode(source)).toThrow();
  });
  it('rejects duplicate or out-of-range outer groups instead of renumbering them', () => {
    const source = fixture(); source.meta.innerInstructions.push(source.meta.innerInstructions[0]!); expect(() => decode(source)).toThrow();
    source.meta.innerInstructions.pop(); source.meta.innerInstructions[0]!.index = 1; expect(() => decode(source)).toThrow();
  });
  it('keeps missing metadata and token rows missing without fabricated historical mint/account attribution', () => {
    const source = fixture(), result = decode({ ...source, meta: null });
    expect(result).toMatchObject({ transactionStatus: 'unknown', feeLamports: null, preTokenBalances: null, postTokenBalances: null, innerInstructions: null, logMessages: null });
    expect(result.missingMetadata).toContain('meta');
    const complete = decode(source);
    expect(complete.preTokenBalances![0]).toMatchObject({ amountBaseUnits: '18446744073709551615', owner: null, tokenProgram: null });
    expect(complete.postTokenBalances).toEqual([]);
    const { preTokenBalances: omitted, ...noPre } = source.meta; void omitted;
    expect(decode({ ...source, meta: noPre }).preTokenBalances).toBeNull();
    source.meta.preTokenBalances[0]!.uiTokenAmount.amount = '18446744073709551616'; expect(() => decode(source)).toThrow();
  });
  it('does not turn caught/failed CPI or truncated logs into transfer success', () => {
    const source = fixture(); source.meta.logMessages = ['Program nested invoke [2]', 'Program nested failed: custom program error', 'Log truncated'];
    const result = decode(source); expect(result.transactionStatus).toBe('succeeded'); expect(result.logMessages).toEqual(source.meta.logMessages);
    expect(result).not.toHaveProperty('transfer'); expect(result).not.toHaveProperty('invocation'); expect(result).not.toHaveProperty('qualified');
    const failed = decode({ ...source, meta: { ...source.meta, err: { InstructionError: [0, 'Custom'] } } });
    expect(failed.transactionStatus).toBe('failed'); expect(failed.feeLamports).toBe('5000');
    const absent = decode({ ...source, meta: { ...source.meta, logMessages: null, innerInstructions: null } });
    expect(absent.logMessages).toBeNull(); expect(absent.innerInstructions).toBeNull();
  });
  it('rejects unsafe numeric forms rather than rounding slot or account indexes', () => {
    const text = JSON.stringify(fixture());
    expect(decodeSolanaTransactionEvidence(parseSolanaJson(new TextEncoder().encode(text.replace('"slot":200', '"slot":18446744073709551615'))), signature).slot).toBe('18446744073709551615');
    for (const slot of ['18446744073709551616', '2e2', '-0']) expect(() => decodeSolanaTransactionEvidence(parseSolanaJson(new TextEncoder().encode(text.replace('"slot":200', `"slot":${slot}`))), signature)).toThrow();
  });
});
