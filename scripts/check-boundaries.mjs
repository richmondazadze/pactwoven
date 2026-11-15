import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { parse, parseExpression } from '@babel/parser';
import { inspectSupplyChain } from './check-publication.mjs';

// Each edge is a reviewed capability. Unknown modules fail closed.
// DB calls deterministic policy inside transactions; domain cannot call DB back.
export const allowedGraph = Object.freeze({
  'apps/web': ['packages/contracts'],
  'services/api': ['packages/contracts', 'packages/domain', 'packages/db', 'packages/observability'],
  'services/coordinator': ['packages/contracts', 'packages/domain', 'packages/adapters'],
  'services/connectors': ['packages/contracts', 'packages/adapters'],
  'services/signer': ['packages/contracts', 'programs/pactwoven'],
  'packages/contracts': [],
  'packages/domain': ['packages/contracts'],
  'packages/db': ['packages/contracts', 'packages/domain'],
  'packages/agents': ['packages/contracts', 'packages/domain', 'packages/adapters', 'packages/observability'],
  'packages/adapters': ['packages/contracts', 'packages/domain'],
  'packages/observability': ['packages/contracts'],
  'packages/testkit': ['packages/contracts', 'packages/domain'],
  'programs/pactwoven': [],
});
const pureModules = new Set(['packages/contracts', 'packages/domain', 'packages/adapters', 'packages/testkit']);
const ignored = new Set(['node_modules', '.next', '.turbo', 'dist', 'build', 'target', 'coverage', '.local', '.wrangler', '.vercel']);
const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const testPattern = /(?:^|\/)(?:__tests__|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const safePureExternals = new Set(['zod']);
// These exact root exports contain deterministic codecs/parsing only. Keep the
// capability local to adapters; full RPC, wallet and signer SDKs stay forbidden.
const adapterCodecVersions = Object.freeze({
  '@solana/codecs-numbers': '8.6.0',
  '@solana/codecs-strings': '8.6.0',
  'jsonc-parser': '3.3.1',
});
const safeTestExternals = new Set(['vitest', 'node:test', 'node:assert', 'node:assert/strict', 'assert', 'assert/strict']);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const privilegedWebExternals = /^(?:pg(?:-native)?|postgres|drizzle-orm|drizzle-kit|@neondatabase\/[^/]+|@prisma\/client|@coinbase\/cdp-sdk|@clerk\/backend|@aws-sdk\/[^/]+|@azure\/[^/]+|stripe|googleapis|openai|@anthropic-ai\/[^/]+|@supabase\/supabase-js)(?:\/|$)/;
const webEffectBuiltins = /^(?:node:)?(?:fs|child_process|worker_threads|net|tls|dns|module)(?:\/|$)/;

const posix = (file) => file.split(path.sep).join('/');
const packageName = (specifier) => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
const contained = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const ownerOf = (root, file) => Object.keys(allowedGraph).find((name) => contained(path.join(root, name), file));

function staticString(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') {
    let result = node.quasis[0].value.cooked;
    for (let i = 0; i < node.expressions.length; i += 1) {
      const part = staticString(node.expressions[i]);
      if (part === null || result === null) return null;
      result += part + node.quasis[i + 1].value.cooked;
    }
    return result;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left), right = staticString(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) return staticString(node.expression);
  return null;
}

function jsonValue(node) {
  if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(node.type)) return node.value;
  if (node.type === 'NullLiteral') return null;
  if (node.type === 'ArrayExpression') return node.elements.map(jsonValue);
  if (node.type === 'ObjectExpression') return Object.fromEntries(node.properties.map((item) => {
    if (item.type !== 'ObjectProperty' || item.computed || item.method) throw new Error('Non-JSON configuration');
    return [item.key.value ?? item.key.name, jsonValue(item.value)];
  }));
  throw new Error('Non-JSON configuration');
}

function readConfig(file, seen = new Set()) {
  if (!fs.existsSync(file)) return { paths: {}, baseUrl: path.dirname(file), imports: {} };
  if (seen.has(file)) throw new Error('Circular tsconfig extends');
  seen.add(file);
  const data = jsonValue(parseExpression(fs.readFileSync(file, 'utf8')));
  let inherited = { paths: {}, baseUrl: path.dirname(file) };
  for (const extension of [].concat(data.extends ?? [])) {
    if (!extension.startsWith('.')) throw new Error('Package tsconfig extends needs explicit boundary resolver review');
    const base = path.resolve(path.dirname(file), extension);
    inherited = { ...inherited, ...readConfig(path.extname(base) ? base : `${base}.json`, new Set(seen)) };
  }
  const options = data.compilerOptions ?? {};
  const baseUrl = options.baseUrl ? path.resolve(path.dirname(file), options.baseUrl) : inherited.baseUrl;
  const mappingBase = options.baseUrl || inherited.explicitBaseUrl ? baseUrl : path.dirname(file);
  const paths = options.paths ? Object.fromEntries(Object.entries(options.paths).map(([alias, targets]) => [alias, targets.map((target) => path.resolve(mappingBase, target))])) : inherited.paths;
  return { baseUrl, explicitBaseUrl: !!options.baseUrl || inherited.explicitBaseUrl, paths };
}

