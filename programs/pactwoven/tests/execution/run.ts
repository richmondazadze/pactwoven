import { fileURLToPath } from 'node:url';
import { CHAIN0_MINT, CHAIN0_TOKEN_PROGRAM, PACTWOVEN_PROGRAM_ADDRESS } from '../../client/src/identity.js';
import { decodeLoaderProgram, decodeProgramData } from '../independent-layout.js';
import { LOADER, PROGRAM_HASH, ROLES, absent, boundedRead, check, evidenceJson, filesIn, fixtureId, fixturePath,
  loadInputs, loadReceipt, loadSigner, outputPath, parseFixture, parsePrepared, readJson, record, sha256, writeJson,
  type Role } from './manifest.js';
import { LocalRpc, capturedRpc, fromBase64, inspectWire, losslessStringify, recoverOriginal, snapshot, u64, type Rpc } from './rpc.js';
import { fixtureAccounts, needsBaseline, type CanonicalBaseline } from './adversarial-fixtures.js';
import { ExposureBudget, executeHarness, scenariosFor, type Attempt } from './harness.js';
import type { KeyPairSigner } from '@solana/kit';

async function recoverOnly(id: ReturnType<typeof fixtureId>, rpc: Rpc, runId: string): Promise<void> {
  const directory = fixturePath(id, 'evidence/attempts');
  const files = await filesIn(directory), budget = new ExposureBudget();
  check(await absent(fixturePath(id, 'evidence/recovery.json')), 'Recovery receipt already exists');
  const results: unknown[] = [];
  const reservations = files.filter(name => /^\d{3}\.reservation\.json$/.test(name));
  for (const [index, name] of reservations.entries()) {
    const reservation = record(await readJson(`${directory}/${name}`));
    check(reservation['sequence'] === index + 1 && scenariosFor(id).some(s => s.id === reservation['scenario']), 'Invalid reservation chain');
    const state = budget.reserve(u64(reservation['exposure']), 1);
    check(state.cumulative === reservation['cumulative'], 'Reservation cumulative mismatch');
    const signed = name.replace('.reservation.json', '.signed.json');
    if (!files.includes(signed)) { results.push({ sequence: index + 1, classification: 'reserved-without-submittable-wire' }); continue; }
    const attempt = await readJson(`${directory}/${signed}`) as Attempt;
    check(attempt.schema === 'pactwoven-chain0-attempt-v1' && attempt.fixture === id && attempt.runId === runId && attempt.sequence === index + 1
      && attempt.reservedDebit === reservation['exposure'] && attempt.cumulativeReservedDebit === reservation['cumulative'], 'Attempt identity mismatch');
    const original = inspectWire(fromBase64(attempt.identity.wireBase64));
    check(evidenceJson(original) === evidenceJson(attempt.identity), 'Stored original identity mismatch');
    // Recovery only authenticates the exact original transaction. It never builds, signs or sends a replacement.
    const finality = await recoverOriginal(rpc, original);
    results.push({ sequence: index + 1, signature: original.signature, finality, scenarioAcceptance: 'requires original before/after and scenario review' });
  }
  await writeJson(fixturePath(id, 'evidence/recovery.json'), { results, reservedDebit: budget.reserved, transactions: budget.transactions });
}

