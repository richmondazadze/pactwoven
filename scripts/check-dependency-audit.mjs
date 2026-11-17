import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isAlias, parseDocument, visit } from 'yaml';

// This exception is deliberately specific to one reviewed patch and dependency cohort.
const ADVISORY = 'GHSA-fc5q-39xc-vjpf';
const PATCH = 'packages/security-patches/picomatch-4.0.7.patch';
const PATCH_SHA = '400de089d687dea29c8550bd1517fa0bdfdcd0b7c32e61391577f1c46351c7a5';
const REF = `4.0.7(patch_hash=${PATCH_SHA})`;
const PACKAGE_KEY = `picomatch@${REF}`;
const STORE_ENTRY = `picomatch@4.0.7_patch_hash=${PATCH_SHA}`;
const INTEGRITY = 'sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==';
const TARBALL = 'https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz';
const NEXT_CONFIG = 'apps/web/next.config.ts';
const NEXT_CONFIG_SHA = '2e8c3adab3ce7ed7a5a686a2209ff64d548590d0f31a85b7aa3ca5a7afdb475c';
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const MAX_BYTES = 16 * 1024 * 1024;
const PARENTS = ['fdir@6.5.0', 'micromatch@4.0.8', 'tinyglobby@0.2.17', 'vite@8.3.8', 'vitest@5.1.0'];
const PATHS = [
  '.>vitest>@vitest/mocker>vite>picomatch',
  '.>vitest>@vitest/mocker>vite>tinyglobby>fdir>picomatch',
  '.>vitest>@vitest/mocker>vite>tinyglobby>picomatch',
  '.>vitest>picomatch',
  '.>vitest>tinyglobby>fdir>picomatch',
  '.>vitest>tinyglobby>picomatch',
  '.>vitest>vite>picomatch',
  '.>vitest>vite>tinyglobby>fdir>picomatch',
  '.>vitest>vite>tinyglobby>picomatch',
  'apps__web>@opennextjs/cloudflare>@opennextjs/aws>@node-minify/core>@node-minify/utils>fast-glob>micromatch>picomatch',
  'apps__web>@opennextjs/cloudflare>@opennextjs/aws>@node-minify/terser>@node-minify/utils>fast-glob>micromatch>picomatch',
];
const FILE_HASHES = Object.freeze({
  'package.json': '479b70b87aa7b44344d62c8a459ae7e53dd2bca6c61f1396bd55e63e9de73fc6',
  'index.js': '02ae26406508e28f9ba0865be16cf77f0b33de6c4d4d49c212c4176df1d5625a',
  'posix.js': '5695ff5dfcd5a338a40630bd506056f2950bcb08fe1cc068519cbbfe60add480',
  'lib/constants.js': 'c28f952d2758261fe5428a121add485cc25b03e0193633f649de903dc0e5e222',
  'lib/parse.js': 'd3a582dc9617447d9e5b67f7dfd4644a2661052b170c898b0586384113d01e07',
  'lib/picomatch.js': 'fdd249d7ffff853f3bb1c77eafc8baa1a437bea85a94c35877b83c6a40d9ca94',
  'lib/scan.js': '6457a1764e5c2e543cc3a0c00ce12ebb3764097628868198370b64d4e642aaae',
  'lib/utils.js': 'f04604f70cd1a3f6ace80b84766468674ff38b4bb83818d2ef1d81fc6355f935',
});
const RESIDUAL = 'Only the resolved external Picomatch graph is patched. Next 16.4.6 still vendors an unpatched matcher. The reviewed configuration disables the Next image optimizer; OpenNext still retains a /_next/image fallback with a fixed ordinary ** local pattern and empty remote patterns. Remaining build/configuration patterns must be trusted and re-reviewed on change. The release target is Vercel only. Raw regex support remains; this is not general ReDoS protection or an all-deployed-matchers claim.';