function visit(node, callback, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') callback(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'comments', 'tokens', 'errors'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => visit(child, callback, node));
    else if (value && typeof value === 'object') visit(value, callback, node);
  }
}

function strings(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

function matchingAlias(specifier, mapping) {
  return Object.keys(mapping).sort((a, b) => b.replace('*', '').length - a.replace('*', '').length).find((alias) => {
    if (!alias.includes('*')) return specifier === alias;
    const [prefix, suffix] = alias.split('*');
    return specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length;
  });
}

function expandAlias(specifier, mapping, alias) {
  const [prefix, suffix = ''] = alias.split('*');
  const captured = alias.includes('*') ? specifier.slice(prefix.length, suffix ? -suffix.length : undefined) : '';
  return strings(mapping[alias]).map((target) => target.replace('*', captured));
}

function resolveExisting(candidate) {
  for (const file of [candidate, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'].map((ext) => candidate + ext), ...['index.ts', 'index.tsx', 'index.js'].map((name) => path.join(candidate, name))]) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  if (/\.[cm]?jsx?$/.test(candidate)) {
    const stem = candidate.replace(/\.[cm]?jsx?$/, '');
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (fs.existsSync(stem + ext)) return stem + ext;
  }
  return null;
}

export function checkBoundaries({ root = process.cwd() } = {}) {
  root = fs.realpathSync(root);
  const findings = [], workspaces = new Map(), names = new Map();
  let filesInspected = 0;
  const add = (file, rule, line) => findings.push({ file: posix(path.relative(root, file)), rule, ...(line ? { line } : {}) });
  for (const parent of ['apps', 'services', 'packages', 'programs']) {
    const directory = path.join(root, parent);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const directoryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { add(directoryPath, 'workspace symlink requires boundary review'); continue; }
      if (!entry.isDirectory()) continue;
      const owner = `${parent}/${entry.name}`;
      if (!allowedGraph[owner]) { add(directoryPath, 'workspace has no reviewed boundary policy'); continue; }
      const manifestPath = path.join(directoryPath, 'package.json');
      const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
      let config;
      try { config = readConfig(path.join(directoryPath, 'tsconfig.json')); }
      catch { add(path.join(directoryPath, 'tsconfig.json'), 'cannot safely resolve tsconfig paths'); config = { paths: {} }; }
      workspaces.set(owner, { owner, directory: directoryPath, manifest, config });
      if (manifest.name) {
        if (names.has(manifest.name)) add(manifestPath, 'duplicate workspace package name');
        names.set(manifest.name, owner);
      }
    }
  }

  function checkEdge(from, target, file, line, test) {
    if (from === target) return;
    if (test && target === 'packages/testkit') return;
    if (!target || !allowedGraph[from].includes(target)) add(file, `forbidden dependency: ${from} -> ${target ?? 'unowned source'}`, line);
  }

  function checkTarget(workspace, candidate, file, line, test, requireExists = false) {
    const target = path.resolve(candidate);
    if (!contained(root, target)) { add(file, 'import escapes repository root', line); return; }
    checkEdge(workspace.owner, ownerOf(root, target), file, line, test);
    const existing = resolveExisting(target);
    if (!existing) {
      if (requireExists) add(file, 'local import cannot be resolved for boundary inspection', line);
      return;
    }
    const real = fs.realpathSync(existing);
    if (!contained(root, real)) add(file, 'resolved import escapes repository through symlink', line);
    else checkEdge(workspace.owner, ownerOf(root, real), file, line, test);
  }

  function checkExternal(workspace, specifier, file, line, test) {
    if (test && safeTestExternals.has(packageName(specifier))) return;
    if (test && safeTestExternals.has(specifier)) return;
    if (/^(?:node:)?module(?:\/|$)/.test(specifier)) add(file, 'custom runtime module loading requires boundary review', line);
    const codecVersion = Object.hasOwn(adapterCodecVersions, specifier) ? adapterCodecVersions[specifier] : null;
    const reviewedCodec = workspace.owner === 'packages/adapters' && codecVersion !== null
      && workspace.manifest.dependencies?.[specifier] === codecVersion;
    if (pureModules.has(workspace.owner) && !safePureExternals.has(packageName(specifier)) && !reviewedCodec) add(file, `unreviewed effect or SDK dependency in deterministic module: ${packageName(specifier)}`, line);
    if (workspace.owner === 'apps/web' && (privilegedWebExternals.test(specifier) || webEffectBuiltins.test(specifier))) add(file, `privileged dependency is unavailable to web: ${packageName(specifier)}`, line);
  }

  function resolveSpecifier(workspace, specifier, file, line, test, seen = new Set()) {
    if (seen.has(specifier)) { add(file, 'circular module alias', line); return; }
    seen.add(specifier);
    if (specifier.includes('\\') || /[\x00-\x1f]/.test(specifier)) { add(file, 'noncanonical module path', line); return; }
    if (/^(?:https?|data|file):/.test(specifier)) { add(file, 'remote or URL module requires boundary review', line); return; }
    const clean = specifier.replace(/[?#].*$/, (suffix) => specifier.startsWith('#') ? suffix : '');
    const alias = matchingAlias(clean, workspace.config.paths);
    if (alias) {
      for (const target of expandAlias(clean, workspace.config.paths, alias)) checkTarget(workspace, target, file, line, test, true);
      return;
    }
    if (clean.startsWith('#')) {
      const mapping = workspace.manifest.imports ?? {};
      const importAlias = matchingAlias(clean, mapping);
      if (!importAlias) { add(file, 'unresolved package import alias', line); return; }
      for (const target of expandAlias(clean, mapping, importAlias)) {
        if (target.startsWith('.')) checkTarget(workspace, path.resolve(workspace.directory, target), file, line, test, true);
        else resolveSpecifier(workspace, target, file, line, test, new Set(seen));
      }
      return;
    }
    if (clean.startsWith('.') || path.isAbsolute(clean)) { checkTarget(workspace, path.resolve(path.dirname(file), clean), file, line, test, true); return; }
    if (clean.split('/').some((part) => part === '.' || part === '..')) { add(file, 'package subpath traversal requires boundary review', line); return; }
    const name = packageName(clean);
    const dependency = workspace.manifest.dependencies?.[name] ?? workspace.manifest.devDependencies?.[name] ?? workspace.manifest.optionalDependencies?.[name] ?? workspace.manifest.peerDependencies?.[name];
    if (dependency?.startsWith('npm:')) {
      const target = dependency.slice(4).replace(/@[^@/]+$/, '');
      if (Object.hasOwn(adapterCodecVersions, packageName(target))) {
        add(file, 'reviewed codec dependencies require a direct package name and exact pin', line);
        return;
      }
      resolveSpecifier(workspace, target + clean.slice(name.length), file, line, test, new Set(seen));
      return;
    }
    if (/^(?:file|link|portal):/.test(dependency ?? '')) {
      checkTarget(workspace, path.resolve(workspace.directory, dependency.replace(/^[^:]+:/, ''), clean.slice(name.length).replace(/^\//, '')), file, line, test);
      return;
    }
    const targetOwner = names.get(name) ?? (name.startsWith('@pactwoven/') ? Object.keys(allowedGraph).find((owner) => owner.split('/')[1] === name.slice('@pactwoven/'.length)) : null);
    if (targetOwner) { checkEdge(workspace.owner, targetOwner, file, line, test); return; }
    if (name.startsWith('@pactwoven/')) { add(file, 'unknown internal package', line); return; }
    if (workspace.config.explicitBaseUrl) {
      const candidate = path.resolve(workspace.config.baseUrl, clean);
      if (resolveExisting(candidate)) { checkTarget(workspace, candidate, file, line, test, true); return; }
    }
    checkExternal(workspace, clean, file, line, test);
    if (!dependency && !builtins.has(clean) && !(test && safeTestExternals.has(name))) add(file, `undeclared external dependency: ${name}`, line);
  }

  function inspectSource(workspace, file) {
    filesInspected += 1;
    const test = testPattern.test(posix(file));
    let ast;
    try { ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'unambiguous', plugins: ['typescript', ...(/\.[jt]sx$/.test(file) ? ['jsx'] : [])], createImportExpressions: true }); }
    catch { add(file, 'source cannot be parsed for boundary inspection'); return; }
    visit(ast, (node, parent) => {
      let argument;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) argument = node.source;
      if (node.type === 'ImportExpression') argument = node.source;
      if (node.type === 'TSImportType') argument = node.argument ?? node.source;
      if (node.type === 'TSExternalModuleReference') argument = node.expression;
      if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
        const callee = node.callee;
        const member = ['MemberExpression', 'OptionalMemberExpression'].includes(callee?.type);
        const property = member ? (callee.computed ? staticString(callee.property) : callee.property.name) : null;
        if (callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require')
          || (member && ((callee.object.name === 'require' && property === 'resolve') || (callee.object.name === 'module' && property === 'require')))) {
          argument = node.arguments[0] ?? { type: 'Unknown' };
        }
      }
      if (argument) {
        const specifier = staticString(argument);
        if (specifier === null) add(file, 'computed module loading requires explicit boundary review', node.loc?.start.line);
        else resolveSpecifier(workspace, specifier, file, node.loc?.start.line, test);
      }
      if (node.type === 'Identifier' && node.name === 'require') {
        const direct = parent && ((parent.type === 'CallExpression' && parent.callee === node)
          || (parent.type === 'MemberExpression' && parent.object === node && (parent.computed ? staticString(parent.property) : parent.property.name) === 'resolve'));
        if (!direct) add(file, 'indirect module loader requires boundary review', node.loc?.start.line);
      }
      if (node.type === 'Identifier' && ['eval', 'Function'].includes(node.name)) add(file, 'runtime code generation requires boundary review', node.loc?.start.line);
      if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type)
        && ['globalThis', 'window', 'self', 'global'].includes(node.object.name)
        && ['eval', 'Function'].includes(node.computed ? staticString(node.property) : node.property.name)) add(file, 'runtime code generation requires boundary review', node.loc?.start.line);
      if (!pureModules.has(workspace.owner)) return;
      if (node.type === 'Identifier' && ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'eval', 'Function', 'process'].includes(node.name)) {
        const propertyName = parent && ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
          || (['ObjectProperty', 'ObjectMethod', 'TSPropertySignature', 'TSMethodSignature'].includes(parent.type) && parent.key === node && !parent.computed));
        if (!propertyName) add(file, 'ambient network, credentials, or executable-code capability in deterministic module', node.loc?.start.line);
      }
      if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) {
        const property = node.computed ? staticString(node.property) : node.property.name;
        if ((node.object.type === 'Identifier' && node.object.name === 'process' && property === 'env')
          || (node.object.type === 'MetaProperty' && property === 'env')) add(file, 'ambient credentials in deterministic module', node.loc?.start.line);
        if (['globalThis', 'window', 'self', 'global'].includes(node.object.name) && ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'eval', 'Function', 'process'].includes(property)) add(file, 'ambient effect capability in deterministic module', node.loc?.start.line);
      }
    });
  }

  for (const workspace of workspaces.values()) {
    const manifestPath = path.join(workspace.directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      for (const rule of inspectSupplyChain(posix(path.relative(root, manifestPath)), fs.readFileSync(manifestPath, 'utf8'))) add(manifestPath, rule);
    }
    for (const [section, dependencies] of Object.entries(workspace.manifest)) {
      if (!['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].includes(section)) continue;
      for (const [name, version] of Object.entries(dependencies)) {
        const target = names.get(name);
        if (target) checkEdge(workspace.owner, target, manifestPath, null, section === 'devDependencies' && target === 'packages/testkit');
        if (!target && name.startsWith('@pactwoven/')) add(manifestPath, 'unknown internal dependency');
        if (/^(?:file|link|portal):/.test(version)) checkTarget(workspace, path.resolve(workspace.directory, version.replace(/^[^:]+:/, '')), manifestPath, null, false);
        if (version.startsWith('npm:')) resolveSpecifier(workspace, name, manifestPath, null, section === 'devDependencies');
        if (section !== 'devDependencies' && !target) checkExternal(workspace, name, manifestPath, null, false);
      }
    }
    for (const exported of strings(workspace.manifest.exports)) {
      const target = path.resolve(workspace.directory, exported);
      if (!exported.startsWith('./') || !contained(workspace.directory, target)) add(manifestPath, 'package export escapes its owning module');
    }
    function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) { add(file, 'source symlink requires boundary review'); continue; }
        if (entry.isDirectory()) walk(file);
        else if (sourcePattern.test(entry.name)) inspectSource(workspace, file);
      }
    }
    walk(workspace.directory);
  }
  for (const name of ['package.json', 'pnpm-workspace.yaml']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) for (const rule of inspectSupplyChain(name, fs.readFileSync(file, 'utf8'))) add(file, rule);
  }
  return { filesInspected, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkBoundaries();
    for (const finding of result.findings) process.stderr.write(`${JSON.stringify(finding.file)}${finding.line ? `:${finding.line}` : ''}: ${finding.rule}\n`);
    process.stdout.write(`Boundary check: ${result.filesInspected} source files inspected; ${result.findings.length} findings. Computed loading is rejected; this is a static guard, not proof of runtime isolation.\n`);
    process.exitCode = result.findings.length ? 1 : 0;
  } catch {
    process.stderr.write('Boundary inspection failed; no safe dependency verdict is available.\n');
    process.exitCode = 2;
  }
}
