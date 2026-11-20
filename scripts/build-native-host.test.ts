import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildNativeHost } from './build-native-host.mjs';

it('keeps each queue consumer on its own private trigger and the recovery schedule private', async () => {
  const config = JSON.parse(await readFile('services/native-host/vercel.json', 'utf8'));
  // Vercel validates configured source paths before running our bundle build.
  // A dist handler alone cannot satisfy that discovery step.
  for (const entry of Object.keys(config.functions)) {
    const source = await readFile(path.join('services/native-host', entry), 'utf8');
    expect(source).toContain(`../dist/${path.basename(entry)}`);
  }
  for (const [handler, topic] of [['consume', 'pactwoven-native-advice-v1'], ['consume-delegated', 'pactwoven-delegated-advice-v1'], ['consume-paid','pactwoven-paid-computation-v1']]) {
    const configured = config.functions[`api/${handler}.mjs`];
    expect(configured.maxDuration).toBe(300);
    expect(configured.experimentalTriggers).toHaveLength(1);
    expect(configured.experimentalTriggers[0]).toMatchObject({ type: 'queue/v2beta', topic, maxDeliveries: 8 });
  }
  expect(config.functions['api/recover.mjs'].experimentalTriggers).toEqual([{ type: 'schedule/v1beta' }]);
  expect(config.schedules['native-recovery'].function).toBe('api/recover');
  expect(config.rewrites).toEqual([{ source: '/health', destination: '/api/index' }, { source: '/internal/nudge', destination: '/api/index' }]);
});

it('loads emitted native handlers in plain Node without TypeScript or provider credentials', async () => {
  // Keep the temporary artifact beneath the host so declared external runtime
  // dependencies resolve exactly as they do from dist; no workspace JS exports.
  const outdir = await mkdtemp(path.resolve('services/native-host/.bundle-test-'));
  try {
    const result = await buildNativeHost(outdir);
    expect(result.entries).toBe(5);
    expect(result.workspaceInputs).toBeGreaterThan(0);
    const program = `
      import assert from 'node:assert/strict';
      const app = (await import('./index.mjs')).default;
      const health = await app.fetch(new Request('https://example.test/health'));
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { service: 'pactwoven-native-execution', status: 'alive' });
      const unknown = await app.fetch(new Request('https://example.test/administration'));
      assert.equal(unknown.status, 404);
      const unavailable = await app.fetch(new Request('https://example.test/v1/tasks'));
      assert.equal(unavailable.status, 404);
      const unconfigured = await app.fetch(new Request('https://example.test/internal/nudge', { method: 'POST' }));
      assert.equal(unconfigured.status, 503);
      for (const name of ['consume', 'consume-delegated', 'consume-paid', 'recover']) assert.equal(typeof (await import('./' + name + '.mjs')).POST, 'function');
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: outdir, env: {}, encoding: 'utf8', timeout: 15_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
  } finally { await rm(outdir, { recursive: true, force: true }); }
});

it('loads the independent public API artifact without execution dependencies or credentials', async () => {
  const outdir = await mkdtemp(path.resolve('services/native-api/.bundle-test-'));
  try {
    const result = await buildNativeHost(outdir, 'native-api');
    expect(result.entries).toBe(1);
    // Public URLs must reach the authenticated handler on the real host, not
    // merely pass a direct-handler test while missing a deployment rewrite.
    const config = JSON.parse(await readFile('services/native-api/vercel.json', 'utf8'));
    // Vercel appends unused named rewrite captures to the query. Memory reads
    // intentionally reject unknown selectors, so this capture must be unnamed.
    for (const source of ['/health', '/v1/tasks', '/v1/tasks/:path*', '/v1/memory', '/v1/memory/(.*)', '/v1/agent-work', '/v1/agent-work/(.*)', '/v1/google/(.*)', '/v1/voice/transcribe', '/v1/voice/speak',
      '/internal/native-authority', '/internal/native-delegated-authority']) {
      expect(config.rewrites.filter((route: { source: string; destination: string }) =>
        route.source === source && route.destination === '/api/index')).toHaveLength(1);
    }
    expect(config.rewrites.some((route: { source: string }) => route.source.startsWith('/internal/')) &&
      config.rewrites.every((route: { source: string }) => !route.source.startsWith('/internal/:'))).toBe(true);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const app = (await import('./index.mjs')).default;
      const health = await app.fetch(new Request('https://example.test/health'));
      assert.equal(health.status, 200);
      assert.equal((await health.json()).service, 'pactwoven-native-api');
      const tasks = await app.fetch(new Request('https://example.test/v1/tasks'));
      assert.equal(tasks.status, 503);
      const internal = await app.fetch(new Request('https://example.test/internal/nudge', { method: 'POST' }));
      assert.equal(internal.status, 404);
      for (const pathname of ['/v1/memory?siteId=site_one', '/v1/memory/note_one?siteId=site_one',
        '/v1/memory/operations/original_request_key?siteId=site_one']) {
        assert.equal((await app.fetch(new Request('https://example.test' + pathname))).status, 503);
      }
      for (const action of ['setup/prepare', 'setup/confirm', 'setup/recover', 'setup/cancel', 'start/prepare', 'start/confirm', 'start/recover']) {
        const response = await app.fetch(new Request('https://example.test/v1/calendar-followup/' + action, { method: 'POST' }));
        assert.equal(response.status, 404);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
      }
    `], { cwd: outdir, env: {}, encoding: 'utf8', timeout: 15_000 });
    expect(child.error).toBeUndefined(); expect(child.stderr).toBe(''); expect(child.status).toBe(0);
  } finally { await rm(outdir, { recursive: true, force: true }); }
});

it('loads the isolated signer artifact in plain Node without reading custody or opening a database', async () => {
  const outdir = await mkdtemp(path.resolve('services/paid-signer/.bundle-test-'));
  try {
    const result = await buildNativeHost(outdir, 'paid-signer');
    expect(result.entries).toBe(1);
    expect(result.workspaceInputs).toBeGreaterThan(0);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const app = (await import('./index.mjs')).default;
      assert.equal(typeof app.fetch, 'function');
      const unknown = await app.fetch(new Request('https://example.test/administration'));
      assert.equal(unknown.status, 404);
      const blocked = await app.fetch(new Request('https://example.test/internal/paid-tool-signer', {method:'POST'}));
      assert.equal(blocked.status, 503);
    `], { cwd: outdir, env: {}, encoding: 'utf8', timeout: 15_000 });
    expect(child.error).toBeUndefined(); expect(child.stderr).toBe(''); expect(child.status).toBe(0);
  } finally { await rm(outdir, { recursive: true, force: true }); }
});