class GateError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}
function need(condition, message, exitCode = 1) { if (!condition) throw new GateError(message, exitCode); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sameSet(a, b) { return a.length === b.length && new Set(a).size === a.length && [...a].sort().every((v, i) => v === [...b].sort()[i]); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function regularFile(file, limit = MAX_BYTES) {
  const stat = fs.lstatSync(file);
  need(stat.isFile() && stat.size <= limit, 'Evidence must be a bounded ordinary file.');
  return fs.readFileSync(file);
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function canonicalImporter(value) {
  return value === '.' || /^(?:apps|services|packages|programs)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value);
}

export function parseStrictYaml(text) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= MAX_BYTES, 'Missing or oversized YAML evidence.', 2);
  const doc = parseDocument(text, { uniqueKeys: true, strict: true, schema: 'core', merge: false });
  need(doc.errors.length === 0 && doc.warnings.length === 0, 'Invalid or ambiguous YAML evidence.', 2);
  visit(doc, (_key, node) => {
    need(!isAlias(node) && !node?.tag && node?.key?.value !== '<<', 'Aliases, merge keys and explicit tags are not accepted.', 2);
  });
  const result = doc.toJS({ maxAliasCount: 0 });
  need(object(result), 'YAML evidence must contain one object.', 2);
  return result;
}
function strictJson(text) {
  need(typeof text === 'string' && text.length > 0 && Buffer.byteLength(text) <= MAX_BYTES, 'Missing or oversized JSON evidence.', 2);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new GateError('Malformed JSON evidence.', 2); }
  // JSON.parse alone silently accepts duplicate object keys.
  const doc = parseDocument(text, { uniqueKeys: true, strict: true, schema: 'json' });
  need(doc.errors.length === 0 && doc.warnings.length === 0, 'Duplicate or ambiguous JSON keys.', 2);
  return parsed;
}
export function validateProcessResult(result, expectedStatus = 0) {
  need(object(result) && !result.error && result.signal == null && result.status === expectedStatus,
    'Required subprocess failed, timed out, or returned an inconsistent status.', 2);
  need(typeof result.stdout === 'string' && Buffer.byteLength(result.stdout) <= MAX_BYTES,
    'Required subprocess output is missing or oversized.', 2);
  need(typeof result.stderr === 'string' && result.stderr.trim() === '', 'Required subprocess reported an error or warning.', 2);
  return result.stdout;
}
function run(command, args, cwd, timeout = 30_000, maxBuffer = MAX_BYTES) {
  return spawnSync(command, args, { cwd, shell: false, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer });
}

export function parseAuditResult(result) {
  // This temporary gate requires the known high advisory to remain visibly reported.
  const audit = strictJson(validateProcessResult(result, 1));
  need(object(audit) && sameSet(Object.keys(audit), ['advisories', 'metadata']) && object(audit.advisories) && object(audit.metadata), 'Unknown audit document shape.', 2);
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
  const ids = new Set(), ghsas = new Set();
  for (const [key, advisory] of Object.entries(audit.advisories)) {
    need(object(advisory) && Number.isSafeInteger(advisory.id) && advisory.id > 0 && String(advisory.id) === key && !ids.has(advisory.id), 'Inconsistent advisory identity.', 2);
    need(SEVERITIES.includes(advisory.severity), 'Unknown advisory severity.', 2);
    for (const field of ['title', 'module_name', 'vulnerable_versions', 'github_advisory_id', 'url']) need(typeof advisory[field] === 'string' && advisory[field].length > 0, 'Incomplete advisory record.', 2);
    need(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(advisory.github_advisory_id) && !ghsas.has(advisory.github_advisory_id), 'Duplicate or malformed GHSA identity.', 2);
    need(advisory.patched_versions === null || typeof advisory.patched_versions === 'string', 'Invalid upstream patch metadata.', 2);
    need(typeof advisory.patched_versions_unpublished === 'boolean' && Array.isArray(advisory.findings) && advisory.findings.length > 0, 'Missing advisory findings.', 2);
    const paths = new Set();
    for (const finding of advisory.findings) {
      need(object(finding) && typeof finding.version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(finding.version), 'Invalid finding version.', 2);
      need(['dev', 'optional', 'bundled'].every(flag => typeof finding[flag] === 'boolean') && Array.isArray(finding.paths) && finding.paths.length > 0, 'Incomplete finding metadata.', 2);
      for (const p of finding.paths) {
        need(typeof p === 'string' && p.length > 0 && p.length <= 4096 && !/[\x00-\x20\x7f]/.test(p) && !paths.has(p), 'Duplicate or invalid advisory path.', 2);
        paths.add(p);
      }
    }
    counts[advisory.severity]++; ids.add(advisory.id); ghsas.add(advisory.github_advisory_id);
  }
  need(object(audit.metadata.vulnerabilities) && sameSet(Object.keys(audit.metadata.vulnerabilities), SEVERITIES), 'Missing severity totals.', 2);
  for (const s of SEVERITIES) need(Number.isSafeInteger(audit.metadata.vulnerabilities[s]) && audit.metadata.vulnerabilities[s] === counts[s], 'Advisory and severity totals disagree.', 2);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'totalDependencies']) need(Number.isSafeInteger(audit.metadata[field]) && audit.metadata[field] >= 0, 'Invalid dependency totals.', 2);
  need(audit.metadata.totalDependencies > 0 && ['dependencies', 'devDependencies', 'optionalDependencies'].every(k => audit.metadata[k] <= audit.metadata.totalDependencies), 'Inconsistent dependency totals.', 2);
  return audit;
}

