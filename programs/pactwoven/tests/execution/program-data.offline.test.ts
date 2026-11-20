import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { address, createNoopSigner, type KeyPairSigner } from '@solana/kit';
import { CHAIN0_MINT, CHAIN0_TOKEN_PROGRAM, PACTWOVEN_PROGRAM_ADDRESS } from '../../client/src/identity.js';
import { publicKeyBytes } from '../independent-layout.js';
import { UNLINKED_PROGRAM_DATA, fixtureAccounts, unlinkedProgramDataFixture } from './adversarial-fixtures.js';
import { assertNegativeOutcome, assertProgramDataSubstitution, buildScenario, scenariosFor, type HarnessContext, type Scenario } from './harness.js';
import { LOADER, ROLES, SYSTEM, type Prepared, type Role } from './manifest.js';
import type { AccountState, Finalized, Snapshot } from './rpc.js';

const prepared: Prepared = { schema: 'pactwoven-chain0-prepared-v1', runId: 'chain0-offline', inputHash: 'd'.repeat(64),
  signers: { rentPayer: 'GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz', bootstrapAuthority: PACTWOVEN_PROGRAM_ADDRESS,
    registrar: 'CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT', owner: CHAIN0_MINT, intruder: CHAIN0_TOKEN_PROGRAM } };
const genuineAddress = '11111111111111111111111111111113';
const signers = Object.fromEntries(ROLES.map(role => [role, createNoopSigner(address(prepared.signers[role]))])) as Record<Role, KeyPairSigner>;
const context: HarnessContext = { id: 'canonical', prepared, preparedHash: 'a'.repeat(64), genesis: CHAIN0_MINT,
  programData: genuineAddress, deploymentSlot: 0n, signers, rpc: { async call() { throw Error('No RPC allowed'); } } };
const state = (patch: Partial<AccountState> = {}): AccountState => ({ lamports: '10000000', owner: LOADER, executable: false,
  rentEpoch: '0', dataBase64: '', ...patch });
function before(): Snapshot {
  const fixture = unlinkedProgramDataFixture(prepared), program = Buffer.alloc(36);
  program.writeUInt32LE(2); program.set(publicKeyBytes(genuineAddress), 4);
  return { slot: '10', accounts: {
    [PACTWOVEN_PROGRAM_ADDRESS]: state({ executable: true, dataBase64: program.toString('base64') }),
    [genuineAddress]: state({ dataBase64: fixture.account.data[0] }),
    [UNLINKED_PROGRAM_DATA]: state({ dataBase64: fixture.account.data[0] }),
    [prepared.signers.intruder]: null,
    [prepared.signers.rentPayer]: state({ owner: SYSTEM, lamports: '100000000', dataBase64: '' }),
  } };
}
function scenario(kind: 'config' | 'custody', mutation: 'uninitialized-programdata' | 'wrong-programdata'): Scenario {
  return scenariosFor('canonical').find(s => s.id === `${kind}-${mutation}`)!;
}
function finality(code: number): Finalized {
  return { classification: 'finalized-program-failure', signature: 'public-test-signature', wireBase64: '', slot: '11', fee: '5000',
    err: { InstructionError: [0n, { Custom: BigInt(code) }] }, logs: [`Program ${PACTWOVEN_PROGRAM_ADDRESS} invoke [1]`,
      `Program ${PACTWOVEN_PROGRAM_ADDRESS} failed: custom program error: 0x${code.toString(16)}`] };
}
function after(initial: Snapshot): Snapshot {
  return { ...initial, slot: '11', accounts: { ...initial.accounts,
    [prepared.signers.rentPayer]: { ...initial.accounts[prepared.signers.rentPayer]!, lamports: '99995000' } } };
}

