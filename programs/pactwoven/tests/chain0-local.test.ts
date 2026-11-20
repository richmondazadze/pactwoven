import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { address } from '@solana/kit';
import {
  CHAIN0_ASSET_KEY_HEX, CHAIN0_GENESIS, CHAIN0_MINT, CHAIN0_TOKEN_PROGRAM,
  PACTWOVEN_PROGRAM_ADDRESS, computeConfigIntentHash, computeCustodyIntentHash,
  computePhysicalAssetKey, computeSetupPolicyHash, configOperationKey, custodyOperationKey,
  decodeHash32, deriveConfigAddress, deriveCustodyAddresses, encodeHex, registrationKeys, uuidBytes,
  type ConfigIntent, type CustodyIntent,
} from '../client/src/identity.js';
import {
  getCustodyRegistrationEncoder, getCustodyRegistrationDecoder,
  getProgramConfigEncoder, getProgramConfigDecoder,
  getInitializeCustodyInstructionDataEncoder, getInitializeProgramConfigInstructionDataEncoder,
} from '../client/src/generated/index.js';
import { decodeConfigBytes, decodeRegistrationBytes, independentHash, publicKeyBytes } from './independent-layout.js';
import { assertLoopbackRpc, syntheticMintFixture } from './local-fixtures.js';

const organizationUuid = '00112233-4455-6677-8899-aabbccddeeff';
const responsibilityUuid = '10213243-5465-7687-98a9-bacbdcedfe0f';
const owner = address('GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz');
const registrar = address('CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT');
const fixtureHash = () => new Uint8Array(32).fill(7);