export function validateMitigationScope(audit) {
  const target = audit.advisories['1247710'];
  const expected = {
    id: 1247710, title: 'picomatch vulnerable to ReDoS through single-branch repeated extglobs',
    module_name: 'picomatch', vulnerable_versions: '<=4.0.7', patched_versions: null,
    severity: 'high', cwe: 'CWE-1333', github_advisory_id: ADVISORY,
    url: `https://github.com/advisories/${ADVISORY}`, patched_versions_unpublished: true,
  };
  need(object(target) && Object.entries(expected).every(([k, v]) => target[k] === v), 'Reviewed advisory scope changed or disappeared; review is required.');
  need(sameSet(Object.keys(target), [...Object.keys(expected), 'findings']), 'Reviewed advisory fields changed; review is required.');
  need(target.findings.length === 1, 'Reviewed finding grouping changed.');
  const finding = target.findings[0];
  need(sameSet(Object.keys(finding), ['version', 'paths', 'dev', 'optional', 'bundled']) && finding.version === '4.0.7' && finding.dev === false && finding.optional === false && finding.bundled === false && sameSet(finding.paths, PATHS), 'Reviewed dependency path/version scope changed.');
  need(Object.values(audit.advisories).every(a => a.github_advisory_id === ADVISORY || !['high', 'critical'].includes(a.severity)), 'Another high or critical advisory blocks release.');
  return { advisory: ADVISORY, version: '4.0.7', paths: [...PATHS] };
}

