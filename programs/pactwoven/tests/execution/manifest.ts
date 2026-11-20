import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { publicKeyBytes } from '../independent-layout.js';

export const INPUT = '/work/input';
export const RUN = '/work/run';
export const RECEIPTS = '/work/receipts';
export const RPC_URL = 'http://127.0.0.1:19099';
export const VALIDATOR = '/work/runtime/solana-test-validator';
export const BASE_IMAGE = 'sha256:70a832c538c185e6a1a5387d46fc5b615363c50d49dcf50505879ee3f39c6001';
export const VALIDATOR_HASH = '493db974bc1a1eb62c413561dd9739455e5afd9abd7367fe7aff9389c0865ce2';
export const PROGRAM_HASH = '109382e8f0e7cf681de2dc02ebad4997ce358e08d71e6f6680c868ec17f741d3';
export const IDL_HASH = '87030570bb9d57b3308df5b4b5fc13f39a4e2843dce10d4406156c70415aab0b';
export const CAPS = Object.freeze({ transactions: 64, instructions: 2, lamports: 1_000_000_000n,
  wireBytes: 1232, responseBytes: 3_000_000, totalResponseBytes: 64_000_000, rpcCalls: 5000, requestMs: 10_000, fixtureMs: 900_000 });
export const ROLES = ['rentPayer', 'bootstrapAuthority', 'registrar', 'owner', 'intruder'] as const;
export type Role = typeof ROLES[number];
export const FIXTURE_IDS = ['canonical', 'prefunded', 'mint-decimals', 'mint-authority', 'mint-freeze',
  'mint-owner', 'mint-size', 'registration-foreign', 'registration-nonempty', 'registration-initialized',
  'vault-foreign', 'vault-nonempty', 'vault-initialized', 'config-version', 'config-stage', 'config-hash',
  'config-discriminator', 'config-size', 'deployment-slot', 'upgrade-null', 'upgrade-substitution'] as const;
export type FixtureId = typeof FIXTURE_IDS[number];
export const ORGANIZATION = '00112233-4455-6677-8899-aabbccddeeff';
export const RESPONSIBILITY = '10213243-5465-7687-98a9-bacbdcedfe0f';
export const BINDING_HEX = '07'.repeat(32);
export const SYSTEM = '11111111111111111111111111111111';
export const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function record(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  check(input !== null && typeof input === 'object' && !Array.isArray(input), 'Expected object');
  const value = input as Record<string, unknown>;
  if (keys) check(Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'Unexpected/missing schema fields');
  return value;
}
export function string(input: unknown): string { check(typeof input === 'string', 'Expected string'); return input; }
export function hash(input: unknown): string { const v = string(input); check(/^[a-f0-9]{64}$/.test(v), 'Invalid SHA-256'); return v; }
export function key(input: unknown): string { const v = string(input); publicKeyBytes(v); return v; }
export function sha256(input: string | Uint8Array): string { return createHash('sha256').update(input).digest('hex'); }
export function fixtureId(input: unknown): FixtureId {
  check(FIXTURE_IDS.includes(input as FixtureId), 'Unreviewed fixture'); return input as FixtureId;
}
export function localGenesis(input: unknown): string {
  const v = key(input);
  check(!['EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2d6t',
    '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', SYSTEM].includes(v), 'Public or invalid genesis forbidden');
  return v;
}
export function outputPath(relative: string): string {
  check(/^[a-zA-Z0-9][a-zA-Z0-9./_-]*$/.test(relative) && !relative.split('/').some(p => !p || p === '.' || p === '..'), 'Unsafe output path');
  return path.join(RUN, relative);
}
export function fixturePath(id: FixtureId, relative: string): string { return outputPath(`fixtures/${fixtureId(id)}/${relative}`); }
export function receiptPath(id: FixtureId): string { return `${RECEIPTS}/${fixtureId(id)}.json`; }
export function keyPath(role: Role): string { check(ROLES.includes(role), 'Invalid signer role'); return outputPath(`keys/${role}.json`); }

