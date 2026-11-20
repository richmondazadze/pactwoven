import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse, stringify } from 'yaml';

const { subprocess } = vi.hoisted(() => ({ subprocess: vi.fn() }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: unknown[]) => subprocess(...args) };
});
import {
  checkDependencyAudit, collectListedGraph, inspectLocalMitigation, parseAuditResult,
  parseStrictYaml, runMitigationProbes, validateLockEvidence, validateMitigationScope,
  validateProcessResult, verifyCommittedFiles, verifyInstalledGraph, verifyRuntimePackage,
} from './check-dependency-audit.mjs';

const actualProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const req = createRequire(import.meta.url);
const installed = path.dirname(createRequire(req.resolve('vitest/package.json')).resolve('picomatch/package.json'));
const PATCH_SHA = '400de089d687dea29c8550bd1517fa0bdfdcd0b7c32e61391577f1c46351c7a5';
const targetSlot = `picomatch@4.0.7_patch_hash=${PATCH_SHA}`;
const runtimeFiles = ['package.json', 'index.js', 'posix.js', 'lib/constants.js', 'lib/parse.js', 'lib/picomatch.js', 'lib/scan.js', 'lib/utils.js'];
const paths = [
  '.>vitest>@vitest/mocker>vite>picomatch',
  '.>vitest>@vitest/mocker>vite>tinyglobby>fdir>picomatch',
  '.>vitest>@vitest/mocker>vite>tinyglobby>picomatch', '.>vitest>picomatch',
  '.>vitest>tinyglobby>fdir>picomatch', '.>vitest>tinyglobby>picomatch',
  '.>vitest>vite>picomatch', '.>vitest>vite>tinyglobby>fdir>picomatch', '.>vitest>vite>tinyglobby>picomatch',
  'apps__web>@opennextjs/cloudflare>@opennextjs/aws>@node-minify/core>@node-minify/utils>fast-glob>micromatch>picomatch',
  'apps__web>@opennextjs/cloudflare>@opennextjs/aws>@node-minify/terser>@node-minify/utils>fast-glob>micromatch>picomatch',
];
const temporary: string[] = [];
const result = (stdout: string, status = 0) => ({ stdout, stderr: '', status, signal: null });
function temp() { const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pactwoven-audit-'))); temporary.push(directory); return directory; }
function write(root: string, file: string, text: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
function runtime(root = temp()) {
  for (const file of runtimeFiles) write(root, file, fs.readFileSync(path.join(installed, file)));
  return root;
}
function audit() {
  return {
    advisories: {
      '1247710': {
        id: 1247710, title: 'picomatch vulnerable to ReDoS through single-branch repeated extglobs', module_name: 'picomatch',
        vulnerable_versions: '<=4.0.7', patched_versions: null, severity: 'high', cwe: 'CWE-1333',
        github_advisory_id: 'GHSA-fc5q-39xc-vjpf', url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf', patched_versions_unpublished: true,
        findings: [{ version: '4.0.7', paths: [...paths], dev: false, optional: false, bundled: false }],
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 }, dependencies: 399, devDependencies: 91, optionalDependencies: 147, totalDependencies: 587 },
  };
}
function parseAudit(value = audit()) { return parseAuditResult(result(JSON.stringify(value), 1)); }
function lockInputs() {
  return {
    workspaceText: fs.readFileSync('pnpm-workspace.yaml', 'utf8'), lockText: fs.readFileSync('pnpm-lock.yaml', 'utf8'),
    installedLockText: fs.readFileSync('node_modules/.pnpm/lock.yaml', 'utf8'),
    manifestText: fs.readFileSync('package.json', 'utf8'), patchBytes: fs.readFileSync('packages/security-patches/picomatch-4.0.7.patch'),
    nextConfigBytes: fs.readFileSync('apps/web/next.config.ts'),
  };
}
function mutateLock(change: (lock: any) => void) {
  const input = lockInputs(), lock = parse(input.lockText); change(lock);
  input.lockText = stringify(lock); input.installedLockText = input.lockText; return input;
}

// A miniature pnpm layout contains only the eleven reviewed dependency paths.
// It exercises actual Node lookup/symlinks without modifying installed dependencies.
function graphFixture() {
  const root = temp(), dirs = new Map<string, string>(), edges = new Map<string, Map<string, string>>();
  const versions: Record<string, string> = {
    vitest: '5.1.0', '@vitest/mocker': '5.1.0', vite: '8.3.8', tinyglobby: '0.2.17', fdir: '6.5.0', picomatch: '4.0.7',
    '@opennextjs/cloudflare': '1.20.17', '@opennextjs/aws': '4.1.16', '@node-minify/core': '10.5.0', '@node-minify/terser': '10.5.0',
    '@node-minify/utils': '10.5.0', 'fast-glob': '3.3.3', micromatch: '4.0.8',
  };
  dirs.set('.', root); dirs.set('apps__web', path.join(root, 'apps/web'));
  for (const importer of ['.', 'apps__web']) write(dirs.get(importer)!, 'package.json', JSON.stringify({ name: importer, version: '0.1.0' }));
  for (const [name, version] of Object.entries(versions)) {
    const slot = name === 'picomatch' ? targetSlot : `${name.replaceAll('/', '+')}@${version}`;
    const directory = path.join(root, 'node_modules/.pnpm', slot, 'node_modules', name);
    dirs.set(name, directory);
    if (name === 'picomatch') runtime(directory); else write(directory, 'package.json', JSON.stringify({ name, version }));
  }
  for (const auditPath of paths) {
    const names = auditPath.split('>');
    for (let i = 0; i < names.length - 1; i++) {
      const parent = names[i], child = names[i + 1];
      if (!edges.has(parent)) edges.set(parent, new Map());
      edges.get(parent)!.set(child, dirs.get(child)!);
      const link = path.join(dirs.get(parent)!, 'node_modules', child);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      if (!fs.existsSync(link)) fs.symlinkSync(dirs.get(child)!, link, 'dir');
    }
  }
  const expanded = new Set<string>();
  function node(name: string): any {
    const base: any = { from: name, version: versions[name] ?? '0.1.0', path: dirs.get(name) };
    if (name === 'picomatch') base.resolved = 'https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz';
    if (expanded.has(name)) return { ...base, deduped: true, dedupedDependenciesCount: edges.get(name)?.size ?? 0 };
    expanded.add(name);
    if (edges.get(name)?.size) base.dependencies = Object.fromEntries([...edges.get(name)!.keys()].map(child => [child, node(child)]));
    return base;
  }
  const graph = [node('.'), node('apps__web')], text = JSON.stringify(graph);
  return { root, dirs, graph, text, lock: { importers: { '.': {}, 'apps/web': {} } }, target: dirs.get('picomatch')! };
}

beforeEach(() => { subprocess.mockImplementation(actualProcess.spawnSync); });
afterEach(() => { vi.restoreAllMocks(); for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('live-audit data cannot become a blanket exception', () => {
  it('preserves the sole known high advisory and its non-dev path grouping', () => {
    const parsed = parseAudit();
    expect(validateMitigationScope(parsed).paths).toHaveLength(11);
    expect(parsed.metadata.vulnerabilities.high).toBe(1);
    expect(parsed.advisories['1247710'].findings[0].dev).toBe(false);
  });
  it('accepts overlapping dependency categories instead of adding their totals', () => {
    const value = audit(); value.metadata.devDependencies = 500;
    expect(() => parseAudit(value)).not.toThrow();
  });
  it.each([
    ['signal', { signal: 'SIGKILL' }], ['timeout', { error: { code: 'ETIMEDOUT' } }], ['spawn error', { error: { code: 'ENOENT' } }],
    ['network error', { stderr: 'request failed' }], ['null status', { status: null }], ['wrong status', { status: 2 }], ['false clean', { status: 0 }],
  ])('rejects %s even with a valid advisory payload', (_label, bad) => {
    expect(() => parseAuditResult({ ...result(JSON.stringify(audit()), 1), ...bad })).toThrow();
  });
  it.each(['', '{', 'null', '[]', '{}', '{"advisories":{},"advisories":{},"metadata":{}}'])('rejects malformed or ambiguous JSON: %s', input => {
    expect(() => parseAuditResult(result(input, 1))).toThrow();
  });
  it.each(['id', 'severity', 'findings', 'patched_versions_unpublished', 'module_name'])('rejects incomplete %s', key => {
    const value: any = audit(); delete value.advisories['1247710'][key];
    expect(() => parseAudit(value)).toThrow();
  });
  it.each([
    (v: any) => { v.metadata.vulnerabilities.high = 0; },
    (v: any) => { v.metadata.vulnerabilities.critical = 1; },
    (v: any) => { v.metadata.dependencies = -1; },
    (v: any) => { v.metadata.totalDependencies = 0; },
    (v: any) => { v.advisories['1247710'].findings[0].paths.push(paths[0]); },
    (v: any) => { v.advisories['1247710'].findings[0].optional = 'false'; },
  ])('rejects inconsistent counts and findings %#', mutate => { const value = audit(); mutate(value); expect(() => parseAudit(value)).toThrow(); });
  it.each([
    (v: any) => { v.patched_versions = '>=4.0.8'; v.patched_versions_unpublished = false; },
    (v: any) => { v.vulnerable_versions = '<=5.0.0'; },
    (v: any) => { v.findings[0].version = '2.3.2'; },
    (v: any) => { v.findings[0].paths[0] = '.>new-package>picomatch'; },
    (v: any) => { v.findings[0].paths.pop(); },
    (v: any) => { v.findings[0].dev = true; },
    (v: any) => { v.newScope = true; },
    (v: any) => { v.title = 'changed scope'; },
  ])('requires review for a changed advisory scope %#', mutate => { const value = audit(); mutate(value.advisories['1247710']); expect(() => validateMitigationScope(parseAudit(value))).toThrow(); });
  it('rejects a missing advisory with an inconsistent failing exit status', () => {
    const value: any = audit(); value.advisories = {}; value.metadata.vulnerabilities.high = 0;
    expect(() => validateMitigationScope(parseAudit(value))).toThrow();
  });
  it('accepts a consistent clean report without claiming an upstream fix', () => {
    const value: any = audit(); value.advisories = {}; value.metadata.vulnerabilities.high = 0;
    const parsed = parseAuditResult(result(JSON.stringify(value), 0));
    expect(validateMitigationScope(parsed)).toMatchObject({ advisory: null, version: '4.0.7', reported: false });
    expect(validateMitigationScope(parsed).paths).toHaveLength(11);
  });
  it.each(['high', 'critical'])('rejects another %s advisory', severity => {
    const value: any = audit(); value.advisories['1247711'] = { ...value.advisories['1247710'], id: 1247711, github_advisory_id: 'GHSA-aaaa-bbbb-cccc', severity };
    value.metadata.vulnerabilities[severity]++;
    expect(() => validateMitigationScope(parseAudit(value))).toThrow(/Another high or critical/);
  });
  it('retains a valid lower finding in the returned raw audit', () => {
    const value: any = audit(); value.advisories['1247711'] = { ...value.advisories['1247710'], id: 1247711, github_advisory_id: 'GHSA-aaaa-bbbb-cccc', severity: 'moderate' };
    value.metadata.vulnerabilities.moderate++;
    const parsed = parseAudit(value); validateMitigationScope(parsed);
    expect(parsed.advisories['1247711'].severity).toBe('moderate');
  });
});

describe('exact lock, patch and Next-configuration evidence', () => {
  it('accepts the real frozen installation and reviewed bytes', () => { expect(validateLockEvidence(lockInputs()).lockfileVersion).toBe('9.0'); });
  it.each(['a: 1\na: 2', 'a: &value [1]\nb: *value', 'a: { <<: { b: 1 } }', 'a: !!str x', 'a: !unknown x', '---\na: 1\n---\nb: 2'])('rejects ambiguous YAML %s', text => { expect(() => parseStrictYaml(text)).toThrow(); });
  it.each(['patchBytes', 'nextConfigBytes'])('rejects changed %s', key => { const value: any = lockInputs(); value[key] = Buffer.concat([value[key], Buffer.from('\n')]); expect(() => validateLockEvidence(value)).toThrow(); });
  it('rejects an installed lock that differs even when canonical metadata looks correct', () => { const value = lockInputs(); value.installedLockText += '\n'; expect(() => validateLockEvidence(value)).toThrow(/lockfiles differ/); });
  it.each([
    (l: any) => { l.patchedDependencies['picomatch@4.0.7'] = '0'.repeat(64); },
    (l: any) => { l.packages['picomatch@2.3.2'] = {}; },
    (l: any) => { l.packages['picomatch@4.0.7'].resolution.integrity = 'sha512-other'; },
    (l: any) => { l.snapshots['micromatch@4.0.8'].dependencies.picomatch = '4.0.7'; },
    (l: any) => { l.snapshots['micromatch@4.0.8'].dependencies.hidden = `picomatch@4.0.7(patch_hash=${PATCH_SHA})`; },
    (l: any) => { l.importers['apps/web'].dependencies.next.specifier = '16.4.7'; },
    (l: any) => { l.snapshots['extra@1.0.0'] = { dependencies: { picomatch: `4.0.7(patch_hash=${PATCH_SHA})` } }; },
  ])('rejects unreviewed lock mutation %#', change => { expect(() => validateLockEvidence(mutateLock(change))).toThrow(); });
  it('rejects a removed directly pinned YAML parser', () => { const value = lockInputs(), manifest = JSON.parse(value.manifestText); delete manifest.devDependencies.yaml; value.manifestText = JSON.stringify(manifest); expect(() => validateLockEvidence(value)).toThrow(); });
});

describe('installed code and actual dependency resolution', () => {
  it('verifies every runtime entrypoint/helper, not only parse.js', () => { expect(verifyRuntimePackage(runtime())).toEqual({ version: '4.0.7', files: 8 }); });
  it.each(runtimeFiles)('rejects a changed or missing %s', file => {
    const directory = runtime(); fs.appendFileSync(path.join(directory, file), '\n'); expect(() => verifyRuntimePackage(directory)).toThrow();
    fs.unlinkSync(path.join(directory, file)); expect(() => verifyRuntimePackage(directory)).toThrow();
  });
  it.each(['lib/redirect.js', 'loader.cjs', 'nested/package.json'])('rejects unexpected executable surface %s', file => { const directory = runtime(); write(directory, file, '// unreviewed'); expect(() => verifyRuntimePackage(directory)).toThrow(); });
  it('rejects a symlink even if its bytes match', () => { const directory = runtime(), original = path.join(directory, 'index.js'); fs.renameSync(original, path.join(directory, 'saved.js')); fs.symlinkSync('saved.js', original); expect(() => verifyRuntimePackage(directory)).toThrow(); });
  it('cross-checks real Node resolutions for all eleven paths', () => { const f = graphFixture(); expect(verifyInstalledGraph(f.root, f.lock, f.text, f.text)).toMatchObject({ copies: 1, paths: 11 }); });
  it('rejects a missing importer', () => { const f = graphFixture(); expect(() => collectListedGraph(JSON.stringify(f.graph.slice(0, 1)), f.root, ['.', 'apps/web'])).toThrow(); });
  it('normalizes only workspace links that resolve to an expected importer', () => {
    const f = graphFixture(), graph: any = JSON.parse(f.text), location = path.join(f.root, 'packages/contracts');
    graph.push({ name: '@pactwoven/contracts', version: '0.1.0', path: location });
    graph[0].dependencies['@pactwoven/contracts'] = { from: '@pactwoven/contracts', version: 'link:packages/contracts', path: location };
    expect(() => collectListedGraph(JSON.stringify(graph), f.root, ['.', 'apps/web', 'packages/contracts'])).not.toThrow();
    graph[0].dependencies['@pactwoven/contracts'].version = 'link:other';
    expect(() => collectListedGraph(JSON.stringify(graph), f.root, ['.', 'apps/web', 'packages/contracts'])).toThrow(/Invalid workspace link/);
  });
  it('rejects an unresolved deduplicated target', () => { const f = graphFixture(); const graph: any = JSON.parse(f.text); graph[0].dependencies.vitest = { from: 'vitest', version: '5.1.0', path: f.dirs.get('vitest'), deduped: true, dedupedDependenciesCount: 8 }; expect(() => collectListedGraph(JSON.stringify(graph), f.root, ['.', 'apps/web'])).toThrow(); });
  it('rejects a live path missing from an otherwise unchanged listing', () => { const f = graphFixture(); fs.unlinkSync(path.join(f.dirs.get('micromatch')!, 'node_modules/picomatch')); expect(() => verifyInstalledGraph(f.root, f.lock, f.text, f.text)).toThrow(); });
  it('rejects a direct shadow dependency instead of trusting pnpm JSON', () => {
    const f = graphFixture(), link = path.join(f.dirs.get('micromatch')!, 'node_modules/picomatch'); fs.unlinkSync(link); runtime(link);
    expect(() => verifyInstalledGraph(f.root, f.lock, f.text, f.text)).toThrow(/resolution differs/);
  });
  it.each(['picomatch@2.3.2', 'picomatch@4.0.7'])('rejects stale unreachable copy %s', slot => {
    const f = graphFixture(); write(f.root, `node_modules/.pnpm/${slot}/node_modules/picomatch/package.json`, JSON.stringify({ name: 'picomatch', version: slot.split('@')[1] }));
    expect(() => verifyInstalledGraph(f.root, f.lock, f.text, f.text)).toThrow(/Extra, stale/);
  });
  it('rejects an incomplete stale copy without package metadata', () => { const f = graphFixture(); write(f.root, 'node_modules/.pnpm/picomatch@2.3.2/node_modules/picomatch/index.js', '// incomplete'); expect(() => verifyInstalledGraph(f.root, f.lock, f.text, f.text)).toThrow(/incomplete/); });
  it('detects a shadow copy added after a successful initial inspection', () => {
    const f = graphFixture(); verifyInstalledGraph(f.root, f.lock, f.text, f.text);
    write(f.root, 'node_modules/later-alias/package.json', JSON.stringify({ name: 'picomatch', version: '4.0.7' }));
    expect(() => verifyInstalledGraph(f.root, f.lock, f.text, f.text)).toThrow(/aliased/);
  });
  it('rejects an aliased nested package', () => { const f = graphFixture(); write(f.root, 'node_modules/hidden/package.json', JSON.stringify({ name: 'picomatch', version: '4.0.7' })); expect(() => verifyInstalledGraph(f.root, f.lock, f.text, f.text)).toThrow(/aliased/); });
  it('rejects escaped installed paths', () => { const f = graphFixture(), outside = temp(); write(outside, 'package.json', JSON.stringify({ name: 'picomatch', version: '4.0.7' })); fs.symlinkSync(outside, path.join(f.root, 'node_modules/escaped')); expect(() => verifyInstalledGraph(f.root, f.lock, f.text, f.text)).toThrow(/outside/); });
});

describe('bounded behavior probes and unavailable evidence', () => {
  it('runs all305 real semantic/option checks in a bounded subprocess', () => { expect(runMitigationProbes(runtime())).toEqual({ checks: 305 }); });
  it('fails if a matcher returns false for everything', () => { const directory = temp(); write(directory, 'index.js', 'module.exports = () => () => false;'); expect(() => runMitigationProbes(directory)).toThrow(); });
  it('kills and rejects a hung matcher', () => { const directory = temp(); write(directory, 'index.js', 'while(true) {}'); const start = Date.now(); expect(() => runMitigationProbes(directory)).toThrow(); expect(Date.now() - start).toBeLessThan(5000); });
  it('rejects overflowing subprocess output', () => { const directory = temp(); write(directory, 'index.js', "process.stdout.write('x'.repeat(100000)); module.exports=()=>()=>true;"); expect(() => runMitigationProbes(directory)).toThrow(); });
  it.each(['{}', '{"checks":304}', '{"checks":305,"patched":true}'])('rejects incomplete probe report %s', stdout => { subprocess.mockReturnValue(result(stdout)); expect(() => runMitigationProbes(temp())).toThrow(); });
  it('rejects missing output and stderr warnings', () => { expect(() => validateProcessResult({ status: 0, stdout: undefined, stderr: '' })).toThrow(); expect(() => validateProcessResult({ ...result('{}'), stderr: 'warning' })).toThrow(); });
  it('does not accept caller-supplied audit or patch evidence', () => { expect(() => checkDependencyAudit({ patched: true, audit: audit() })).toThrow(/no injected evidence/); });
  it('requires a committed ordinary file and compares actual bytes', () => {
    const root = temp(), head = 'a'.repeat(40), oid = 'b'.repeat(40); write(root, 'package.json', '{}');
    subprocess.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'rev-parse') return result(args[1] === '--show-toplevel' ? `${root}\n` : `${head}\n`);
      if (args[0] === 'ls-tree') return result(`100644 blob ${oid}\tpackage.json\0`);
      if (args[0] === 'ls-files') return result(`100644 ${oid} 0\tpackage.json\0`);
      return result('{}');
    });
    expect(verifyCommittedFiles(root, ['package.json']).head).toBe(head);
    subprocess.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'rev-parse') return result(args[1] === '--show-toplevel' ? `${root}\n` : `${head}\n`);
      if (args[0] === 'ls-tree') return result(`100644 blob ${oid}\tpackage.json\0`);
      if (args[0] === 'ls-files') return result(`100644 ${'c'.repeat(40)} 0\tpackage.json\0`);
      return result('{}');
    });
    expect(() => verifyCommittedFiles(root, ['package.json'])).toThrow(/changed or ambiguous Git index/);
    subprocess.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'rev-parse') return result(args[1] === '--show-toplevel' ? `${root}\n` : `${head}\n`);
      if (args[0] === 'ls-tree') return result(`100644 blob ${oid}\tpackage.json\0`);
      if (args[0] === 'ls-files') return result(`100644 ${oid} 0\tpackage.json\0`);
      return result('{}');
    });
    fs.appendFileSync(path.join(root, 'package.json'), '\n'); expect(() => verifyCommittedFiles(root, ['package.json'])).toThrow(/committed HEAD/);
  });
  it('rejects fixture/bypass flags before any audit execution', () => {
    const run = actualProcess.spawnSync(process.execPath, ['scripts/check-dependency-audit.mjs', '--audit-json', 'fixture.json'], { encoding: 'utf8', timeout: 5000 });
    expect(run.status).toBe(2); expect(run.stderr).toContain('no flags or overrides');
  });
  it('fails on missing or errored Git evidence', () => { const root = temp(); subprocess.mockReturnValue(result('', 128)); expect(() => verifyCommittedFiles(root, ['package.json'])).toThrow(); });
  it('completes real local lock/list/runtime/probe inspection without a release verdict', () => {
    const local = inspectLocalMitigation(process.cwd()); expect(local.installed.copies).toBe(1); expect(local.probes.checks).toBe(305); expect(local).not.toHaveProperty('status');
  });
});