export function validateLockEvidence({ workspaceText, lockText, installedLockText, patchBytes, nextConfigBytes, manifestText }) {
  need(sha(patchBytes) === PATCH_SHA, 'Patch bytes differ from the reviewed mitigation.');
  need(sha(nextConfigBytes) === NEXT_CONFIG_SHA, 'Next configuration differs from the reviewed image-optimizer restriction.');
  const manifest = strictJson(manifestText);
  need(manifest.packageManager === 'pnpm@11.25.0' && manifest.devDependencies?.yaml === '2.9.1', 'Reviewed package-manager/parser pin is missing.');
  const workspace = parseStrictYaml(workspaceText), lock = parseStrictYaml(lockText);
  need(lockText === installedLockText, 'Installed and canonical pnpm lockfiles differ.');
  need(workspace.overrides?.picomatch === '4.0.7' && workspace.patchedDependencies?.['picomatch@4.0.7'] === PATCH && sameSet(Object.keys(workspace.patchedDependencies), ['picomatch@4.0.7']) && workspace.allowNonAppliedPatches !== true, 'Reviewed workspace override/patch configuration is missing.');
  need(Object.entries(workspace.overrides).every(([k, v]) => k === 'picomatch' || (!k.includes('picomatch') && !String(v).includes('picomatch'))), 'Unexpected Picomatch override or alias.');
  need(lock.lockfileVersion === '9.0' && lock.overrides?.picomatch === '4.0.7' && lock.patchedDependencies?.['picomatch@4.0.7'] === PATCH_SHA && sameSet(Object.keys(lock.patchedDependencies), ['picomatch@4.0.7']), 'Reviewed lock patch metadata is missing.');
  need(JSON.stringify(lock.overrides) === JSON.stringify(workspace.overrides), 'Workspace and lock overrides disagree.');
  need(object(lock.importers) && object(lock.packages) && object(lock.snapshots) && Object.keys(lock.importers).every(canonicalImporter), 'Invalid lock graph.', 2);
  need(sameSet(Object.keys(lock.packages).filter(k => k.startsWith('picomatch@')), ['picomatch@4.0.7']), 'Unreviewed Picomatch package version remains in lockfile.');
  need(sameSet(Object.keys(lock.snapshots).filter(k => k.startsWith('picomatch@')), [PACKAGE_KEY]) && Object.keys(lock.snapshots[PACKAGE_KEY]).length === 0, 'Unpatched or changed Picomatch snapshot remains.');
  const resolution = lock.packages['picomatch@4.0.7'].resolution;
  need(object(resolution) && sameSet(Object.keys(resolution), ['integrity']) && resolution.integrity === INTEGRITY, 'Upstream package integrity/source changed.');
  need(lock.importers['apps/web']?.dependencies?.next?.specifier === '16.4.6' && lock.importers['apps/web'].dependencies.next.version.startsWith('16.4.6('), 'Reviewed Next version changed.');
  const parents = [];
  for (const [parent, node] of [...Object.entries(lock.importers), ...Object.entries(lock.snapshots)]) {
    need(object(node), 'Malformed lock graph node.', 2);
    need(!parent.replaceAll(PACKAGE_KEY, '').includes('picomatch@'), 'Unpatched Picomatch peer context remains.');
    for (const section of SECTIONS) for (const [name, entry] of Object.entries(node[section] ?? {})) {
      const reference = object(entry) ? entry.version : entry;
      need(typeof reference === 'string', 'Malformed dependency reference.', 2);
      if (name === 'picomatch') {
        need(reference === REF && section === (parent.startsWith('fdir@') ? 'optionalDependencies' : 'dependencies'), 'Unpatched or changed Picomatch dependency edge.');
        parents.push(parent.split('(')[0]);
      } else need(!/^(?:npm:)?picomatch@/.test(reference), 'Aliased Picomatch dependency is not reviewed.');
    }
  }
  need(sameSet(parents, PARENTS), 'Picomatch parent dependency cohort changed.');
  return lock;
}

export function verifyRuntimePackage(directory) {
  const actual = new Set();
  const walk = (relative = '') => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      need(!entry.isSymbolicLink(), 'Picomatch package contains a symlink.');
      if (entry.isDirectory()) { need(file === 'lib', 'Unexpected directory in Picomatch package.'); walk(file); }
      else {
        need(entry.isFile(), 'Unexpected file type in Picomatch package.');
        if (file === 'LICENSE' || file === 'README.md') continue;
        need(Object.hasOwn(FILE_HASHES, file), 'Unexpected executable or entry file in Picomatch package.');
        actual.add(file);
        need(sha(regularFile(path.join(directory, file), 1024 * 1024)) === FILE_HASHES[file], `Reviewed Picomatch file fingerprint differs: ${file}.`);
      }
    }
  };
  walk();
  need(sameSet([...actual], Object.keys(FILE_HASHES)), 'Reviewed Picomatch runtime file is missing.');
  return { version: '4.0.7', files: actual.size };
}

