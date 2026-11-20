import { address, getAddressEncoder, getProgramDerivedAddress, type Address, type ReadonlyUint8Array } from '@solana/kit';

export const PACTWOVEN_PROGRAM_ADDRESS = address('5UaivPxV8oQypy5mxmQCzvZXHVSMkPsZ2TKJvszyebVG');
export const CHAIN0_GENESIS = address('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
export const CHAIN0_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const CHAIN0_TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const CHAIN0_MINT_AUTHORITY = address('GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz');
export const CHAIN0_FREEZE_AUTHORITY = address('CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT');
export const CHAIN0_ASSET_KEY_HEX = '34ee730cf90d3d55ea2d34e911aa4ad941aafb29668bf4056cfa88c6cf0492e4';

const utf8 = new TextEncoder();
const addressEncoder = getAddressEncoder();
const publicBytes = (value: Address) => addressEncoder.encode(value);
const assetKey = () => decodeHash32(CHAIN0_ASSET_KEY_HEX);

export function decodeHash32(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Expected a canonical lowercase SHA-256 hex digest');
  return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

export function encodeHex(bytes: ReadonlyUint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function uuidBytes(uuid: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error('Expected an RFC 4122 UUID in network byte order');
  }
  const hex = uuid.replaceAll('-', '');
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  if (bytes.every((value) => value === 0)) throw new Error('A registration UUID cannot be nil');
  return bytes;
}

function fixedBytes(value: ReadonlyUint8Array, length: number): Uint8Array<ArrayBuffer> {
  if (value.length !== length) throw new Error(`Expected ${length} bytes`);
  return new Uint8Array(value);
}

function littleEndianSlot(value: bigint): Uint8Array<ArrayBuffer> {
  if (value < 0n || value > 18_446_744_073_709_551_615n) throw new Error('Slot is outside u64');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

async function hash(prefix: string, ...parts: ReadonlyUint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  const domain = utf8.encode(`${prefix}\0`);
  const input = new Uint8Array(domain.length + parts.reduce((size, part) => size + part.length, 0));
  input.set(domain);
  let offset = domain.length;
  for (const part of parts) { input.set(part, offset); offset += part.length; }
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
}

export async function registrationKeys(organizationUuid: string, responsibilityUuid: string) {
  const org = uuidBytes(organizationUuid);
  const responsibility = uuidBytes(responsibilityUuid);
  const organizationKey = await hash('pactwoven:org-registration:v1', org);
  const responsibilityKey = await hash('pactwoven:responsibility-registration:v1', org, responsibility);
  return { organizationKey, responsibilityKey };
}

export async function deriveConfigAddress() {
  const [config, configBump] = await getProgramDerivedAddress({
    programAddress: PACTWOVEN_PROGRAM_ADDRESS, seeds: [utf8.encode('pw:config:v1')],
  });
  return { config, configBump };
}

export async function deriveCustodyAddresses(organizationUuid: string, responsibilityUuid: string) {
  const { organizationKey, responsibilityKey } = await registrationKeys(organizationUuid, responsibilityUuid);
  const { config, configBump } = await deriveConfigAddress();
  const [registration, registrationBump] = await getProgramDerivedAddress({
    programAddress: PACTWOVEN_PROGRAM_ADDRESS,
    seeds: [utf8.encode('pw:custody:v1'), organizationKey, responsibilityKey, assetKey()],
  });
  const [vault, vaultBump] = await getProgramDerivedAddress({
    programAddress: PACTWOVEN_PROGRAM_ADDRESS,
    seeds: [utf8.encode('pw:vault:v1'), publicBytes(registration)],
  });
  return { config, configBump, registration, registrationBump, vault, vaultBump, organizationKey, responsibilityKey };
}

export function computePhysicalAssetKey() {
  return hash('pactwoven:solana-asset:v1', publicBytes(CHAIN0_GENESIS), publicBytes(CHAIN0_TOKEN_PROGRAM), publicBytes(CHAIN0_MINT));
}

export function computeSetupPolicyHash() {
  return hash('pactwoven:chain0-init-policy:v1', new Uint8Array([1, 0, 1, 6]),
    publicBytes(CHAIN0_GENESIS), publicBytes(CHAIN0_TOKEN_PROGRAM), publicBytes(CHAIN0_MINT), assetKey());
}

export function configOperationKey(config: Address) {
  return hash('pactwoven:config-setup-op:v1', publicBytes(PACTWOVEN_PROGRAM_ADDRESS), publicBytes(config));
}

export function custodyOperationKey(registration: Address) {
  return hash('pactwoven:custody-setup-op:v1', publicBytes(PACTWOVEN_PROGRAM_ADDRESS), publicBytes(registration));
}

export interface ConfigIntent {
  config: Address;
  programData: Address;
  deploymentSlot: bigint;
  bootstrapAuthority: Address;
  registrar: Address;
  rentPayer: Address;
}

export async function computeConfigIntentHash(input: ConfigIntent) {
  // Snapshot the intent before any await so caller mutation cannot mix two requests.
  const { config, programData, deploymentSlot, bootstrapAuthority, registrar, rentPayer } = input;
  const configBytes = publicBytes(config);
  const programDataBytes = publicBytes(programData);
  const slotBytes = littleEndianSlot(deploymentSlot);
  const bootstrapBytes = publicBytes(bootstrapAuthority);
  const registrarBytes = publicBytes(registrar);
  const payerBytes = publicBytes(rentPayer);
  const [policyHash, operationKey] = await Promise.all([computeSetupPolicyHash(), configOperationKey(config)]);
  return hash('pactwoven:config-setup-intent:v1', publicBytes(PACTWOVEN_PROGRAM_ADDRESS),
    configBytes, programDataBytes, slotBytes, bootstrapBytes, registrarBytes, payerBytes,
    publicBytes(CHAIN0_GENESIS), publicBytes(CHAIN0_TOKEN_PROGRAM), publicBytes(CHAIN0_MINT),
    assetKey(), policyHash, operationKey);
}

export interface CustodyIntent {
  config: Address;
  configIntentHash: ReadonlyUint8Array;
  registration: Address;
  vault: Address;
  organizationKey: ReadonlyUint8Array;
  responsibilityKey: ReadonlyUint8Array;
  owner: Address;
  registrar: Address;
  rentPayer: Address;
  ownerBindingHash: ReadonlyUint8Array;
}

export async function computeCustodyIntentHash(input: CustodyIntent) {
  // Copy every buffer and address before awaiting operation identity derivation.
  const registration = input.registration;
  const configBytes = publicBytes(input.config);
  const configHash = fixedBytes(input.configIntentHash, 32);
  const registrationBytes = publicBytes(registration);
  const vaultBytes = publicBytes(input.vault);
  const organizationKey = fixedBytes(input.organizationKey, 32);
  const responsibilityKey = fixedBytes(input.responsibilityKey, 32);
  const ownerBytes = publicBytes(input.owner);
  const registrarBytes = publicBytes(input.registrar);
  const payerBytes = publicBytes(input.rentPayer);
  const bindingHash = fixedBytes(input.ownerBindingHash, 32);
  if (bindingHash.every((byte) => byte === 0)) throw new Error('Owner binding cannot be zero');
  const operationKey = await custodyOperationKey(registration);
  return hash('pactwoven:custody-setup-intent:v1', publicBytes(PACTWOVEN_PROGRAM_ADDRESS),
    configBytes, configHash, registrationBytes, vaultBytes, organizationKey, responsibilityKey,
    assetKey(), ownerBytes, registrarBytes, payerBytes, bindingHash, operationKey);
}
