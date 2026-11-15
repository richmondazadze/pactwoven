import { describe, expect, it } from 'vitest';
import { decodeSolanaBase58, encodeSolanaBase58, FINANCE_DEVNET_ASSET } from '@pactwoven/contracts';
import { provenanceHex } from '@pactwoven/domain';
import { decodeOriginalSolanaMint, decodeOriginalSolanaTokenAccount, decodeSolanaBase64, decodeSolanaInstructionData } from './token-accounts.js';
import type { SolanaRpcAccount } from './types.js';

const address = (n: number) => encodeSolanaBase58(new Uint8Array(32).fill(n));
function account(bytes: Uint8Array, mint = false): SolanaRpcAccount {
  return { address: mint ? FINANCE_DEVNET_ASSET.mint : address(2), owner: FINANCE_DEVNET_ASSET.tokenProgram,
    executable: false, lamports: '0', rentEpoch: '18446744073709551615', space: bytes.length.toString(), dataHex: provenanceHex(bytes) };
}
function mintBytes(): Uint8Array { const bytes = new Uint8Array(82); bytes[44] = 6; bytes[45] = 1; return bytes; }
function tokenBytes(): Uint8Array {
  const bytes = new Uint8Array(165); bytes.set(decodeSolanaBase58(FINANCE_DEVNET_ASSET.mint, 32)); bytes.set(new Uint8Array(32).fill(3), 32); bytes[108] = 1; return bytes;
}
describe('original SPL token layout evidence', () => {
  it('decodes exact mint supply and account amounts including u64 max', () => {
    for (const amount of [0n, 9_007_199_254_740_993n, 18_446_744_073_709_551_615n]) {
      const mint = mintBytes(), token = tokenBytes(); new DataView(mint.buffer).setBigUint64(36, amount, true); new DataView(token.buffer).setBigUint64(64, amount, true);
      expect(decodeOriginalSolanaMint(account(mint, true)).supplyBaseUnits).toBe(amount.toString());
      expect(decodeOriginalSolanaTokenAccount(account(token)).amountBaseUnits).toBe(amount.toString());
    }
  });
  it('requires exact82/165 lengths, pinned owner/mint/decimals and non-executable data', () => {
    for (const size of [81, 83]) expect(() => decodeOriginalSolanaMint(account(new Uint8Array(size), true))).toThrow();
    for (const size of [164, 166]) expect(() => decodeOriginalSolanaTokenAccount(account(new Uint8Array(size)))).toThrow();
    const good = account(mintBytes(), true);
    for (const change of [{ owner: address(4) }, { executable: true }, { address: address(5) }, { space: '81' }]) expect(() => decodeOriginalSolanaMint({ ...good, ...change })).toThrow();
    const mint = mintBytes(); mint[44] = 9; expect(() => decodeOriginalSolanaMint(account(mint, true))).toThrow();
    const token = tokenBytes(); token[0] = token[0]! ^ 1; expect(() => decodeOriginalSolanaTokenAccount(account(token))).toThrow();
  });
  it('rejects invalid option/bool/state values accepted by convenience decoders', () => {
    for (const offset of [0, 46]) { const bytes = mintBytes(); bytes[offset] = 2; expect(() => decodeOriginalSolanaMint(account(bytes, true))).toThrow(); }
    const mint = mintBytes(); mint[45] = 2; expect(() => decodeOriginalSolanaMint(account(mint, true))).toThrow();
    for (const offset of [72, 109, 129]) { const bytes = tokenBytes(); bytes[offset] = 2; expect(() => decodeOriginalSolanaTokenAccount(account(bytes))).toThrow(); }
    const token = tokenBytes(); token[108] = 3; expect(() => decodeOriginalSolanaTokenAccount(account(token))).toThrow();
  });
  it('retains frozen/delegated/native/close state without granting usable custody', () => {
    const token = tokenBytes(), view = new DataView(token.buffer); token[108] = 2;
    for (const offset of [72, 109, 129]) view.setUint32(offset, 1, true);
    token.set(new Uint8Array(32).fill(4), 76); token.set(new Uint8Array(32).fill(5), 133);
    view.setBigUint64(113, 42n, true); view.setBigUint64(121, 8n, true);
    const result = decodeOriginalSolanaTokenAccount(account(token));
    expect(result).toMatchObject({ state: 'frozen', delegate: address(4), nativeReserveBaseUnits: '42', delegatedAmountBaseUnits: '8', closeAuthority: address(5) });
    expect(result).not.toHaveProperty('qualified'); expect(result).not.toHaveProperty('spendable');
  });
  it('does not invent authority from inactive option payloads', () => {
    const mint = mintBytes(); mint.fill(7, 4, 36); mint.fill(8, 50, 82);
    expect(decodeOriginalSolanaMint(account(mint, true))).toMatchObject({ mintAuthority: null, freezeAuthority: null });
    const token = tokenBytes(); token.fill(9, 76, 108); token.fill(10, 133, 165);
    expect(decodeOriginalSolanaTokenAccount(account(token))).toMatchObject({ delegate: null, closeAuthority: null });
  });
  it('rejects noncanonical encodings and never treats arbitrary instruction bytes as a transfer', () => {
    expect(decodeSolanaBase64('YQ==')).toBe('61'); expect(decodeSolanaBase64('')).toBe('');
    for (const input of ['YQ', ' YQ==', 'YQ==\n', 'YR==', 'YQ===', '____']) expect(() => decodeSolanaBase64(input)).toThrow();
    expect(decodeSolanaInstructionData('')).toBe(''); expect(decodeSolanaInstructionData('111')).toBe('000000');
    expect(() => decodeSolanaInstructionData('0OIl')).toThrow();
    expect(() => decodeSolanaInstructionData('1'.repeat(1233), 1232)).toThrow();
    expect(() => decodeSolanaInstructionData('1'.repeat(14_030))).toThrow();
  });
});