export function collectListedGraph(text, root, importers) {
  const list = strictJson(text);
  need(Array.isArray(list) && list.length > 0, 'Missing dependency listing.', 2);
  const roots = new Map(), nodes = new Map(), targetParents = new Set();
  const workspaceVersions = new Map(list.map(item => [item.path, item.version]));
  let seen = 0;
  function walk(node, parent, name, depth) {
    need(++seen <= 100_000 && depth <= 100 && object(node) && typeof node.path === 'string' && path.isAbsolute(node.path) && inside(root, node.path) && typeof node.version === 'string', 'Malformed, escaping or excessive dependency listing.', 2);
    need(!node.missing && !node.invalid && !node.circular, 'Incomplete dependency listing.', 2);
    let version = node.version;
    if (version.startsWith('link:')) {
      need(parent && workspaceVersions.has(node.path) && path.resolve(parent.path, version.slice(5)) === node.path && importers.includes(path.relative(root, node.path) || '.'), 'Invalid workspace link in dependency listing.', 2);
      version = workspaceVersions.get(node.path);
      need(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), 'Missing workspace importer version.', 2);
    }
    const edges = new Map();
    for (const section of SECTIONS) {
      need(node[section] === undefined || object(node[section]), 'Malformed dependency section.', 2);
      for (const [key, child] of Object.entries(node[section] ?? {})) {
        need(!edges.has(key) || edges.get(key) === child.path, 'Conflicting dependency edges.', 2);
        edges.set(key, child.path); walk(child, node, key, depth + 1);
      }
    }
    const prior = nodes.get(node.path);
    need(!prior || prior.version === version, 'Conflicting dependency listing versions.', 2);
    if (prior && edges.size && prior.edges.size) need(sameSet([...edges].map(JSON.stringify), [...prior.edges].map(JSON.stringify)), 'Conflicting dependency subgraphs.', 2);
    if (!prior || edges.size > prior.edges.size) nodes.set(node.path, { ...node, version, edges });
    if (name === 'picomatch' || node.from === 'picomatch') {
      need(parent && name === 'picomatch' && node.from === 'picomatch' && node.version === '4.0.7' && node.resolved === TARBALL, 'Unreviewed or aliased listed Picomatch package.');
      targetParents.add(`${parent.from ?? parent.name}@${parent.version}`);
      need(node.path === path.join(root, 'node_modules/.pnpm', STORE_ENTRY, 'node_modules/picomatch'), 'Unexpected installed Picomatch copy/path.');
    }
  }
  for (const item of list) {
    const importer = path.relative(root, item.path) || '.';
    need(canonicalImporter(importer) && !roots.has(importer), 'Unexpected or duplicated listed importer.', 2);
    roots.set(importer, item.path); walk(item, null, null, 0);
  }
  need(sameSet([...roots.keys()], importers) && sameSet([...targetParents], PARENTS), 'Installed importer or Picomatch parent coverage changed.');
  for (const node of nodes.values()) if (node.dedupedDependenciesCount > 0) need(node.edges.size > 0, 'Deduplicated graph target was not expanded.', 2);
  return { roots, nodes };
}

function lookupPackage(parent, name, root) {
  need(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name), 'Invalid dependency name.', 2);
  const search = createRequire(path.join(parent, 'package.json')).resolve.paths(name);
  for (const base of search ?? []) {
    const candidate = path.join(base, name);
    if (!fs.existsSync(path.join(candidate, 'package.json'))) continue;
    const real = fs.realpathSync(candidate);
    need(inside(root, real), 'Dependency resolution escapes the installation.');
    return real;
  }
  throw new GateError('Required dependency cannot be resolved.');
}