describe('ProgramData negative fixtures', () => {
  it('uses a fixed public digest address and exact synthetic loader metadata without keys', () => {
    assert.deepEqual(Buffer.from(publicKeyBytes(UNLINKED_PROGRAM_DATA)), createHash('sha256').update('pactwoven:chain0:synthetic-unlinked-program-data:v1').digest());
    const fixture = unlinkedProgramDataFixture(prepared), bytes = Buffer.from(fixture.account.data[0], 'base64');
    assert.equal(fixture.pubkey, UNLINKED_PROGRAM_DATA); assert.equal(fixture.account.owner, LOADER);
    assert.equal(fixture.account.executable, false); assert.equal(fixture.account.lamports, 10000000n);
    assert.equal(bytes.length, 45); assert.equal(bytes.readUInt32LE(), 3); assert.equal(bytes.readBigUInt64LE(4), 0n);
    assert.equal(bytes[12], 1); assert.deepEqual(bytes.subarray(13), Buffer.from(publicKeyBytes(prepared.signers.bootstrapAuthority)));
    assert.deepEqual(fixtureAccounts('canonical', prepared).map(a => [a.file, a.value.pubkey]),
      [['mint.json', CHAIN0_MINT], ['unlinked-program-data.json', UNLINKED_PROGRAM_DATA]]);
    assert.deepEqual(fixtureAccounts('prefunded', prepared).map(a => a.file), ['mint.json']);
    assert.throws(() => unlinkedProgramDataFixture({ ...prepared, signers: { ...prepared.signers, intruder: UNLINKED_PROGRAM_DATA } }), /collision/);
  });
  for (const kind of ['config', 'custody'] as const) {
    it(`${kind} preserves distinct missing and initialized-unlinked exact-code scenarios`, async () => {
      const absent = scenario(kind, 'uninitialized-programdata'), unlinked = scenario(kind, 'wrong-programdata');
      assert.equal(absent.errorCode, 3012); assert.equal(unlinked.errorCode, 6004);
      assert.equal((await buildScenario(absent, context))[0]!.accounts[4]!.address, prepared.signers.intruder);
      assert.equal((await buildScenario(unlinked, context))[0]!.accounts[4]!.address, UNLINKED_PROGRAM_DATA);
      assertProgramDataSubstitution(absent, context, before()); assertProgramDataSubstitution(unlinked, context, before());
      assert.throws(() => assertProgramDataSubstitution({ ...unlinked, errorCode: 3012 }, context, before()));
      assert.throws(() => assertProgramDataSubstitution({ ...absent, errorCode: 6004 }, context, before()));
    });
    it(`${kind} absent substitution requires an explicitly absent snapshot`, () => {
      const s = scenario(kind, 'uninitialized-programdata');
      for (const replacement of [state({ owner: SYSTEM, lamports: '0' }), state({ owner: SYSTEM, lamports: '1' }), state()]) {
        const initial = before(); initial.accounts[prepared.signers.intruder] = replacement;
        assert.throws(() => assertProgramDataSubstitution(s, context, initial), /absent/);
      }
      const missing = before(); delete missing.accounts[prepared.signers.intruder];
      assert.throws(() => assertProgramDataSubstitution(s, context, missing), /absent/);
    });
    it(`${kind} initialized substitution requires every exact public fixture field`, () => {
      const s = scenario(kind, 'wrong-programdata');
      for (const patch of [{ owner: SYSTEM }, { executable: true }, { lamports: '0' }, { lamports: '9999999' },
        { dataBase64: '' }, { dataBase64: Buffer.alloc(45).toString('base64') },
        { dataBase64: Buffer.concat([Buffer.from(before().accounts[UNLINKED_PROGRAM_DATA]!.dataBase64, 'base64'), Buffer.from([0])]).toString('base64') }]) {
        const initial = before(); Object.assign(initial.accounts[UNLINKED_PROGRAM_DATA]!, patch);
        assert.throws(() => assertProgramDataSubstitution(s, context, initial), /fixture changed/);
      }
      for (const offset of [4, 12, 13]) {
        const initial = before(), data = Buffer.from(initial.accounts[UNLINKED_PROGRAM_DATA]!.dataBase64, 'base64');
        data[offset] = data[offset]! ^ 1; initial.accounts[UNLINKED_PROGRAM_DATA]!.dataBase64 = data.toString('base64');
        assert.throws(() => assertProgramDataSubstitution(s, context, initial), /fixture changed/);
      }
      assert.throws(() => assertProgramDataSubstitution(s, { ...context, programData: UNLINKED_PROGRAM_DATA }, before()));
      assert.throws(() => assertProgramDataSubstitution(s, { ...context, deploymentSlot: 1n }, before()));
      const missing = before(); missing.accounts[UNLINKED_PROGRAM_DATA] = null;
      assert.throws(() => assertProgramDataSubstitution(s, context, missing));
    });
    it(`${kind} verifies live genuine linkage and metadata before either substitution`, () => {
      for (const mutation of ['uninitialized-programdata', 'wrong-programdata'] as const) {
        const s = scenario(kind, mutation);
        for (const target of [PACTWOVEN_PROGRAM_ADDRESS, genuineAddress]) {
          const initial = before(); initial.accounts[target] = null;
          assert.throws(() => assertProgramDataSubstitution(s, context, initial));
        }
        const changed = before(), bytes = Buffer.from(changed.accounts[genuineAddress]!.dataBase64, 'base64');
        bytes[4] = 1; changed.accounts[genuineAddress]!.dataBase64 = bytes.toString('base64');
        assert.throws(() => assertProgramDataSubstitution(s, context, changed), /metadata changed/);
      }
    });
    it(`${kind} negatives retain exact failure, intended-program logs and fee-only rollback`, () => {
      for (const mutation of ['uninitialized-programdata', 'wrong-programdata'] as const) {
        const s = scenario(kind, mutation), initial = before(), final = finality(s.errorCode!);
        assertNegativeOutcome(final, s, initial, after(initial), prepared.signers.rentPayer);
        assert.throws(() => assertNegativeOutcome(finality(s.errorCode === 3012 ? 6004 : 3012), s, initial, after(initial), prepared.signers.rentPayer), /Unexpected program error/);
        assert.throws(() => assertNegativeOutcome({ ...final, logs: [] }, s, initial, after(initial), prepared.signers.rentPayer), /Missing intended/);
        assert.throws(() => assertNegativeOutcome({ ...final, logs: [`Program ${SYSTEM} invoke [1]`, `Program ${SYSTEM} failed: error`] }, s, initial, after(initial), prepared.signers.rentPayer), /Missing intended/);
        assert.throws(() => assertNegativeOutcome({ ...final, err: { InstructionError: [1n, { Custom: BigInt(s.errorCode!) }] } }, s, initial, after(initial), prepared.signers.rentPayer), /position/);
        assert.throws(() => assertNegativeOutcome({ ...final, classification: 'finalized-success' }, s, initial, after(initial), prepared.signers.rentPayer), /Negative did not/);
        assert.throws(() => assertNegativeOutcome({ ...final, fee: '4999' }, s, initial, after(initial), prepared.signers.rentPayer), /debit/);
        const changed = after(initial); changed.accounts[UNLINKED_PROGRAM_DATA] = null;
        assert.throws(() => assertNegativeOutcome(final, s, initial, changed, prepared.signers.rentPayer), /rollback|changed|account/i);
      }
    });
  }
});
