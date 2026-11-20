import { CHAIN0_FREEZE_AUTHORITY, CHAIN0_MINT, CHAIN0_MINT_AUTHORITY, CHAIN0_TOKEN_PROGRAM,
  PACTWOVEN_PROGRAM_ADDRESS } from '../../client/src/identity.js';
import { decodeConfigBytes, decodeProgramData, publicKeyBytes } from '../independent-layout.js';
import { LOADER, SYSTEM, check, type FixtureId, type Prepared } from './manifest.js';
import { fromBase64, u64, type Snapshot, type WireIdentity, type Finalized } from './rpc.js';

export interface GenesisAccount {
  pubkey: string;
  account: { lamports: bigint; data: [string, 'base64']; owner: string; executable: boolean; rentEpoch: bigint };
}
export interface NamedAccount { file: 'mint.json' | 'config.json' | 'occupied.json' | 'program-data.json' | 'unlinked-program-data.json'; value: GenesisAccount }
// Public SHA-256 address of "pactwoven:chain0:synthetic-unlinked-program-data:v1".
// No private key exists in this fixture. This forged local account never establishes deployment provenance.
export const UNLINKED_PROGRAM_DATA = '84UHYgDdNSLA37NJZGoSpddBNXgnqHMZYpwa8G8dAjs1';
export function unlinkedProgramDataFixture(prepared: Prepared): GenesisAccount {
  check(![PACTWOVEN_PROGRAM_ADDRESS, CHAIN0_MINT, CHAIN0_TOKEN_PROGRAM, SYSTEM, LOADER,
    ...Object.values(prepared.signers)].includes(UNLINKED_PROGRAM_DATA), 'Synthetic ProgramData identity collision');
  const data = Buffer.alloc(45);
  data.writeUInt32LE(3, 0); // loader-v3 ProgramData
  data.writeBigUInt64LE(0n, 4);
  data[12] = 1; data.set(publicKeyBytes(prepared.signers.bootstrapAuthority), 13);
  return { pubkey: UNLINKED_PROGRAM_DATA, account: { lamports: 10_000_000n,
    data: [data.toString('base64'), 'base64'], owner: LOADER, executable: false, rentEpoch: 0n } };
}
export interface CanonicalBaseline {
  schema: 'pactwoven-chain0-canonical-baseline-v1'; runId: string; inputHash: string; preparedHash: string;
  genesis: string; configAddress: string; registrationAddress: string; vaultAddress: string; programDataAddress: string;
  configIdentity: WireIdentity; configFinality: Finalized; custodyIdentity: WireIdentity; custodyFinality: Finalized; snapshot: Snapshot;
}
export function mintFixture(): GenesisAccount {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0); data.set(publicKeyBytes(CHAIN0_MINT_AUTHORITY), 4);
  data[44] = 6; data[45] = 1;
  data.writeUInt32LE(1, 46); data.set(publicKeyBytes(CHAIN0_FREEZE_AUTHORITY), 50);
  return { pubkey: CHAIN0_MINT, account: { lamports: 10_000_000n, data: [data.toString('base64'), 'base64'],
    owner: CHAIN0_TOKEN_PROGRAM, executable: false, rentEpoch: 0n } };
}
export function needsBaseline(id: FixtureId): boolean { return id !== 'canonical' && id !== 'prefunded' && !id.startsWith('mint-'); }
function baselineAccount(baseline: CanonicalBaseline, address: string): GenesisAccount {
  const state = baseline.snapshot.accounts[address]; check(state, 'Missing canonical baseline account');
  return { pubkey: address, account: { lamports: u64(state.lamports), data: [state.dataBase64, 'base64'],
    owner: state.owner, executable: state.executable, rentEpoch: 0n } };
}
// These are deliberately forged genesis accounts, never proof of successful custody initialization.
export function fixtureAccounts(id: FixtureId, prepared: Prepared, baseline?: CanonicalBaseline): NamedAccount[] {
  const mint = mintFixture();
  if (id.startsWith('mint-')) {
    const data = fromBase64(mint.account.data[0]);
    if (id === 'mint-decimals') data[44] = 9;
    else if (id === 'mint-authority') data.set(publicKeyBytes(prepared.signers.intruder), 4);
    else if (id === 'mint-freeze') data.set(publicKeyBytes(prepared.signers.intruder), 50);
    else if (id === 'mint-owner') mint.account.owner = SYSTEM;
    else if (id === 'mint-size') { mint.account.data[0] = Buffer.concat([data, Buffer.alloc(1)]).toString('base64'); return [{ file: 'mint.json', value: mint }]; }
    else throw new Error('Unreviewed mint fixture');
    mint.account.data[0] = data.toString('base64');
  }
  const accounts: NamedAccount[] = [{ file: 'mint.json', value: mint }];
  if (id === 'canonical') accounts.push({ file: 'unlinked-program-data.json', value: unlinkedProgramDataFixture(prepared) });
  if (!needsBaseline(id)) return accounts;
  check(baseline, 'Adversarial fixture requires actual canonical baseline');
  check(baseline.runId === prepared.runId && baseline.inputHash === prepared.inputHash, 'Foreign baseline');
  const config = baselineAccount(baseline, baseline.configAddress);
  const decoded = decodeConfigBytes(fromBase64(config.account.data[0]));
  check(decoded.bootstrapAuthority === prepared.signers.bootstrapAuthority && decoded.registrar === prepared.signers.registrar
    && decoded.rentPayer === prepared.signers.rentPayer, 'Baseline signer mismatch');
  accounts.push({ file: 'config.json', value: config });
  if (id.startsWith('config-')) {
    const data = fromBase64(config.account.data[0]);
    if (id === 'config-version') data[8] = 2;
    else if (id === 'config-stage') data[10] = 1;
    else if (id === 'config-hash') data[336] = data[336]! ^ 1;
    else if (id === 'config-discriminator') data[0] = data[0]! ^ 1;
    else if (id === 'config-size') { config.account.data[0] = Buffer.concat([data, Buffer.alloc(1)]).toString('base64'); return accounts; }
    else throw new Error('Unreviewed config fixture');
    config.account.data[0] = data.toString('base64');
  } else if (id.startsWith('registration-') || id.startsWith('vault-')) {
    const isVault = id.startsWith('vault-');
    const occupied = baselineAccount(baseline, isVault ? baseline.vaultAddress : baseline.registrationAddress);
    if (id.endsWith('-foreign')) { occupied.account.owner = SYSTEM; occupied.account.data[0] = Buffer.from([1]).toString('base64'); }
    else if (id.endsWith('-nonempty')) {
      if (isVault) { const bytes = fromBase64(occupied.account.data[0]); bytes.writeBigUInt64LE(1n, 64); occupied.account.data[0] = bytes.toString('base64'); }
      else occupied.account.data[0] = Buffer.alloc(376, 0x55).toString('base64');
    } else check(id.endsWith('-initialized'), 'Unreviewed occupied fixture');
    check(occupied.account.owner === (id.endsWith('-foreign') ? SYSTEM : isVault ? CHAIN0_TOKEN_PROGRAM : PACTWOVEN_PROGRAM_ADDRESS), 'Occupied owner mismatch');
    accounts.push({ file: 'occupied.json', value: occupied });
  } else if (id === 'deployment-slot' || id === 'upgrade-null' || id === 'upgrade-substitution') {
    const programData = baselineAccount(baseline, baseline.programDataAddress);
    const bytes = fromBase64(programData.account.data[0]);
    const loader = decodeProgramData(bytes);
    check(loader.authority === prepared.signers.bootstrapAuthority && loader.slot === decoded.programDeploymentSlot, 'Canonical loader mismatch');
    if (id === 'deployment-slot') bytes.writeBigUInt64LE(loader.slot + 1n, 4);
    else if (id === 'upgrade-null') { bytes[12] = 0; bytes.fill(0, 13, 45); }
    else bytes.set(publicKeyBytes(prepared.signers.intruder), 13);
    programData.account.data[0] = bytes.toString('base64');
    accounts.push({ file: 'program-data.json', value: programData });
  } else throw new Error('Unreviewed adversarial fixture');
  return accounts;
}
