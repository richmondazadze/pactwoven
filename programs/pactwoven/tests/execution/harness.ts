import { address, appendTransactionMessageInstructions, blockhash, compileTransaction, createTransactionMessage,
  getBase64EncodedWireTransaction, getProgramDerivedAddress, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type AccountMeta, type Instruction, type InstructionWithAccounts, type InstructionWithData, type KeyPairSigner, type ReadonlyUint8Array } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getApproveInstruction, getCloseAccountInstruction, getTransferInstruction } from '@solana-program/token';
import { getInitializeCustodyInstruction, getInitializeProgramConfigInstruction } from '../../client/src/generated/index.js';
import { CHAIN0_ASSET_KEY_HEX, CHAIN0_GENESIS, CHAIN0_MINT, CHAIN0_TOKEN_PROGRAM, PACTWOVEN_PROGRAM_ADDRESS,
  computeConfigIntentHash, computeCustodyIntentHash, computeSetupPolicyHash, configOperationKey, custodyOperationKey,
  decodeHash32, deriveCustodyAddresses, encodeHex, uuidBytes } from '../../client/src/identity.js';
import { decodeConfigBytes, decodeLoaderProgram, decodeProgramData, decodeRegistrationBytes, decodeTokenBytes, independentHash, publicKeyBytes } from '../independent-layout.js';
import { BINDING_HEX, CAPS, LOADER, ORGANIZATION, RESPONSIBILITY, SYSTEM, check, evidenceJson, fixturePath,
  record, writeJson, type FixtureId, type Prepared, type Role } from './manifest.js';
import { LostAcknowledgement, RpcRejected, TransportUnknown, fromBase64, inspectWire, recoverOriginal,
  rollback, snapshot, submitOriginal, u64, type Finalized, type Rpc, type Snapshot, type WireIdentity } from './rpc.js';
import { UNLINKED_PROGRAM_DATA, unlinkedProgramDataFixture, type CanonicalBaseline } from './adversarial-fixtures.js';