export interface Inputs {
  schema: 'pactwoven-chain0-input-v1'; runId: string; baseImage: typeof BASE_IMAGE; imageId: string;
  rpcUrl: typeof RPC_URL; validatorSha256: typeof VALIDATOR_HASH; files: Record<string, string>;
}
export function parseInputs(input: unknown): Inputs {
  const v = record(input, ['schema', 'runId', 'baseImage', 'imageId', 'rpcUrl', 'validatorSha256', 'files']);
  check(v['schema'] === 'pactwoven-chain0-input-v1' && v['baseImage'] === BASE_IMAGE && v['rpcUrl'] === RPC_URL
    && v['validatorSha256'] === VALIDATOR_HASH, 'Unreviewed runtime input');
  check(/^chain0-[a-z0-9-]{1,48}$/.test(string(v['runId'])), 'Invalid run identity');
  check(/^sha256:[0-9a-f]{64}$/.test(string(v['imageId'])), 'Missing immutable derived image identity');
  const files = record(v['files']);
  check(Object.keys(files).length >= 4 && Object.keys(files).length <= 1000, 'Invalid input closure');
  for (const [name, digest] of Object.entries(files)) {
    check(name.length < 200 && /^(pactwoven\.(so|json)|harness\/[a-zA-Z0-9_/-]+\.mjs)$/.test(name)
      && !name.split('/').some(p => !p || p === '.' || p === '..'), 'Unreviewed input path');
    hash(digest);
  }
  check(files['pactwoven.so'] === PROGRAM_HASH && files['pactwoven.json'] === IDL_HASH, 'Build hash mismatch');
  hash(files['harness/prepare.mjs']); hash(files['harness/run.mjs']);
  return structuredClone(v) as unknown as Inputs;
}
export interface Prepared {
  schema: 'pactwoven-chain0-prepared-v1'; runId: string; inputHash: string; signers: Record<Role, string>;
}
export function parsePrepared(input: unknown, inputs: Inputs, inputHash: string): Prepared {
  const v = record(input, ['schema', 'runId', 'inputHash', 'signers']);
  check(v['schema'] === 'pactwoven-chain0-prepared-v1' && v['runId'] === inputs.runId && v['inputHash'] === inputHash, 'Prepared identity mismatch');
  const signers = record(v['signers'], ROLES);
  ROLES.forEach(role => key(signers[role]));
  check(new Set(Object.values(signers)).size === ROLES.length, 'Test roles must be distinct');
  return v as unknown as Prepared;
}
export interface AccountFile { address: string; file: string; sha256: string }
export interface FixtureManifest {
  schema: 'pactwoven-chain0-fixture-v1'; id: FixtureId; runId: string; inputHash: string;
  synthetic: true; baselineSha256: string | null; accounts: AccountFile[];
}
export function parseFixture(input: unknown, prepared: Prepared, id: FixtureId): FixtureManifest {
  const v = record(input, ['schema', 'id', 'runId', 'inputHash', 'synthetic', 'baselineSha256', 'accounts']);
  check(v['schema'] === 'pactwoven-chain0-fixture-v1' && v['id'] === id && v['runId'] === prepared.runId
    && v['inputHash'] === prepared.inputHash && v['synthetic'] === true, 'Fixture identity mismatch');
  if (v['baselineSha256'] !== null) hash(v['baselineSha256']);
  check(Array.isArray(v['accounts']) && v['accounts'].length >= 1 && v['accounts'].length <= 4, 'Invalid fixture accounts');
  const accounts = v['accounts'].map(a => {
    const f = record(a, ['address', 'file', 'sha256']);
    key(f['address']); hash(f['sha256']);
    check(['mint.json', 'config.json', 'occupied.json', 'program-data.json', 'unlinked-program-data.json'].includes(string(f['file'])), 'Unreviewed fixture account');
    return f as unknown as AccountFile;
  });
  check(new Set(accounts.map(a => a.address)).size === accounts.length && new Set(accounts.map(a => a.file)).size === accounts.length, 'Duplicate fixture account');
  return { ...v, accounts } as unknown as FixtureManifest;
}
export interface Receipt {
  schema: 'pactwoven-chain0-startup-v1'; runId: string; fixture: FixtureId; inputHash: string;
  preparedHash: string; fixtureHash: string; expectedGenesis: string; imageId: string; containerId: string; network: 'none';
}
export function parseReceipt(input: unknown, inputs: Inputs, inputHash: string, preparedHash: string, id: FixtureId, fixtureHash: string): Receipt {
  const v = record(input, ['schema', 'runId', 'fixture', 'inputHash', 'preparedHash', 'fixtureHash', 'expectedGenesis', 'imageId', 'containerId', 'network']);
  check(v['schema'] === 'pactwoven-chain0-startup-v1' && v['runId'] === inputs.runId && v['fixture'] === id
    && v['inputHash'] === inputHash && v['preparedHash'] === preparedHash && v['fixtureHash'] === fixtureHash && v['imageId'] === inputs.imageId && v['network'] === 'none', 'Startup receipt mismatch');
  hash(v['containerId']); localGenesis(v['expectedGenesis']);
  return v as unknown as Receipt;
}
export async function loadReceipt(inputs: Inputs, inputHash: string, preparedHash: string, id: FixtureId, fixtureHash: string) {
  const file = receiptPath(id);
  // The launcher supplies this separate mount read-only. Checking the entire parent chain
  // prevents a workload from replacing a root-owned leaf through a writable directory.
  for (const directory of ['/', '/work', RECEIPTS]) {
    const metadata = await lstat(directory);
    check(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === 0 && (metadata.mode & 0o022) === 0,
      'Receipt ancestors must be protected root-owned directories');
  }
  const metadata = await lstat(file);
  const validFile = (stat: Stats) => stat.isFile() && stat.uid === 0
    && (stat.mode & 0o022) === 0 && stat.nlink === 1 && stat.size > 0 && stat.size <= 16_384;
  check(!metadata.isSymbolicLink() && validFile(metadata), 'Receipt must be a protected root-owned regular file');
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await fd.stat();
    check(validFile(opened) && opened.dev === metadata.dev && opened.ino === metadata.ino && opened.size === metadata.size,
      'Opened receipt does not match the protected root-owned file');
    const bytes = await fd.readFile();
    check(bytes.length === opened.size && bytes.length <= 16_384, 'Receipt changed size during bounded read');
    return { receipt: parseReceipt(JSON.parse(bytes.toString()), inputs, inputHash, preparedHash, id, fixtureHash), receiptHash: sha256(bytes) };
  } finally { await fd.close(); }
}