export function verifyInstalledGraph(root, lock, installedText, lockOnlyText) {
  const importers = Object.keys(lock.importers);
  const installed = collectListedGraph(installedText, root, importers);
  const canonical = collectListedGraph(lockOnlyText, root, importers);
  const expected = path.join(root, 'node_modules/.pnpm', STORE_ENTRY, 'node_modules/picomatch');
  for (const graph of [installed, canonical]) for (const auditPath of PATHS) {
    const [first, ...names] = auditPath.split('>');
    let parent = graph.roots.get(first.replaceAll('__', '/'));
    for (const name of names) {
      const child = graph.nodes.get(parent)?.edges.get(name);
      need(typeof child === 'string', 'Reviewed dependency path is missing from the listing.');
      const real = lookupPackage(parent, name, root);
      need(real === fs.realpathSync(child), 'Actual Node resolution differs from the listed dependency path.');
      const pkg = strictJson(regularFile(path.join(real, 'package.json'), 1024 * 1024).toString('utf8'));
      need(pkg.name === name && pkg.version === graph.nodes.get(child)?.version, 'Installed package identity/version disagrees with listing.');
      if (name === 'picomatch') need(real === expected && fs.realpathSync(createRequire(path.join(parent, 'package.json')).resolve('picomatch')) === path.join(expected, 'index.js'), 'Actual Picomatch entrypoint differs from the reviewed copy.');
      parent = child;
    }
  }
  // Inspect package entries, not entire source/build trees. This also catches stale
  // virtual-store copies, aliases, nested node_modules and direct shadow packages.
  const queue = importers.map(p => path.join(root, p, 'node_modules'));
  const virtualStore = path.join(root, 'node_modules/.pnpm');
  for (const entry of fs.readdirSync(virtualStore, { withFileTypes: true })) {
    if (entry.name.startsWith('picomatch@')) need(entry.name === STORE_ENTRY && entry.isDirectory(), 'Extra, stale or incomplete Picomatch store entry found.');
    if (entry.isDirectory()) queue.push(entry.name === 'node_modules' ? path.join(virtualStore, entry.name) : path.join(virtualStore, entry.name, 'node_modules'));
    else need(!entry.isSymbolicLink(), 'Unexpected symlink in the pnpm virtual store.');
  }
  const visited = new Set(), packages = new Set(), copies = new Set();
  while (queue.length) {
    const directory = queue.pop();
    if (!fs.existsSync(directory)) continue;
    const real = fs.realpathSync(directory);
    need(inside(root, real) && visited.size < 10_000, 'Module inventory escaped or exceeded its bound.');
    if (visited.has(real)) continue;
    visited.add(real);
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const base = path.join(real, entry.name);
      const candidates = entry.name.startsWith('@') ? fs.readdirSync(base).map(n => [`${entry.name}/${n}`, path.join(base, n)]) : [[entry.name, base]];
      for (const [name, candidate] of candidates) {
        if (!fs.existsSync(path.join(candidate, 'package.json'))) continue;
        const location = fs.realpathSync(candidate);
        need(inside(root, location), 'Installed module points outside the installation.');
        const pkg = strictJson(regularFile(path.join(location, 'package.json'), 1024 * 1024).toString('utf8'));
        if (name === 'picomatch' || pkg.name === 'picomatch') {
          need(name === 'picomatch' && pkg.name === 'picomatch' && pkg.version === '4.0.7' && location === expected, 'Extra, stale, aliased or unpatched Picomatch copy found.');
          copies.add(location);
        }
        if (!packages.has(location)) { packages.add(location); queue.push(path.join(location, 'node_modules')); }
      }
    }
  }
  need(copies.size === 1 && copies.has(expected), 'Installed Picomatch inventory is incomplete.');
  verifyRuntimePackage(expected);
  return { directory: expected, copies: copies.size, paths: PATHS.length };
}

