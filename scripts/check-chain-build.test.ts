import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkChainBuild, reviewedChainBuildInputs } from './check-chain-build.mjs';

const fixtures: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pactwoven-chain-input-'));
  fixtures.push(root);
  for (const file of Object.keys(reviewedChainBuildInputs)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  return root;
}
afterEach(() => { for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('reviewed chain build inputs', () => {
  it('accepts the reviewed cohort with original-token SBF and explicit host IDL compatibility', () => {
    expect(checkChainBuild({ root: fixture() }).findings).toEqual([]);
  });
  it.each(Object.keys(reviewedChainBuildInputs))('rejects a changed or missing %s', file => {
    const root = fixture(), target = path.join(root, file);
    fs.appendFileSync(target, '\n# unreviewed change\n');
    expect(checkChainBuild({ root }).findings).toContainEqual({ file, rule: 'build input differs from the reviewed cohort' });
    fs.unlinkSync(target);
    expect(checkChainBuild({ root }).findings).toContainEqual({ file, rule: 'reviewed build input is missing' });
  });
  it('rejects enabling the host-only token capability in the deployed default features', () => {
    const root = fixture(), file = 'programs/pactwoven/Cargo.toml', target = path.join(root, file);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('default = []', 'default = ["anchor-spl/token_2022"]'));
    expect(checkChainBuild({ root }).findings).toContainEqual({ file, rule: 'build input differs from the reviewed cohort' });
  });
  it.each(['.cargo/config.toml', 'rust-toolchain', 'build.rs', 'programs/.cargo/config.toml', 'programs/Cargo.toml', 'programs/rust-toolchain.toml', 'programs/pactwoven/build.rs', 'programs/pactwoven/.cargo/config.toml', 'programs/pactwoven/client/rust-toolchain.toml', 'programs/pactwoven/helper/Cargo.toml', 'programs/pactwoven/Anchor.toml'])('rejects an extra build hook or override: %s', file => {
    const root = fixture(), target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# synthetic unreviewed build input\n');
    expect(checkChainBuild({ root }).findings.some(finding => finding.rule === 'unreviewed build override or hook')).toBe(true);
  });
  it('rejects symlinked reviewed input and source directories without following them', () => {
    const root = fixture();
    fs.renameSync(path.join(root, 'Cargo.lock'), path.join(root, 'retained-lock'));
    fs.symlinkSync('retained-lock', path.join(root, 'Cargo.lock'));
    fs.symlinkSync(root, path.join(root, 'programs/pactwoven/cycle'));
    const result = checkChainBuild({ root });
    expect(result.findings).toContainEqual({ file: 'Cargo.lock', rule: 'build input must be an ordinary file' });
    expect(result.findings).toContainEqual({ file: 'programs/pactwoven/cycle', rule: 'program build tree must not follow symlinks' });
  });
  it.each(['src/target', 'src/node_modules', 'src/.local', 'src/.git', 'target'])('rejects symlinks even under generated-looking names: %s', name => {
    const root = fixture(), relative = `programs/pactwoven/${name}`, target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(root, target);
    expect(checkChainBuild({ root }).findings).toContainEqual({ file: relative, rule: 'program build tree must not follow symlinks' });
  });
  it.each(['src/target', 'src/node_modules', 'src/.local', 'src/.git'])('inspects unrecognized nested source directories: %s', name => {
    const root = fixture(), file = `programs/pactwoven/${name}/build.rs`, target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// synthetic hook\n');
    expect(checkChainBuild({ root }).findings).toContainEqual({ file, rule: 'unreviewed build override or hook' });
  });
});
