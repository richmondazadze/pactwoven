import { createHash } from 'node:crypto';
import { decodeSolanaReadResponse } from '../../../packages/adapters/src/solana/rpc-read.js';
import type { SolanaReadEvidence } from '../../../packages/adapters/src/solana/types.js';
import { SOLANA_RPC_MAX_BYTES } from '../../../packages/adapters/src/solana/types.js';

/** Never trust a caller's decoded outcome flags. Re-decode the captured raw
 * bytes against the existing adapter's in-process prepared-request affinity.
 * On restart the private producer prepares the expected stored selector again.
 * This is structural integrity, not a replacement for authenticated transport. */
export async function redecodePaidToolEvidence(input: SolanaReadEvidence): Promise<SolanaReadEvidence> {
  const request = input.request, record = input.evidence;
  if (!record || typeof record.payloadHex !== 'string' || !/^[0-9a-f]+$/.test(record.payloadHex) || record.payloadHex.length % 2 ||
    record.payloadHex.length > SOLANA_RPC_MAX_BYTES * 2) throw new Error('Paid-tool evidence bytes are unavailable.');
  const bytes = Buffer.from(record.payloadHex, 'hex'), reference = record.reference, digest = record.sha256, length = record.byteLength;
  if (bytes.length !== length || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Paid-tool evidence bytes changed.');
  return decodeSolanaReadResponse(request, bytes, reference);
}