// This code is executed in a killed-on-timeout child, never in the gate process.
const PROBE_SOURCE = String.raw`
const assert = require('node:assert/strict');
const path = require('node:path');
const pm = require(process.argv[1]);
const repeats = ['+(*)', '+(*a)', '*(*a)', '+(a+)', '+(*a|b)', '*(*a|b)', '+(ab|abab)', '*(ab|abab)', '+(abc)', '*(abc)', '+(*(*a))', '*(+(*a))'];
const options = [{}, {fastpaths:false}, {capture:true}, {contains:true}, {windows:true}, {bash:true}, {maxExtglobRecursion:false}];
let checks = 0;
for (const opts of options) for (const pattern of repeats) {
  const matcher = pm(pattern, opts);
  assert.equal(matcher(pattern), true);
  assert.equal(matcher('a'.repeat(30) + '/!'), false);
  assert.equal(matcher('ab'.repeat(30) + '!'), false);
  checks += 3;
}
for (const opts of options) {
  for (const [pattern, literal] of [['x+(*a)y','x+(*a)y'], ['@(+(*a)|z)','+(*a)']]) {
    const matcher = pm(pattern, opts);
    assert.equal(matcher(literal), true);
    assert.equal(matcher('x' + 'a'.repeat(30) + '!y'), false);
    checks += 2;
  }
  // capture:true negate behavior is false in pristine 4.0.7 as well.
  assert.equal(pm('!(+(*a))', opts)('a'.repeat(30) + '!'), opts.capture !== true); checks++;
}
for (const [pattern, yes, no] of [
  ['**/*.ts','src/a.ts','src/a.js'], ['**/*.{ts,tsx}','src/a.tsx','src/a.js'],
  ['[ab]*.ts','abc.ts','xyz.ts'], ['a?c','abc','abbc'], ['foo/**','foo/a/b','other/a'],
  ['file.@(js|ts)','file.js','file.css'], ['file.?(js).ts','file.js.ts','file.css.ts'],
  ['apps/**/!(*.test).ts','apps/a.ts','apps/a.test.ts'],
]) { assert.equal(pm(pattern)(yes), true); assert.equal(pm(pattern)(no), false); checks += 2; }
const posix = require(path.join(path.dirname(process.argv[1]), 'posix.js'));
assert.equal(posix('+(*a)')('+(*a)'), true);
assert.equal(posix('+(*a)')('a'.repeat(30) + '!'), false); checks += 2;
process.stdout.write(JSON.stringify({checks}));
`;
const PROBE_CHECKS = 305;
export function runMitigationProbes(directory) {
  const result = run(process.execPath, ['--input-type=commonjs', '-e', PROBE_SOURCE, path.join(directory, 'index.js')], directory, 2000, 64 * 1024);
  const report = strictJson(validateProcessResult(result));
  need(object(report) && sameSet(Object.keys(report), ['checks']) && report.checks === PROBE_CHECKS, 'Mitigation probe output is incomplete or incorrect.');
  return report;
}

export function verifyCommittedFiles(root, files) {
  const git = args => validateProcessResult(run('git', args, root));
  need(path.resolve(git(['rev-parse', '--show-toplevel']).trim()) === root, 'Gate must run from its own Git checkout.');
  const head = git(['rev-parse', '--verify', 'HEAD']).trim();
  need(/^[a-f0-9]{40,64}$/.test(head), 'Missing committed dependency evidence.', 2);
  const hashes = {};
  for (const file of files) {
    need(!path.isAbsolute(file) && !file.split('/').some(p => p === '..' || p === ''), 'Invalid committed evidence path.', 2);
    const record = git(['ls-tree', '-z', head, '--', file]);
    const treeEntry = /^(100644|100755) blob ([a-f0-9]{40,64})\t[^\0]+\0$/.exec(record);
    need(treeEntry, 'Required evidence is not a committed ordinary file.');
    const index = git(['ls-files', '--stage', '-z', '--', file]);
    const indexEntry = /^(100644|100755) ([a-f0-9]{40,64}) 0\t[^\0]+\0$/.exec(index);
    need(indexEntry && indexEntry[1] === treeEntry[1] && indexEntry[2] === treeEntry[2], 'Required evidence has a changed or ambiguous Git index.');
    const committed = git(['show', `${head}:${file}`]);
    need(fs.realpathSync(path.join(root, file)) === path.join(root, file), 'Committed evidence must not traverse symlinks.');
    const actual = regularFile(path.join(root, file));
    need(actual.equals(Buffer.from(committed)), 'Dependency evidence differs from committed HEAD.');
    hashes[file] = sha(actual);
  }
  return { head, hashes };
}