export type Ix = Instruction & InstructionWithAccounts<readonly AccountMeta[]> & InstructionWithData<ReadonlyUint8Array>;
type Kind = 'config' | 'custody' | 'dust-config' | 'dust-custody' | 'token-transfer' | 'token-close' | 'token-approve' | 'unknown' | 'identical-replay';
export interface Scenario { id: string; kind: Kind; mutation?: string; errorCode?: number; loseAcknowledgement?: boolean }
const negative = (kind: 'config' | 'custody', mutation: string, errorCode: number): Scenario => ({ id: `${kind}-${mutation}`, kind, mutation, errorCode });
export function scenariosFor(id: FixtureId): readonly Scenario[] {
  if (id === 'prefunded') return [
    { id: 'dust-config', kind: 'dust-config' }, { id: 'config-success', kind: 'config' },
    { id: 'dust-custody', kind: 'dust-custody' }, { id: 'custody-success', kind: 'custody' },
  ];
  if (id.startsWith('mint-')) return [{ id, kind: 'config', errorCode: id === 'mint-owner' ? 3007 : id === 'mint-size' ? 6001 : 6003 }];
  if (id !== 'canonical') {
    const errorCode = id.startsWith('registration-') || id.startsWith('vault-') ? 0
      : id === 'config-version' || id === 'config-stage' ? 6007 : id === 'config-hash' ? 6008
        : id === 'config-discriminator' ? 3002 : id === 'config-size' ? 6001 : id === 'deployment-slot' ? 6006 : 6005;
    return [{ id, kind: 'custody', errorCode }];
  }
  return [
    negative('config', 'missing-bootstrap', 3010), negative('config', 'missing-registrar', 3010),
    negative('config', 'wrong-bootstrap', 6005), negative('config', 'extra', 6000),
    negative('config', 'uninitialized-programdata', 3012), negative('config', 'wrong-programdata', 6004), negative('config', 'wrong-token', 3008),
    { id: 'config-success', kind: 'config' }, negative('config', 'replay', 0),
    negative('custody', 'missing-owner', 3010), negative('custody', 'missing-registrar', 3010),
    negative('custody', 'wrong-registrar', 6011), negative('custody', 'owner-is-registrar', 6012),
    negative('custody', 'extra', 6000), negative('custody', 'nil-organization', 6009),
    negative('custody', 'nil-responsibility', 6009), negative('custody', 'zero-binding', 6010),
    negative('custody', 'uninitialized-programdata', 3012), negative('custody', 'wrong-programdata', 6004), negative('custody', 'wrong-registration', 2006),
    negative('custody', 'wrong-vault', 2006), negative('custody', 'wrong-token', 3008),
    { id: 'custody-success', kind: 'custody', loseAcknowledgement: true },
    { id: 'custody-identical-wire-replay', kind: 'identical-replay' }, negative('custody', 'alternate-blockhash-replay', 0),
    { id: 'unauthorized-token-transfer-zero', kind: 'token-transfer', errorCode: 4 },
    { id: 'unauthorized-token-approve', kind: 'token-approve', errorCode: 4 },
    { id: 'unauthorized-token-close', kind: 'token-close', errorCode: 4 },
    { id: 'unknown-instruction', kind: 'unknown', errorCode: 101 },
  ];
}
export class ExposureBudget {
  transactions = 0; reserved = 0n;
  reserve(exposure: bigint, instructions: number): { sequence: number; exposure: string; cumulative: string } {
    check(Number.isInteger(instructions) && instructions >= 1 && instructions <= CAPS.instructions, 'Instruction cap exceeded');
    check(exposure > 0n && exposure <= CAPS.lamports && this.reserved + exposure <= CAPS.lamports
      && this.transactions < CAPS.transactions, 'Attempt/debit cap exceeded');
    this.transactions++; this.reserved += exposure;
    return { sequence: this.transactions, exposure: exposure.toString(), cumulative: this.reserved.toString() };
  }
  // Reservations intentionally never release on failure, timeout, recovery or successful replay.
}
export interface Attempt {
  schema: 'pactwoven-chain0-attempt-v1'; fixture: FixtureId; runId: string; scenario: string; sequence: number;
  operationKey: string | null; intentHash: string | null; reservedDebit: string; cumulativeReservedDebit: string;
  lastValidBlockHeight: string; before: Snapshot; identity: WireIdentity; replayOf: string | null;
}
export interface HarnessContext {
  id: FixtureId; prepared: Prepared; preparedHash: string; genesis: string; programData: string; deploymentSlot: bigint;
  signers: Record<Role, KeyPairSigner>; rpc: Rpc;
}
async function rawCustodyAddresses(organization: Uint8Array, responsibility: Uint8Array) {
  const org = independentHash('pactwoven:org-registration:v1', organization);
  const resp = independentHash('pactwoven:responsibility-registration:v1', organization, responsibility);
  const [registration] = await getProgramDerivedAddress({ programAddress: PACTWOVEN_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode('pw:custody:v1'), org, resp, decodeHash32(CHAIN0_ASSET_KEY_HEX)] });
  const [vault] = await getProgramDerivedAddress({ programAddress: PACTWOVEN_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode('pw:vault:v1'), publicKeyBytes(registration)] });
  return { registration, vault };
}
export async function buildScenario(scenario: Scenario, c: HarnessContext): Promise<Ix[]> {
  const s = c.signers, a = await deriveCustodyAddresses(ORGANIZATION, RESPONSIBILITY), m = scenario.mutation;
  if (scenario.kind === 'dust-config' || scenario.kind === 'dust-custody') {
    const targets = scenario.kind === 'dust-config' ? [a.config] : [a.registration, a.vault];
    return targets.map(destination => getTransferSolInstruction({ source: s.rentPayer, destination, amount: 1n }));
  }
  if (scenario.kind === 'token-transfer') return [getTransferInstruction({ source: a.vault, destination: a.vault, authority: s.intruder, amount: 0n })];
  if (scenario.kind === 'token-approve') return [getApproveInstruction({ source: a.vault, delegate: s.intruder.address, owner: s.intruder, amount: 1n })];
  if (scenario.kind === 'token-close') return [getCloseAccountInstruction({ account: a.vault, destination: s.rentPayer.address, owner: s.intruder })];
  if (scenario.kind === 'unknown') return [{ programAddress: PACTWOVEN_PROGRAM_ADDRESS, accounts: [], data: new Uint8Array(8).fill(255) }];
  check(scenario.kind === 'config' || scenario.kind === 'custody', 'Replay must reuse original wire');
  let instruction: Ix;
  if (scenario.kind === 'config') {
    instruction = getInitializeProgramConfigInstruction({ rentPayer: s.rentPayer,
      bootstrapAuthority: m === 'wrong-bootstrap' ? s.intruder : s.bootstrapAuthority, registrar: s.registrar,
      pactwovenProgram: PACTWOVEN_PROGRAM_ADDRESS, programData: address(m === 'uninitialized-programdata' ? s.intruder.address : m === 'wrong-programdata' ? UNLINKED_PROGRAM_DATA : c.programData),
      config: a.config, mint: CHAIN0_MINT, tokenProgram: m === 'wrong-token' ? address(SYSTEM) : CHAIN0_TOKEN_PROGRAM });
  } else {
    const organization = m === 'nil-organization' ? new Uint8Array(16) : uuidBytes(ORGANIZATION);
    const responsibility = m === 'nil-responsibility' ? new Uint8Array(16) : uuidBytes(RESPONSIBILITY);
    const derived = m?.startsWith('nil-') ? await rawCustodyAddresses(organization, responsibility) : a;
    instruction = getInitializeCustodyInstruction({ rentPayer: s.rentPayer, owner: m === 'owner-is-registrar' ? s.registrar : s.owner,
      registrar: m === 'wrong-registrar' ? s.intruder : s.registrar, pactwovenProgram: PACTWOVEN_PROGRAM_ADDRESS,
      programData: address(m === 'uninitialized-programdata' ? s.intruder.address : m === 'wrong-programdata' ? UNLINKED_PROGRAM_DATA : c.programData), config: a.config,
      registration: m === 'wrong-registration' ? s.intruder.address : derived.registration,
      vault: m === 'wrong-vault' ? s.intruder.address : derived.vault,
      mint: CHAIN0_MINT, tokenProgram: m === 'wrong-token' ? address(SYSTEM) : CHAIN0_TOKEN_PROGRAM,
      organizationUuid: organization, responsibilityUuid: responsibility, ownerBindingHash: m === 'zero-binding' ? new Uint8Array(32) : decodeHash32(BINDING_HEX) });
  }
  if (m === 'extra') instruction = { ...instruction, accounts: [...instruction.accounts, { address: s.intruder.address, role: 0 }] };
  if (m === 'missing-bootstrap' || m === 'missing-owner' || m === 'missing-registrar') {
    const index = m === 'missing-registrar' ? 2 : 1;
    instruction = { ...instruction, accounts: instruction.accounts.map((meta, i) => i === index ? { address: meta.address, role: (meta.role & 1) as 0 | 1 } : meta) };
  }
  return [instruction];
}
export function assertInstructionBoundary(instructions: readonly Ix[]): void {
  check(instructions.length >= 1 && instructions.length <= CAPS.instructions, 'Instruction boundary cap');
  for (const ix of instructions) {
    const bytes = Buffer.from(ix.data);
    if (ix.programAddress === PACTWOVEN_PROGRAM_ADDRESS) {
      check((bytes.length === 8 && ['06833ded286e537c', 'ffffffffffffffff'].includes(bytes.toString('hex')))
        || (bytes.length === 72 && bytes.subarray(0, 8).toString('hex') === 'e5dae478d0efdfea'), 'Unreviewed Pactwoven instruction');
    } else if (ix.programAddress === SYSTEM) {
      check(bytes.length === 12 && bytes.readUInt32LE(0) === 2 && bytes.readBigUInt64LE(4) === 1n, 'Only one-lamport dust transfers allowed');
    } else if (ix.programAddress === CHAIN0_TOKEN_PROGRAM) {
      check((bytes.length === 9 && bytes[0] === 3 && bytes.readBigUInt64LE(1) === 0n)
        || (bytes.length === 9 && bytes[0] === 4 && bytes.readBigUInt64LE(1) === 1n)
        || (bytes.length === 1 && bytes[0] === 9), 'Unreviewed negative token instruction');
    } else throw new Error('Unreviewed instruction program');
  }
}
function failedAsExpected(finality: Finalized, scenario: Scenario): void {
  check(scenario.errorCode !== undefined && finality.classification === 'finalized-program-failure', 'Negative did not execute and fail');
  const error = record(finality.err)['InstructionError'];
  check(Array.isArray(error) && error.length === 2 && u64(error[0]) === 0n, 'Unexpected failure position/type');
  const code = u64(record(error[1])['Custom']);
  check(code === BigInt(scenario.errorCode), `Unexpected program error for ${scenario.id}: ${code}`);
  const program = scenario.kind.startsWith('token-') ? CHAIN0_TOKEN_PROGRAM : PACTWOVEN_PROGRAM_ADDRESS;
  check(finality.logs.some(l => l === `Program ${program} invoke [1]`) && finality.logs.some(l => l.startsWith(`Program ${program} failed:`)), 'Missing intended program invocation/failure');
}
export function assertProgramDataSubstitution(scenario: Scenario, c: HarnessContext, before: Snapshot): void {
  if (scenario.mutation !== 'uninitialized-programdata' && scenario.mutation !== 'wrong-programdata') return;
  check(c.id === 'canonical' && (scenario.kind === 'config' || scenario.kind === 'custody'), 'Unreviewed ProgramData substitution');
  const program = before.accounts[PACTWOVEN_PROGRAM_ADDRESS];
  check(program && program.owner === LOADER && program.executable
    && decodeLoaderProgram(fromBase64(program.dataBase64)).programData === c.programData, 'Genuine program linkage changed');
  const actual = before.accounts[c.programData];
  check(actual && actual.owner === LOADER && !actual.executable && u64(actual.lamports) > 0n,
    'Genuine ProgramData account unavailable');
  const actualMetadata = decodeProgramData(fromBase64(actual.dataBase64));
  check(c.deploymentSlot === 0n && actualMetadata.slot === c.deploymentSlot
    && actualMetadata.authority === c.prepared.signers.bootstrapAuthority, 'Genuine ProgramData metadata changed');
  if (scenario.mutation === 'uninitialized-programdata') {
    check(scenario.errorCode === 3012 && c.signers.intruder.address !== c.programData
      && before.accounts[c.signers.intruder.address] === null, 'Uninitialized ProgramData requires absent prestate');
    return;
  }
  const expected = unlinkedProgramDataFixture(c.prepared), forged = before.accounts[UNLINKED_PROGRAM_DATA];
  check(scenario.errorCode === 6004 && UNLINKED_PROGRAM_DATA !== c.programData && forged
    && forged.owner === expected.account.owner && !forged.executable
    && u64(forged.lamports) === expected.account.lamports && u64(forged.lamports) > 0n
    && forged.dataBase64 === expected.account.data[0], 'Unlinked ProgramData fixture changed');
  const bytes = fromBase64(forged.dataBase64), metadata = decodeProgramData(bytes);
  check(bytes.length === 45 && metadata.slot === actualMetadata.slot && metadata.authority === actualMetadata.authority,
    'Unlinked ProgramData metadata differs from genuine account');
}
export function assertNegativeOutcome(finality: Finalized, scenario: Scenario, before: Snapshot, after: Snapshot, payer: string): void {
  failedAsExpected(finality, scenario);
  rollback(before, after, payer, u64(finality.fee));
}
async function assertConfig(c: HarnessContext, state: Snapshot) {
  const a = await deriveCustodyAddresses(ORGANIZATION, RESPONSIBILITY), account = state.accounts[a.config];
  check(account && account.owner === PACTWOVEN_PROGRAM_ADDRESS && !account.executable, 'Invalid config owner/flags');
  const config = decodeConfigBytes(fromBase64(account.dataBase64));
  const expectedIntent = await computeConfigIntentHash({ config: a.config, programData: address(c.programData), deploymentSlot: c.deploymentSlot,
    bootstrapAuthority: c.signers.bootstrapAuthority.address, registrar: c.signers.registrar.address, rentPayer: c.signers.rentPayer.address });
  check(config.version === 1 && config.bump === a.configBump && config.stage === 0 && config.environment === 1 && config.decimals === 6
    && config.reserved === '000000' && config.programData === c.programData && config.bootstrapAuthority === c.signers.bootstrapAuthority.address
    && config.registrar === c.signers.registrar.address && config.rentPayer === c.signers.rentPayer.address && config.genesis === CHAIN0_GENESIS
    && config.tokenProgram === CHAIN0_TOKEN_PROGRAM && config.mint === CHAIN0_MINT && config.physicalAssetKey === CHAIN0_ASSET_KEY_HEX
    && config.setupPolicyHash === encodeHex(await computeSetupPolicyHash()) && config.setupOperationKey === encodeHex(await configOperationKey(a.config))
    && config.setupIntentHash === encodeHex(expectedIntent) && config.programDeploymentSlot === c.deploymentSlot
    && config.createdSlot <= u64(state.slot), 'Config immutable state mismatch');
  return config;
}
async function assertCustody(c: HarnessContext, state: Snapshot) {
  const config = await assertConfig(c, state), a = await deriveCustodyAddresses(ORGANIZATION, RESPONSIBILITY);
  const registrationAccount = state.accounts[a.registration], vaultAccount = state.accounts[a.vault];
  check(registrationAccount && registrationAccount.owner === PACTWOVEN_PROGRAM_ADDRESS && !registrationAccount.executable
    && vaultAccount && vaultAccount.owner === CHAIN0_TOKEN_PROGRAM && !vaultAccount.executable, 'Custody owner/flags mismatch');
  const r = decodeRegistrationBytes(fromBase64(registrationAccount.dataBase64)), v = decodeTokenBytes(fromBase64(vaultAccount.dataBase64));
  const intent = await computeCustodyIntentHash({ ...a, configIntentHash: decodeHash32(config.setupIntentHash), owner: c.signers.owner.address,
    registrar: c.signers.registrar.address, rentPayer: c.signers.rentPayer.address, ownerBindingHash: decodeHash32(BINDING_HEX) });
  check(r.version === 1 && r.bump === a.registrationBump && r.vaultBump === a.vaultBump && r.stage === 0 && r.reserved === '00000000'
    && r.config === a.config && r.organizationKey === encodeHex(a.organizationKey) && r.responsibilityKey === encodeHex(a.responsibilityKey)
    && r.physicalAssetKey === CHAIN0_ASSET_KEY_HEX && r.owner === c.signers.owner.address && r.registrar === c.signers.registrar.address
    && r.rentPayer === c.signers.rentPayer.address && r.vault === a.vault && r.ownerBindingHash === BINDING_HEX
    && r.setupOperationKey === encodeHex(await custodyOperationKey(a.registration)) && r.setupIntentHash === encodeHex(intent)
    && r.createdSlot <= u64(state.slot), 'Custody immutable state mismatch');
  check(v.mint === CHAIN0_MINT && v.authority === a.registration && v.amount === 0n && v.state === 1 && v.nativeTag === 0
    && v.delegateTag === 0 && v.delegatedAmount === 0n && v.closeAuthorityTag === 0, 'Vault is not strictly empty original-SPL custody');
}
async function intentFor(scenario: Scenario, c: HarnessContext, before: Snapshot) {
  const a = await deriveCustodyAddresses(ORGANIZATION, RESPONSIBILITY);
  if (scenario.kind === 'config') return { operationKey: encodeHex(await configOperationKey(a.config)), intentHash: encodeHex(await computeConfigIntentHash({
    config: a.config, programData: address(c.programData), deploymentSlot: c.deploymentSlot, bootstrapAuthority: c.signers.bootstrapAuthority.address,
    registrar: c.signers.registrar.address, rentPayer: c.signers.rentPayer.address })) };
  if (scenario.kind === 'custody') {
    const config = before.accounts[a.config]; check(config, 'Custody requires config account');
    // Negative cases retain the canonical requested operation; mutated wire is persisted separately.
    const bytes = fromBase64(config.dataBase64); check(bytes.length >= 368, 'Config too short for requested intent');
    return { operationKey: encodeHex(await custodyOperationKey(a.registration)), intentHash: encodeHex(await computeCustodyIntentHash({ ...a,
      configIntentHash: bytes.subarray(336, 368), owner: c.signers.owner.address, registrar: c.signers.registrar.address,
      rentPayer: c.signers.rentPayer.address, ownerBindingHash: decodeHash32(BINDING_HEX) })) };
  }
  return { operationKey: null, intentHash: null };
}
export async function executeHarness(c: HarnessContext): Promise<void> {
  const a = await deriveCustodyAddresses(ORGANIZATION, RESPONSIBILITY), budget = new ExposureBudget();
  const baseAddresses = [a.config, a.registration, a.vault, PACTWOVEN_PROGRAM_ADDRESS, c.programData, CHAIN0_MINT,
    CHAIN0_TOKEN_PROGRAM, SYSTEM, ...Object.values(c.prepared.signers)];
  const rent = (await Promise.all([384n, 376n, 165n].map(size => c.rpc.call('getMinimumBalanceForRentExemption', [size, { commitment: 'finalized' }])))).map(u64);
  const maxRent = rent.reduce((n, v) => n + v, 0n);
  let custodySuccess: Attempt | undefined, configSuccess: Attempt | undefined;
  let custodyFinality: Finalized | undefined, configFinality: Finalized | undefined;
  let minimumSlot = 0n; const outcomes: unknown[] = [];
  for (const scenario of scenariosFor(c.id)) {
    check(await c.rpc.call('getGenesisHash') === c.genesis, 'Runtime genesis changed');
    const replay = scenario.kind === 'identical-replay';
    const instructions = replay ? [] : await buildScenario(scenario, c);
    if (!replay) assertInstructionBoundary(instructions);
    const addresses = [...new Set([...baseAddresses, ...instructions.flatMap(ix => ix.accounts.map(meta => meta.address))])];
    const before = await snapshot(c.rpc, addresses, minimumSlot);
    assertProgramDataSubstitution(scenario, c, before);
    let identity: WireIdentity, lastValidBlockHeight: string, fee: bigint, sequence: number, reservedDebit: string, cumulativeReservedDebit: string;
    if (replay) {
      check(custodySuccess && custodyFinality?.classification === 'finalized-success', 'Replay requires known original success');
      identity = inspectWire(fromBase64(custodySuccess.identity.wireBase64)); lastValidBlockHeight = custodySuccess.lastValidBlockHeight;
      fee = u64(custodyFinality.fee);
      const reservation = budget.reserve(fee, identity.instructions.length);
      ({ sequence, exposure: reservedDebit, cumulative: cumulativeReservedDebit } = reservation);
      await writeJson(fixturePath(c.id, `evidence/attempts/${String(sequence).padStart(3, '0')}.reservation.json`), { scenario: scenario.id, ...reservation });
    } else {
      const latest = async () => record(record(await c.rpc.call('getLatestBlockhash', [{ commitment: 'finalized' }]))['value']);
      let lifetime = await latest();
      if (scenario.mutation === 'alternate-blockhash-replay' || scenario.mutation === 'replay') {
        const prior = scenario.kind === 'config' ? configSuccess : custodySuccess;
        const priorFinality = scenario.kind === 'config' ? configFinality : custodyFinality;
        check(prior && priorFinality?.classification === 'finalized-success', 'Alternate replay requires known original success');
        for (let n = 0; n < 20 && lifetime['blockhash'] === prior.identity.blockhash; n++) {
          await new Promise(resolve => setTimeout(resolve, 500)); lifetime = await latest();
        }
        check(lifetime['blockhash'] !== prior.identity.blockhash, 'New blockhash unavailable');
      }
      lastValidBlockHeight = u64(lifetime['lastValidBlockHeight']).toString();
      const message = appendTransactionMessageInstructions(instructions, setTransactionMessageLifetimeUsingBlockhash({
        blockhash: blockhash(String(lifetime['blockhash'])), lastValidBlockHeight: BigInt(lastValidBlockHeight),
      }, setTransactionMessageFeePayerSigner(c.signers.rentPayer, createTransactionMessage({ version: 'legacy' }))));
      const unsignedBytes = compileTransaction(message).messageBytes;
      const quotedFee = record(await c.rpc.call('getFeeForMessage', [Buffer.from(unsignedBytes).toString('base64'), { commitment: 'finalized' }]));
      fee = u64(quotedFee['value']);
      const dust = scenario.kind === 'dust-config' ? 1n : scenario.kind === 'dust-custody' ? 2n : 0n;
      const reservation = budget.reserve(fee + maxRent + dust, instructions.length);
      ({ sequence, exposure: reservedDebit, cumulative: cumulativeReservedDebit } = reservation);
      await writeJson(fixturePath(c.id, `evidence/attempts/${String(sequence).padStart(3, '0')}.reservation.json`), { scenario: scenario.id, ...reservation });
      try {
        const signed = await signTransactionMessageWithSigners(message);
        identity = inspectWire(fromBase64(getBase64EncodedWireTransaction(signed), CAPS.wireBytes));
        check(identity.messageBase64 === Buffer.from(unsignedBytes).toString('base64'), 'Signed message changed after fee/reservation');
      } catch (error) {
        await writeJson(fixturePath(c.id, `evidence/attempts/${String(sequence).padStart(3, '0')}.serialization.json`), { classification: 'serialization-rejection', scenario: scenario.id });
        throw error;
      }
    }
    const intent = replay ? { operationKey: custodySuccess!.operationKey, intentHash: custodySuccess!.intentHash } : await intentFor(scenario, c, before);
    const attempt: Attempt = { schema: 'pactwoven-chain0-attempt-v1', fixture: c.id, runId: c.prepared.runId, scenario: scenario.id,
      sequence, ...intent, reservedDebit, cumulativeReservedDebit, lastValidBlockHeight, before, identity, replayOf: replay ? custodySuccess!.identity.signature : null };
    const prefix = fixturePath(c.id, `evidence/attempts/${String(sequence).padStart(3, '0')}`);
    await writeJson(`${prefix}.signed.json`, attempt);
    let submission: string = 'acknowledged';
    try { await submitOriginal(c.rpc, identity, scenario.loseAcknowledgement); }
    catch (e) {
      if (e instanceof LostAcknowledgement) submission = 'injected-acknowledgement-loss';
      else if (e instanceof RpcRejected) submission = 'rpc-rejection';
      else if (e instanceof TransportUnknown) submission = 'transport-unknown';
      else throw e;
    }
    await writeJson(`${prefix}.submission.json`, { classification: submission, originalSignature: identity.signature });
    const finality = await recoverOriginal(c.rpc, identity);
    await writeJson(`${prefix}.finality.json`, finality);
    check(finality.classification !== 'unknown', 'Original outcome remains unknown; reservation retained, execution stopped');
    minimumSlot = u64(finality.slot) > minimumSlot ? u64(finality.slot) : minimumSlot;
    const after = await snapshot(c.rpc, addresses, minimumSlot);
    await writeJson(`${prefix}.after.json`, after);
    const payerBefore = before.accounts[c.signers.rentPayer.address], payerAfter = after.accounts[c.signers.rentPayer.address];
    check(payerBefore && payerAfter, 'Payer snapshot missing');
    const debit = u64(payerBefore.lamports) - u64(payerAfter.lamports);
    check(debit >= 0n && debit <= u64(reservedDebit), 'Observed debit exceeded reserved exposure');
    if (scenario.errorCode !== undefined) { assertNegativeOutcome(finality, scenario, before, after, c.signers.rentPayer.address); }
    else {
      check(finality.classification === 'finalized-success', 'Expected initialization did not succeed');
      if (replay) { rollback(before, after, c.signers.rentPayer.address, 0n); await assertCustody(c, after); }
      else if (scenario.kind === 'config') { await assertConfig(c, after); configSuccess = attempt; configFinality = finality;
        check(decodeConfigBytes(fromBase64(after.accounts[a.config]!.dataBase64)).createdSlot === u64(finality.slot), 'Config creation slot mismatch'); }
      else if (scenario.kind === 'custody') { await assertCustody(c, after); custodySuccess = attempt; custodyFinality = finality;
        check(decodeRegistrationBytes(fromBase64(after.accounts[a.registration]!.dataBase64)).createdSlot === u64(finality.slot), 'Custody creation slot mismatch'); }
      else {
        for (const target of scenario.kind === 'dust-config' ? [a.config] : [a.registration, a.vault]) {
          const state = after.accounts[target]; check(state && state.owner === SYSTEM && state.dataBase64 === '' && state.lamports === '1' && !state.executable, 'Dust target mismatch');
        }
      }
    }
    const outcome = { scenario: scenario.id, classification: finality.classification, originalSignature: identity.signature,
      observedPayerDebit: debit.toString(), fee: finality.fee, reservedDebit, submission, passed: true };
    await writeJson(`${prefix}.verdict.json`, outcome); outcomes.push(outcome);
  }
  if (c.id === 'canonical') {
    check(configSuccess && configFinality && custodySuccess && custodyFinality, 'Missing canonical actual success');
    const state = await snapshot(c.rpc, baseAddresses, minimumSlot); await assertCustody(c, state);
    const baseline: CanonicalBaseline = { schema: 'pactwoven-chain0-canonical-baseline-v1', runId: c.prepared.runId,
      inputHash: c.prepared.inputHash, preparedHash: c.preparedHash, genesis: c.genesis, configAddress: a.config,
      registrationAddress: a.registration, vaultAddress: a.vault, programDataAddress: c.programData,
      configIdentity: configSuccess.identity, configFinality, custodyIdentity: custodySuccess.identity, custodyFinality, snapshot: state };
    await writeJson(fixturePath(c.id, 'evidence/baseline.json'), baseline);
  }
  await writeJson(fixturePath(c.id, 'evidence/report.json'), { fixture: c.id, syntheticGenesis: true,
    initialSyntheticSol: '500000000', transactions: budget.transactions, reservedDebit: budget.reserved.toString(), outcomes });
}