export async function runMain(argv: string[]): Promise<void> {
  check(argv.length === 2 && (argv[0] === '--execute' || argv[0] === '--recover'), 'Explicit single-fixture execution/recovery mode required');
  const id = fixtureId(argv[1]), { inputs, inputHash } = await loadInputs();
  const preparedBytes = await boundedRead(outputPath('prepared.json'));
  const prepared = parsePrepared(JSON.parse(preparedBytes.toString()), inputs, inputHash), preparedHash = sha256(preparedBytes);
  const fixtureBytes = await boundedRead(fixturePath(id, 'fixture.json'));
  const fixture = parseFixture(JSON.parse(fixtureBytes.toString()), prepared, id);
  const { receipt, receiptHash } = await loadReceipt(inputs, inputHash, preparedHash, id, sha256(fixtureBytes));
  let baseline: CanonicalBaseline | undefined;
  if (needsBaseline(id)) {
    const raw = await boundedRead(fixturePath('canonical', 'evidence/baseline.json'));
    check(sha256(raw) === fixture.baselineSha256, 'Canonical baseline hash mismatch');
    baseline = JSON.parse(raw.toString()) as CanonicalBaseline;
    check(baseline.preparedHash === preparedHash && baseline.inputHash === inputHash && baseline.runId === prepared.runId, 'Unrelated adversarial baseline');
  } else check(fixture.baselineSha256 === null, 'Unexpected baseline');
  const expectedAccounts = fixtureAccounts(id, prepared, baseline);
  check(expectedAccounts.length === fixture.accounts.length, 'Fixture account count mismatch');
  for (const [index, expected] of expectedAccounts.entries()) {
    const entry = fixture.accounts[index]!;
    check(entry.address === expected.value.pubkey && entry.file === expected.file, 'Fixture account identity mismatch');
    const raw = await boundedRead(fixturePath(id, entry.file));
    check(sha256(raw) === entry.sha256 && raw.toString() === `${losslessStringify(expected.value)}\n`, 'Fixture source mutation');
  }
  const mode = argv[0] === '--recover' ? 'recovery' : 'execution';
  await writeJson(fixturePath(id, `evidence/${mode}.lock`), { runId: inputs.runId, receiptHash });
  // Separate capture directories permit read-only recovery without replacing prior raw observations.
  const rpc = mode === 'execution' ? capturedRpc(id) : new LocalRpc(async (name, raw) => {
    const { durableWrite } = await import('./manifest.js'); await durableWrite(fixturePath(id, `evidence/recovery-rpc/${name}`), raw);
  });
  check(await rpc.call('getGenesisHash') === receipt.expectedGenesis, 'RPC genesis does not match independently owned startup receipt');
  if (mode === 'recovery') { await recoverOnly(id, rpc, inputs.runId); return; }
  const initial = await snapshot(rpc, [PACTWOVEN_PROGRAM_ADDRESS, CHAIN0_TOKEN_PROGRAM, prepared.signers.rentPayer,
    ...fixture.accounts.map(account => account.address)]);
  const program = initial.accounts[PACTWOVEN_PROGRAM_ADDRESS];
  check(program && program.owner === LOADER && program.executable, 'Not the actual loader-v3 Pactwoven program');
  const { programData } = decodeLoaderProgram(fromBase64(program.dataBase64));
  const loaderState = await snapshot(rpc, [programData], u64(initial.slot));
  const loaderAccount = loaderState.accounts[programData];
  check(loaderAccount && loaderAccount.owner === LOADER && !loaderAccount.executable, 'Invalid ProgramData owner/flags');
  const bytes = fromBase64(loaderAccount.dataBase64), loader = decodeProgramData(bytes);
  check(sha256(bytes.subarray(45, 45 + 242_312)) === PROGRAM_HASH && bytes.subarray(45 + 242_312).every(b => b === 0), 'Loaded SBF body differs from frozen binary');
  const expectedAuthority = id === 'upgrade-null' ? null : id === 'upgrade-substitution' ? prepared.signers.intruder : prepared.signers.bootstrapAuthority;
  check(loader.authority === expectedAuthority, 'Unexpected actual upgrade authority');
  check(loader.slot === (id === 'deployment-slot' ? 1n : 0n), 'Unexpected genesis deployment slot');
  const token = initial.accounts[CHAIN0_TOKEN_PROGRAM];
  check(token && token.executable && [LOADER, 'BPFLoader2111111111111111111111111111111111'].includes(token.owner), 'Original SPL program is not executable');
  const payer = initial.accounts[prepared.signers.rentPayer];
  check(payer && payer.lamports === '500000000000000000', 'Unexpected synthetic genesis payer funding');
  for (const expected of expectedAccounts) {
    const actual = initial.accounts[expected.value.pubkey];
    check(actual && actual.owner === expected.value.account.owner && actual.executable === expected.value.account.executable
      && actual.dataBase64 === expected.value.account.data[0] && u64(actual.lamports) === expected.value.account.lamports, 'Actual genesis fixture mismatch');
  }
  check(initial.accounts[CHAIN0_MINT], 'Synthetic mint missing');
  await writeJson(fixturePath(id, 'evidence/startup-verified.json'), { receipt, initial, loaderState,
    loadedProgramHash: PROGRAM_HASH, actualLocalGenesis: receipt.expectedGenesis, configuredNamespace: 'devnet', fixtureSynthetic: true });
  const signers = {} as Record<Role, KeyPairSigner>;
  for (const role of ROLES) signers[role] = await loadSigner(role, prepared);
  await executeHarness({ id, prepared, preparedHash, genesis: receipt.expectedGenesis, programData, deploymentSlot: loader.slot, signers, rpc });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runMain(process.argv.slice(2));
