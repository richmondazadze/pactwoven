import { decodeSolanaBase58, encodeSolanaBase58, FINANCE_DEVNET_ASSET } from '@pactwoven/contracts';
import { decodeProvenanceTokenAccount, provenanceBytes, provenanceHex } from '@pactwoven/domain';
import { getU32Decoder, getU64Decoder } from '@solana/codecs-numbers';
import { getBase58Decoder, getBase58Encoder, getBase64Decoder, getBase64Encoder } from '@solana/codecs-strings';
import { rejectSolana, type SolanaOriginalMint, type SolanaOriginalTokenAccount, type SolanaRpcAccount } from './types.js';

export function canonicalSolanaIdentity(value: string, length: 32 | 64 = 32): string {
  try { decodeSolanaBase58(value, length); } catch { return rejectSolana('INVALID_IDENTITY'); }
  return value;
}
export function decodeSolanaBase64(value: string): string {
  if (typeof value !== 'string' || value.length > 174_764
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) rejectSolana('INVALID_ENCODING');
  try {
    const bytes = getBase64Encoder().encode(value);
    if (getBase64Decoder().decode(bytes) !== value) rejectSolana('INVALID_ENCODING');
    return provenanceHex(Uint8Array.from(bytes));
  } catch { return rejectSolana('INVALID_ENCODING'); }
}
export function decodeSolanaInstructionData(value: string, maximumBytes = 10_240): string {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 10_240 || typeof value !== 'string'
    || value.length > Math.ceil(maximumBytes * 1.37) || !/^[1-9A-HJ-NP-Za-km-z]*$/.test(value)) rejectSolana('INVALID_ENCODING');
  try {
    const bytes = getBase58Encoder().encode(value);
    if (bytes.length > maximumBytes || getBase58Decoder().decode(bytes) !== value) rejectSolana('INVALID_ENCODING');
    return provenanceHex(Uint8Array.from(bytes));
  } catch { return rejectSolana('INVALID_ENCODING'); }
}
function accountBytes(account: SolanaRpcAccount, size: number): Uint8Array {
  canonicalSolanaIdentity(account.address);
  if (account.owner !== FINANCE_DEVNET_ASSET.tokenProgram || account.executable !== false) rejectSolana('UNSUPPORTED_ASSET');
  if (typeof account.dataHex !== 'string' || account.dataHex.length !== size * 2 || !/^[0-9a-f]+$/.test(account.dataHex)
    || (account.space !== null && account.space !== size.toString())) rejectSolana('INVALID_LAYOUT');
  return provenanceBytes(account.dataHex);
}
/** Layout and mint identity inspection only; matching bytes do not establish custody. */
export function decodeOriginalSolanaMint(account: SolanaRpcAccount): SolanaOriginalMint {
  if (account.address !== FINANCE_DEVNET_ASSET.mint) rejectSolana('UNSUPPORTED_ASSET');
  const bytes = accountBytes(account, 82);
  const option = (offset: number) => {
    const tag = getU32Decoder().decode(bytes.slice(offset, offset + 4));
    if (tag !== 0 && tag !== 1) rejectSolana('INVALID_LAYOUT');
    return tag ? encodeSolanaBase58(bytes.slice(offset + 4, offset + 36)) : null;
  };
  if (bytes[45] !== 0 && bytes[45] !== 1) rejectSolana('INVALID_LAYOUT');
  if (bytes[44] !== 6) rejectSolana('UNSUPPORTED_ASSET');
  return Object.freeze({ kind: 'original-mint-layout', address: account.address,
    mintAuthority: option(0), freezeAuthority: option(46), supplyBaseUnits: getU64Decoder().decode(bytes.slice(36, 44)).toString(),
    decimals: 6, initialized: bytes[45] === 1 });
}
/** Inactive option payload bytes are ignored as prescribed by SPL, never promoted to authority. */
export function decodeOriginalSolanaTokenAccount(account: SolanaRpcAccount): SolanaOriginalTokenAccount {
  accountBytes(account, 165);
  let decoded: ReturnType<typeof decodeProvenanceTokenAccount>;
  try { decoded = decodeProvenanceTokenAccount(account.dataHex); }
  catch { return rejectSolana('INVALID_LAYOUT'); }
  if (decoded.mint !== FINANCE_DEVNET_ASSET.mint) rejectSolana('UNSUPPORTED_ASSET');
  const state = (['uninitialized', 'initialized', 'frozen'] as const)[decoded.state];
  if (!state) rejectSolana('INVALID_LAYOUT');
  return Object.freeze({ kind: 'original-token-account-layout', address: account.address, mint: decoded.mint,
    authority: decoded.authority, amountBaseUnits: decoded.amountBaseUnits, state, delegate: decoded.delegate,
    delegatedAmountBaseUnits: decoded.delegatedAmountBaseUnits, nativeReserveBaseUnits: decoded.nativeReserveBaseUnits,
    closeAuthority: decoded.closeAuthority });
}