describe('CHAIN-0 offline identity and actual generated-client contract', () => {
  it('uses only the compiled initialization instruction/account surface', async () => {
    const idl = JSON.parse(await readFile(new URL('../../../target/idl/pactwoven.json', import.meta.url), 'utf8'));
    assert.equal(idl.address, PACTWOVEN_PROGRAM_ADDRESS);
    assert.deepEqual(idl.instructions.map((item: { name: string }) => item.name).sort(), ['initialize_custody', 'initialize_program_config']);
    assert.deepEqual(idl.accounts.map((item: { name: string }) => item.name).sort(), ['CustodyRegistration', 'ProgramConfig']);
    const metas = (name: string) => idl.instructions.find((item: { name: string }) => item.name === name).accounts
      .map((item: { name: string; signer?: boolean; writable?: boolean; pda?: unknown }) => [item.name, item.signer ?? false, item.writable ?? false, item.pda ?? null]);
    assert.deepEqual(metas('initialize_program_config'), [
      ['rent_payer', true, true, null], ['bootstrap_authority', true, false, null], ['registrar', true, false, null],
      ['pactwoven_program', false, false, null], ['program_data', false, false, null], ['config', false, true, null],
      ['mint', false, false, null], ['token_program', false, false, null], ['system_program', false, false, null],
    ]);
    assert.deepEqual(metas('initialize_custody'), [
      ['rent_payer', true, true, null], ['owner', true, false, null], ['registrar', true, false, null],
      ['pactwoven_program', false, false, null], ['program_data', false, false, null], ['config', false, false, null],
      ['registration', false, true, null], ['vault', false, true, null], ['mint', false, false, null],
      ['token_program', false, false, null], ['system_program', false, false, null],
    ]);
  });

  it('matches the accepted asset hash with a separate Node hash/base58 oracle', async () => {
    const actual = encodeHex(await computePhysicalAssetKey());
    const independent = independentHash('pactwoven:solana-asset:v1', publicKeyBytes(CHAIN0_GENESIS), publicKeyBytes(CHAIN0_TOKEN_PROGRAM), publicKeyBytes(CHAIN0_MINT));
    assert.equal(actual, CHAIN0_ASSET_KEY_HEX);
    assert.equal(Buffer.from(independent).toString('hex'), CHAIN0_ASSET_KEY_HEX);
  });

  it('matches independent fixed hash and PDA reference vectors', async () => {
    const derived = await deriveCustodyAddresses(organizationUuid, responsibilityUuid);
    assert.equal(derived.config, '6nCoQdJQFYiz4s8JY3d5oZb38hBrTJayvxk5xib9SvDs');
    assert.equal(derived.registration, '5hjBxuek2xmzGN72Dbkritxbcu1VfPNWh2S7p6SYa7b6');
    assert.equal(derived.vault, 'J4m5cddfaxefvhQuxt6YbvVtLFpfA8DuNqzCXyBa7uvz');
    assert.deepEqual([derived.configBump, derived.registrationBump, derived.vaultBump], [255, 255, 255]);
    assert.equal(encodeHex(derived.organizationKey), '766b01ef35f929183abfe663fd4989949a3ef69cad5b1e845b0409fb0fd6259f');
    assert.equal(encodeHex(derived.responsibilityKey), '64b76f0c373df4a211aa0dc2b11b6aef9d379f62cdb6a54c3d4fcf09ea0fc252');
  });

  it('normalizes UUID text but rejects nil, malformed and ambiguous input', () => {
    assert.deepEqual(uuidBytes(organizationUuid), uuidBytes(organizationUuid.toUpperCase()));
    for (const invalid of ['', organizationUuid.replaceAll('-', ''), ` ${organizationUuid}`, '00000000-0000-0000-0000-000000000000']) {
      assert.throws(() => uuidBytes(invalid));
    }
    for (const invalid of ['0', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) assert.throws(() => decodeHash32(invalid));
  });

  it('separates responsibility identity by organization and operation domain', async () => {
    const first = await registrationKeys(organizationUuid, responsibilityUuid);
    const second = await registrationKeys(responsibilityUuid, organizationUuid);
    assert.notDeepEqual(first.responsibilityKey, second.responsibilityKey);
    const { config } = await deriveConfigAddress();
    assert.notDeepEqual(await configOperationKey(config), await custodyOperationKey(config));
  });

  it('encodes instruction discriminators and arguments in the exact fixed order', () => {
    assert.equal(Buffer.from(getInitializeProgramConfigInstructionDataEncoder().encode({})).toString('hex'), '06833ded286e537c');
    const data = getInitializeCustodyInstructionDataEncoder().encode({
      organizationUuid: uuidBytes(organizationUuid), responsibilityUuid: uuidBytes(responsibilityUuid), ownerBindingHash: fixtureHash(),
    });
    assert.equal(data.length, 72);
    assert.equal(Buffer.from(data.subarray(0, 8)).toString('hex'), 'e5dae478d0efdfea');
    assert.deepEqual(Buffer.from(data.subarray(8, 24)), Buffer.from(uuidBytes(organizationUuid)));
    assert.deepEqual(Buffer.from(data.subarray(24, 40)), Buffer.from(uuidBytes(responsibilityUuid)));
    assert.deepEqual(Buffer.from(data.subarray(40)), Buffer.from(fixtureHash()));
  });

  it('matches the independent config byte layout and lossless u64 fields', async () => {
    const { config, configBump } = await deriveConfigAddress();
    const deploymentSlot = 9_007_199_254_740_993n;
    const intent = { config, programData: PACTWOVEN_PROGRAM_ADDRESS, deploymentSlot, bootstrapAuthority: owner, registrar, rentPayer: owner };
    const body = {
      version: 1, bump: configBump, stage: 0, environment: 1, decimals: 6, reserved: new Uint8Array(3),
      programData: intent.programData, bootstrapAuthority: owner, registrar, rentPayer: owner,
      genesis: publicKeyBytes(CHAIN0_GENESIS), tokenProgram: CHAIN0_TOKEN_PROGRAM, mint: CHAIN0_MINT,
      physicalAssetKey: decodeHash32(CHAIN0_ASSET_KEY_HEX), setupPolicyHash: await computeSetupPolicyHash(),
      setupOperationKey: await configOperationKey(config), setupIntentHash: await computeConfigIntentHash(intent),
      programDeploymentSlot: deploymentSlot, createdSlot: 18_446_744_073_709_551_615n,
    };
    const encoded = getProgramConfigEncoder().encode(body);
    assert.equal(encoded.length, 384);
    const independent = decodeConfigBytes(encoded);
    assert.equal(independent.genesis, CHAIN0_GENESIS);
    assert.equal(independent.programData, intent.programData);
    assert.equal(independent.bootstrapAuthority, owner);
    assert.equal(independent.registrar, registrar);
    assert.equal(independent.rentPayer, owner);
    assert.equal(independent.physicalAssetKey, CHAIN0_ASSET_KEY_HEX);
    assert.equal(independent.setupIntentHash, encodeHex(body.setupIntentHash));
    assert.equal(independent.programDeploymentSlot, deploymentSlot);
    assert.equal(independent.createdSlot, body.createdSlot);
    assert.equal(getProgramConfigDecoder().decode(encoded).createdSlot, body.createdSlot);
    assert.throws(() => decodeConfigBytes(encoded.subarray(1)));
    const corrupt = new Uint8Array(encoded); corrupt[0] = 0;
    assert.throws(() => decodeConfigBytes(corrupt));
    await assert.rejects(computeConfigIntentHash({ ...intent, deploymentSlot: -1n }));
    await assert.rejects(computeConfigIntentHash({ ...intent, deploymentSlot: 1n << 64n }));
    assert.notDeepEqual(body.setupIntentHash, await computeConfigIntentHash({ ...intent, rentPayer: registrar }));
  });

  it('matches the registration byte layout and binds changed setup intent to the same operation', async () => {
    const derived = await deriveCustodyAddresses(organizationUuid, responsibilityUuid);
    const input = { ...derived, configIntentHash: fixtureHash(), owner, registrar, rentPayer: owner, ownerBindingHash: fixtureHash() };
    const body = {
      version: 1, bump: derived.registrationBump, vaultBump: derived.vaultBump, stage: 0, reserved: new Uint8Array(4),
      config: derived.config, organizationKey: derived.organizationKey, responsibilityKey: derived.responsibilityKey,
      physicalAssetKey: decodeHash32(CHAIN0_ASSET_KEY_HEX), owner, registrar, rentPayer: owner, vault: derived.vault,
      ownerBindingHash: input.ownerBindingHash, setupOperationKey: await custodyOperationKey(derived.registration),
      setupIntentHash: await computeCustodyIntentHash(input), createdSlot: 9_007_199_254_740_993n,
    };
    const encoded = getCustodyRegistrationEncoder().encode(body);
    assert.equal(encoded.length, 376);
    const independent = decodeRegistrationBytes(encoded);
    assert.equal(independent.config, derived.config);
    assert.equal(independent.organizationKey, encodeHex(derived.organizationKey));
    assert.equal(independent.responsibilityKey, encodeHex(derived.responsibilityKey));
    assert.equal(independent.owner, owner);
    assert.equal(independent.registrar, registrar);
    assert.equal(independent.rentPayer, owner);
    assert.equal(independent.vault, derived.vault);
    assert.equal(independent.setupIntentHash, encodeHex(body.setupIntentHash));
    assert.equal(independent.createdSlot, body.createdSlot);
    assert.equal(getCustodyRegistrationDecoder().decode(encoded).createdSlot, body.createdSlot);
    assert.notDeepEqual(body.setupIntentHash, await computeCustodyIntentHash({ ...input, owner: registrar }));
    assert.notDeepEqual(body.setupIntentHash, await computeCustodyIntentHash({ ...input, ownerBindingHash: new Uint8Array(32).fill(8) }));
    assert.deepEqual(body.setupOperationKey, await custodyOperationKey(derived.registration));
    await assert.rejects(computeCustodyIntentHash({ ...input, ownerBindingHash: new Uint8Array(32) }));
    await assert.rejects(computeCustodyIntentHash({ ...input, configIntentHash: new Uint8Array(31) }));
  });

  it('restricts future local execution to explicit numeric loopback URLs', () => {
    assert.equal(assertLoopbackRpc('http://127.0.0.1:18999'), 'http://127.0.0.1:18999');
    for (const url of ['https://api.devnet.solana.com', 'http://localhost:8899', 'http://127.0.0.1',
      'http://user:password@127.0.0.1:8899', 'http://127.0.0.1:8899/path', 'http://127.0.0.1:8899/?key=value']) {
      assert.throws(() => assertLoopbackRpc(url));
    }
  });

  it('snapshots config intent before asynchronous hashing', async () => {
    const { config } = await deriveConfigAddress();
    const input: ConfigIntent = { config, programData: PACTWOVEN_PROGRAM_ADDRESS, deploymentSlot: 42n, bootstrapAuthority: owner, registrar, rentPayer: owner };
    const expected = await computeConfigIntentHash(input);
    const pending = computeConfigIntentHash(input);
    input.config = owner;
    input.programData = registrar;
    input.deploymentSlot = 99n;
    input.registrar = owner;
    input.rentPayer = registrar;
    assert.deepEqual(await pending, expected);
  });

  it('snapshots custody intent addresses and buffers before asynchronous hashing', async () => {
    const derived = await deriveCustodyAddresses(organizationUuid, responsibilityUuid);
    const configIntentHash = fixtureHash();
    const ownerBindingHash = fixtureHash();
    const input: CustodyIntent = { ...derived, configIntentHash, owner, registrar, rentPayer: owner, ownerBindingHash };
    const expected = await computeCustodyIntentHash(input);
    const pending = computeCustodyIntentHash(input);
    input.registration = owner;
    input.owner = registrar;
    ownerBindingHash.fill(9);
    configIntentHash.fill(8);
    derived.organizationKey.fill(4);
    assert.deepEqual(await pending, expected);
  });

  it('labels and constructs only synthetic genesis mint bytes', () => {
    const fixture = syntheticMintFixture();
    assert.equal(fixture.pubkey, CHAIN0_MINT);
    assert.equal(fixture.account.owner, CHAIN0_TOKEN_PROGRAM);
    const data = Buffer.from(fixture.account.data[0]!, 'base64');
    assert.equal(data.length, 82);
    assert.equal(data[44], 6);
    assert.equal(data[45], 1);
    assert.equal(data.readBigUInt64LE(36), 0n);
  });
});