// Evidence encodes integers as decimal strings. RPC has separate lossless numeric serialization.
export function evidenceJson(input: unknown): string {
  return `${JSON.stringify(input, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`;
}
export async function assertNoSymlinks(file: string): Promise<void> {
  check(path.isAbsolute(file) && path.normalize(file) === file, 'Noncanonical absolute path');
  let current = '/';
  for (const part of file.slice(1).split('/')) {
    current = path.join(current, part);
    check(!(await lstat(current)).isSymbolicLink(), 'Symlink forbidden');
  }
}
export async function boundedRead(file: string, max: number = CAPS.responseBytes): Promise<Buffer> {
  await assertNoSymlinks(file);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    check(stat.isFile() && stat.size <= max, 'File not regular/bounded');
    const bytes = await fd.readFile(); check(bytes.length <= max, 'File grew beyond read cap'); return bytes;
  } finally { await fd.close(); }
}
export async function privateDirectory(file: string): Promise<void> {
  check(file === RUN || file.startsWith(`${RUN}/`), 'Output escaped task volume');
  await assertNoSymlinks(RUN);
  let current = RUN;
  for (const part of path.relative(RUN, file).split('/').filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const s = await lstat(current);
    check(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0 && s.uid === process.getuid?.(), 'Unprotected output directory');
  }
}
export async function durableWrite(file: string, bytes: string | Uint8Array): Promise<void> {
  check(file.startsWith(`${RUN}/`), 'Evidence escaped task volume');
  await privateDirectory(path.dirname(file));
  const fd = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  const directory = await open(path.dirname(file), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function writeJson(file: string, value: unknown): Promise<void> { await durableWrite(file, evidenceJson(value)); }
export async function readJson(file: string, max?: number): Promise<unknown> { return JSON.parse((await boundedRead(file, max)).toString()); }
export async function assertRuntime(): Promise<void> {
  check(process.platform === 'linux' && process.arch === 'x64' && process.getuid?.() === 10001 && process.getgid?.() === 10001, 'Requires isolated Linux UID10001');
  check(process.versions.node === '26.4.0', 'Unqualified Node runtime');
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'PWD', 'SHLVL', '_', 'TERM', 'HOSTNAME']);
  check(Object.keys(process.env).every(k => allowed.has(k)), 'Unreviewed runtime environment');
  const interfaces = networkInterfaces();
  check(Object.keys(interfaces).every(name => name === 'lo') && Object.values(interfaces).flat().every(i => i?.internal), 'Non-loopback interface');
  const routes = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1);
  check(routes.length === 0, 'IPv4 route in isolated namespace');
  await assertNoSymlinks(RUN);
  const s = await lstat(RUN);
  check(s.isDirectory() && (s.mode & 0o077) === 0 && s.uid === 10001, 'Unprotected run volume');
  check(sha256(await boundedRead(VALIDATOR, 400_000_000)) === VALIDATOR_HASH, 'Unqualified validator');
}
export async function loadInputs(): Promise<{ inputs: Inputs; inputHash: string }> {
  await assertRuntime();
  await assertNoSymlinks(INPUT);
  const inputDirectory = await lstat(INPUT), inputFile = await lstat(`${INPUT}/inputs.json`);
  check(inputDirectory.uid !== 10001 && (inputDirectory.mode & 0o022) === 0 && inputFile.uid !== 10001
    && (inputFile.mode & 0o022) === 0, 'Writable input directory/manifest');
  const bytes = await boundedRead(`${INPUT}/inputs.json`, 200_000);
  const inputs = parseInputs(JSON.parse(bytes.toString()));
  for (const [file, digest] of Object.entries(inputs.files)) {
    const full = `${INPUT}/${file}`;
    let directory = path.dirname(full);
    while (directory !== INPUT) {
      const s = await lstat(directory); check(s.uid !== 10001 && (s.mode & 0o022) === 0, 'Writable dependency directory');
      directory = path.dirname(directory);
    }
    const metadata = await lstat(full);
    check(metadata.uid !== 10001 && (metadata.mode & 0o022) === 0, 'Writable runtime input');
    check(sha256(await boundedRead(full, 30_000_000)) === digest, `Input hash mismatch: ${file}`);
  }
  return { inputs, inputHash: sha256(bytes) };
}
export async function absent(file: string): Promise<boolean> {
  try { await lstat(file); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; throw e; }
}
export async function filesIn(file: string): Promise<string[]> { await assertNoSymlinks(file); return (await readdir(file)).sort(); }
export async function loadSigner(role: Role, prepared: Prepared) {
  const file = keyPath(role); const stat = await lstat(file);
  check(stat.isFile() && stat.uid === 10001 && (stat.mode & 0o077) === 0, 'Test signer is not private');
  const parsed: unknown = JSON.parse((await boundedRead(file, 1024)).toString());
  check(Array.isArray(parsed) && parsed.length === 64 && parsed.every(v => Number.isInteger(v) && v >= 0 && v <= 255), 'Invalid local signer');
  const bytes = new Uint8Array(parsed);
  try { const signer = await createKeyPairSignerFromBytes(bytes); check(signer.address === prepared.signers[role], 'Signer/public-manifest mismatch'); return signer; }
  finally { bytes.fill(0); parsed.fill(0); }
}