export function inspectLocalMitigation(root) {
  const read = file => regularFile(path.join(root, file)).toString('utf8');
  const lock = validateLockEvidence({
    workspaceText: read('pnpm-workspace.yaml'), lockText: read('pnpm-lock.yaml'), installedLockText: read('node_modules/.pnpm/lock.yaml'),
    patchBytes: regularFile(path.join(root, PATCH)), nextConfigBytes: regularFile(path.join(root, NEXT_CONFIG)), manifestText: read('package.json'),
  });
  const listed = validateProcessResult(run('pnpm', ['list', '-r', '--depth', 'Infinity', '--json'], root));
  const listedLock = validateProcessResult(run('pnpm', ['list', '-r', '--depth', 'Infinity', '--json', '--lockfile-only'], root));
  const installed = verifyInstalledGraph(root, lock, listed, listedLock);
  const probes = runMitigationProbes(installed.directory);
  verifyRuntimePackage(installed.directory);
  return { lock, installed, probes, listed, listedLock };
}

export function checkDependencyAudit() {
  need(arguments.length === 0, 'This gate accepts no injected evidence or bypass options.', 2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  need(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'Node loader/resolution overrides require review.');
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  need((major === 24 && (minor > 22 || minor === 22 && patch >= 1)) || (major === 26 && minor >= 4), 'Unreviewed Node runtime.');
  need(validateProcessResult(run('pnpm', ['--version'], root)).trim() === '11.25.0', 'Unreviewed pnpm version.');
  const initialLock = parseStrictYaml(regularFile(path.join(root, 'pnpm-lock.yaml')).toString('utf8'));
  need(object(initialLock.importers) && Object.keys(initialLock.importers).every(canonicalImporter), 'Invalid importer scope.', 2);
  const bound = [PATCH, 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', NEXT_CONFIG, 'scripts/check-dependency-audit.mjs', ...Object.keys(initialLock.importers).filter(p => p !== '.').map(p => `${p}/package.json`)];
  if (fs.existsSync(path.join(root, '.npmrc'))) bound.push('.npmrc');
  const before = verifyCommittedFiles(root, bound);
  const local = inspectLocalMitigation(root);
  const audit = parseAuditResult(run('pnpm', ['audit', '--json', '--audit-level', 'high'], root, 60_000));
  const scope = validateMitigationScope(audit);
  const after = verifyCommittedFiles(root, bound);
  need(JSON.stringify(before) === JSON.stringify(after), 'Committed evidence changed during the gate.');
  // Re-resolve links and inventory after the network call, not only the original
  // package bytes: a new shadow/stale copy must also invalidate this run.
  verifyInstalledGraph(root, local.lock, local.listed, local.listedLock);
  need(regularFile(path.join(root, 'pnpm-lock.yaml')).equals(regularFile(path.join(root, 'node_modules/.pnpm/lock.yaml'))), 'Installed lock changed during the gate.');
  return {
    status: 'reported-mitigated', message: '1 high advisory remains reported by pnpm; the exact verified local Picomatch patch mitigates the reviewed external dependency scope. Repeated plus/star extglobs are treated literally.',
    ...scope, patchSha256: PATCH_SHA, commit: after.head,
    installedCopies: local.installed.copies, boundedProbeChecks: local.probes.checks,
    residual: RESIDUAL, rawAudit: audit,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    need(process.argv.length === 2, 'Usage: node scripts/check-dependency-audit.mjs (no flags or overrides)', 2);
    process.stdout.write(`${JSON.stringify(checkDependencyAudit(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Dependency audit blocked: ${error instanceof GateError ? error.message : 'Required evidence could not be inspected.'}\n`);
    process.exitCode = error instanceof GateError ? error.exitCode : 2;
  }
}
