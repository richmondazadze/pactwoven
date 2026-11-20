import { fileURLToPath } from 'node:url';
import { generateKeyPairSigner } from '@solana/kit';
import { deriveCustodyAddresses } from '../../client/src/identity.js';
import { FIXTURE_IDS, ORGANIZATION, RESPONSIBILITY, ROLES, RUN, absent, boundedRead, check, durableWrite,
  fixturePath, keyPath, loadInputs, outputPath, parsePrepared, privateDirectory, readJson, sha256, writeJson,
  type Prepared, type Role, type FixtureManifest } from './manifest.js';
import { fixtureAccounts, needsBaseline, type CanonicalBaseline } from './adversarial-fixtures.js';
import { inspectWire, fromBase64, losslessStringify } from './rpc.js';

export async function prepareMain(argv: string[]): Promise<void> {
  check(argv.length === 1 && (argv[0] === '--prepare' || argv[0] === '--derive-fixtures'), 'Explicit reviewed preparation mode required');
  const { inputs, inputHash } = await loadInputs();
  await privateDirectory(RUN);
  const preparedFile = outputPath('prepared.json');
  let prepared: Prepared;
  if (argv[0] === '--prepare') {
    check(await absent(preparedFile) && await absent(outputPath('keys')) && await absent(outputPath('fixtures')), 'Preparation may not replace/reuse outputs');
    await privateDirectory(outputPath('keys'));
    const signers = {} as Record<Role, string>;
    for (const role of ROLES) {
      const signer = await generateKeyPairSigner(true);
      const privateDer = new Uint8Array(await crypto.subtle.exportKey('pkcs8', signer.keyPair.privateKey));
      const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', signer.keyPair.publicKey));
      check(privateDer.length === 48 && Buffer.from(privateDer.subarray(0, 16)).toString('hex') === '302e020100300506032b657004220420'
        && publicBytes.length === 32, 'Unexpected Ed25519 export');
      const secret = new Uint8Array(64); secret.set(privateDer.subarray(16)); secret.set(publicBytes, 32);
      try { await writeJson(keyPath(role), [...secret]); } finally { secret.fill(0); privateDer.fill(0); }
      signers[role] = signer.address;
    }
    prepared = parsePrepared({ schema: 'pactwoven-chain0-prepared-v1', runId: inputs.runId, inputHash, signers }, inputs, inputHash);
    await writeJson(preparedFile, prepared);
  } else prepared = parsePrepared(await readJson(preparedFile), inputs, inputHash);
  const preparedHash = sha256(await boundedRead(preparedFile));
  let baseline: CanonicalBaseline | undefined; let baselineSha256: string | null = null;
  if (argv[0] === '--derive-fixtures') {
    const raw = await boundedRead(fixturePath('canonical', 'evidence/baseline.json'));
    baselineSha256 = sha256(raw); baseline = JSON.parse(raw.toString()) as CanonicalBaseline;
    check(baseline.schema === 'pactwoven-chain0-canonical-baseline-v1' && baseline.runId === prepared.runId
      && baseline.inputHash === inputHash && baseline.preparedHash === preparedHash, 'Unrelated canonical baseline');
    for (const [identity, finality] of [[baseline.configIdentity, baseline.configFinality], [baseline.custodyIdentity, baseline.custodyFinality]] as const) {
      const wire = inspectWire(fromBase64(identity.wireBase64));
      check(wire.signature === identity.signature && wire.wireSha256 === identity.wireSha256
        && finality.classification === 'finalized-success' && finality.signature === wire.signature && finality.wireBase64 === wire.wireBase64,
      'Baseline is not linked to canonical signed success');
    }
    const addresses = await deriveCustodyAddresses(ORGANIZATION, RESPONSIBILITY);
    check(baseline.configAddress === addresses.config && baseline.registrationAddress === addresses.registration
      && baseline.vaultAddress === addresses.vault, 'Baseline address mismatch');
  }
  for (const id of FIXTURE_IDS.filter(id => needsBaseline(id) === (argv[0] === '--derive-fixtures'))) {
    check(await absent(fixturePath(id, 'fixture.json')) && await absent(fixturePath(id, 'ledger')), 'Fixture/ledger already exists');
    const accounts = fixtureAccounts(id, prepared, baseline);
    const manifest: FixtureManifest = { schema: 'pactwoven-chain0-fixture-v1', id, runId: prepared.runId, inputHash,
      synthetic: true, baselineSha256, accounts: [] };
    for (const account of accounts) {
      const raw = `${losslessStringify(account.value)}\n`;
      await durableWrite(fixturePath(id, account.file), raw);
      manifest.accounts.push({ address: account.value.pubkey, file: account.file, sha256: sha256(raw) });
    }
    await writeJson(fixturePath(id, 'fixture.json'), manifest);
  }
}
// Importing preparation is inert. Only the explicitly selected compiled CLI can generate keys.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareMain(process.argv.slice(2));
}
