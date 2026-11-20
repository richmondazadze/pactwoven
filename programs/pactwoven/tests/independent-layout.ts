import { createHash } from 'node:crypto';
import type { ReadonlyUint8Array } from '@solana/kit';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Test oracle intentionally does not import the generated client or its codecs.
export function publicKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  if (value.length < 32 || value.length > 44) throw new Error('Invalid public key length');
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid base58');
    number = number * 58n + BigInt(digit);
  }
  if (number >= 1n << 256n) throw new Error('Public key overflow');
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { bytes[i] = Number(number & 255n); number >>= 8n; }
  if (base58(bytes) !== value) throw new Error('Noncanonical public key');
  return bytes;
}

export function base58(bytes: ReadonlyUint8Array): string {
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) | BigInt(byte);
  let encoded = '';
  while (number > 0n) { encoded = alphabet[Number(number % 58n)] + encoded; number /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; encoded = '1' + encoded; }
  return encoded;
}

export function independentHash(domain: string, ...parts: ReadonlyUint8Array[]): Uint8Array<ArrayBuffer> {
  const digest = createHash('sha256').update(domain).update(new Uint8Array([0]));
  for (const part of parts) digest.update(Buffer.from(part));
  return new Uint8Array(digest.digest());
}

function accountBytes(input: ReadonlyUint8Array, size: number, discriminator: string): Buffer {
  const bytes = Buffer.from(input);
  if (bytes.byteLength !== size || bytes.subarray(0, 8).toString('hex') !== discriminator) {
    throw new Error('Wrong account length or discriminator');
  }
  return bytes;
}

export function decodeConfigBytes(input: ReadonlyUint8Array) {
  const data = accountBytes(input, 384, 'c4d25ae790958c3f');
  const key = (offset: number) => base58(data.subarray(offset, offset + 32));
  const hash = (offset: number) => data.subarray(offset, offset + 32).toString('hex');
  return {
    version: data[8], bump: data[9], stage: data[10], environment: data[11], decimals: data[12],
    reserved: data.subarray(13, 16).toString('hex'),
    programData: key(16), bootstrapAuthority: key(48), registrar: key(80), rentPayer: key(112),
    genesis: key(144), tokenProgram: key(176), mint: key(208), physicalAssetKey: hash(240),
    setupPolicyHash: hash(272), setupOperationKey: hash(304), setupIntentHash: hash(336),
    programDeploymentSlot: data.readBigUInt64LE(368), createdSlot: data.readBigUInt64LE(376),
  };
}

export function decodeRegistrationBytes(input: ReadonlyUint8Array) {
  const data = accountBytes(input, 376, '0b60a2459fd15947');
  const key = (offset: number) => base58(data.subarray(offset, offset + 32));
  const hash = (offset: number) => data.subarray(offset, offset + 32).toString('hex');
  return {
    version: data[8], bump: data[9], vaultBump: data[10], stage: data[11],
    reserved: data.subarray(12, 16).toString('hex'),
    config: key(16), organizationKey: hash(48), responsibilityKey: hash(80), physicalAssetKey: hash(112),
    owner: key(144), registrar: key(176), rentPayer: key(208), vault: key(240),
    ownerBindingHash: hash(272), setupOperationKey: hash(304), setupIntentHash: hash(336),
    createdSlot: data.readBigUInt64LE(368),
  };
}

export function decodeTokenBytes(input: ReadonlyUint8Array) {
  const data = Buffer.from(input);
  if (data.byteLength !== 165) throw new Error('Wrong original-SPL account length');
  return {
    mint: base58(data.subarray(0, 32)), authority: base58(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64), delegateTag: data.readUInt32LE(72),
    state: data[108], nativeTag: data.readUInt32LE(109), delegatedAmount: data.readBigUInt64LE(121),
    closeAuthorityTag: data.readUInt32LE(129),
  };
}

export function decodeLoaderProgram(input: ReadonlyUint8Array) {
  const data = Buffer.from(input);
  if (data.length !== 36 || data.readUInt32LE(0) !== 2) throw new Error('Not a loader-v3 program account');
  return { programData: base58(data.subarray(4)) };
}

export function decodeProgramData(input: ReadonlyUint8Array) {
  const data = Buffer.from(input);
  if (data.length < 45 || data.readUInt32LE(0) !== 3) throw new Error('Not loader-v3 ProgramData');
  if (data[12] !== 0 && data[12] !== 1) throw new Error('Invalid upgrade authority option');
  return { slot: data.readBigUInt64LE(4), authority: data[12] === 1 ? base58(data.subarray(13, 45)) : null };
}
