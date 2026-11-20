import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// These are reviewed build inputs, not a Rust source/security verdict. Updating
// the cohort or its host-only IDL compatibility features requires review here.
export const reviewedChainBuildInputs = Object.freeze({
  'Cargo.toml': 'e896881cf38ef5061b5072d54eecae7eb6d0c3cf9b3c8bb87f9b6b35de90eeab',
  'Cargo.lock': 'a73e9b6913b31cb22f304d20b0e6bbf7e21dc71b832036b984341c7de2ec777e',
  'rust-toolchain.toml': '97aab3493c1fb14fe9a21c760433577f434714f5725bbb176e67048dde581afe',
  'Anchor.toml': 'ed2232afb5f6c091e6ad62032a76dfa449b69ec4ba0f36351e7f2b0aa631bf3f',
  'programs/pactwoven/Cargo.toml': '32420d7b1bb2e367a93da6c17fac2da292153ede7e88ef97d4544060c19d5f73',
});

const generatedDirectories = new Set(['programs/pactwoven/node_modules', 'programs/pactwoven/target']);
const isBuildOverride = name => ['.cargo', 'build.rs', 'rust-toolchain', 'rust-toolchain.toml', 'cargo.toml', 'cargo.lock', 'anchor.toml'].includes(name.toLowerCase());

export function checkChainBuild({ root = process.cwd() } = {}) {
  const findings = [];
  const add = (file, rule) => findings.push({ file, rule });
  for (const [file, expected] of Object.entries(reviewedChainBuildInputs)) {
    const absolute = path.join(root, file);
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { add(file, 'reviewed build input is missing'); continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) { add(file, 'build input must be an ordinary file'); continue; }
    if (stat.size > 1024 * 1024) { add(file, 'build input exceeds inspection limit'); continue; }
    const actual = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    if (actual !== expected) add(file, 'build input differs from the reviewed cohort');
  }
  // Cargo also discovers configuration in ancestors of the member crate.
  for (const relative of ['', 'programs']) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) continue;
    for (const name of fs.readdirSync(directory)) {
      const file = relative ? `${relative}/${name}` : name;
      if (isBuildOverride(name) && !Object.hasOwn(reviewedChainBuildInputs, file)) add(file, 'unreviewed build override or hook');
    }
  }
  const program = path.join(root, 'programs/pactwoven');
  function visit(directory, relative) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = relative + '/' + entry.name;
      if (entry.isSymbolicLink()) { add(file, 'program build tree must not follow symlinks'); continue; }
      if (entry.isDirectory() && generatedDirectories.has(file)) continue;
      if (isBuildOverride(entry.name) && !Object.hasOwn(reviewedChainBuildInputs, file)) add(file, 'unreviewed build override or hook');
      if (entry.isDirectory()) visit(path.join(directory, entry.name), file);
    }
  }
  if (fs.existsSync(program)) {
    const parents = ['programs', 'programs/pactwoven'];
    if (parents.some(file => fs.lstatSync(path.join(root, file)).isSymbolicLink())) add('programs/pactwoven', 'program build root must not follow symlinks');
    else visit(program, 'programs/pactwoven');
  }
  return { count: Object.keys(reviewedChainBuildInputs).length, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-chain-build.mjs');
    const result = checkChainBuild();
    for (const finding of result.findings) process.stderr.write(`${finding.file}: ${finding.rule}\n`);
    process.stdout.write(`Chain build input check: ${result.count} reviewed inputs; ${result.findings.length} findings.\n`);
    process.exitCode = result.findings.length ? 1 : 0;
  } catch {
    process.stderr.write('Chain build input inspection failed; no build verdict is available.\n');
    process.exitCode = 2;
  }
}
