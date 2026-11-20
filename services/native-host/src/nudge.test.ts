import { beforeAll, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { createNativeExecutionHandler, createNativeNudgeVerifier, readNativeNudgeIdentity } from './nudge.js';

const identity = { team: 'test-team', teamId: 'team_A', project: 'native-api', projectId: 'prj_A' };
let privateKey: KeyLike, verify: ReturnType<typeof createNativeNudgeVerifier>;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey;
  const key = await exportJWK(pair.publicKey);
  verify = createNativeNudgeVerifier(identity, createLocalJWKSet({ keys: [{ ...key, alg: 'RS256', kid: 'test-key' }] }));
});
async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: 'https://oidc.vercel.com/test-team', aud: 'https://vercel.com/test-team',
    sub: 'owner:test-team:project:native-api:environment:production', owner: 'test-team', owner_id: 'team_A',
    project: 'native-api', project_id: 'prj_A', environment: 'production', iat: now, nbf: now, exp: now + 7200, ...overrides })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }).sign(privateKey);
}
const request = (jwt: string, options?: RequestInit) => new Request('https://execution.vercel.app/internal/nudge', {
  method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, ...options,
});

it('accepts only the pinned project, team and production service identity with a valid signature', async () => {
  expect(await verify(request(await token()))).toBe(true);
  for (const claims of [{ iss: 'https://oidc.vercel.com' }, { aud: 'elsewhere' }, { sub: 'someone-else' },
    { owner: 'other' }, { owner_id: 'team_B' }, { project: 'other' }, { project_id: 'prj_B' },
    { environment: 'preview' }, { environment: 'development' }, { exp: 1 }, { nbf: 9999999999 },
    { iat: 1 }, { nbf: undefined }, { exp: undefined }, { exp: Math.floor(Date.now() / 1000) + 86400 }]) {
    expect(await verify(request(await token(claims)))).toBe(false);
  }
  const valid = await token();
  const parts = valid.split('.'); parts[1] = Buffer.from('{"project_id":"prj_A"}').toString('base64url');
  expect(await verify(request(parts.join('.')))).toBe(false);
  expect(await verify(new Request('https://execution.vercel.app/internal/nudge', {
    method: 'POST', headers: { 'x-vercel-oidc-token': valid, 'x-vercel-trusted-oidc-idp-token': valid },
  }))).toBe(false);
});

it('rejects invalid config instead of constructing a caller-controlled key URL', () => {
  for (const team of ['../other', 'test-team@evil.test', 'test-team/other']) {
    expect(() => readNativeNudgeIdentity({ NATIVE_API_TEAM_SLUG: team, NATIVE_API_TEAM_ID: 'team_A',
      NATIVE_API_PROJECT_NAME: 'native-api', NATIVE_API_PROJECT_ID: 'prj_A' })).toThrow();
  }
});

it('accepts a no-body nudge only after authentication and rejects unrelated routes or payloads', async () => {
  const publish = vi.fn(async () => undefined), app = createNativeExecutionHandler({ verify, publish });
  expect((await app(new Request('https://execution.vercel.app/health'))).status).toBe(200);
  expect((await app(new Request('https://execution.vercel.app/v1/tasks'))).status).toBe(404);
  expect((await app(new Request('https://execution.vercel.app/internal/nudge'))).status).toBe(405);
  expect((await app(request('bad'))).status).toBe(401);
  expect((await app(request(await token(), { body: '{}' }))).status).toBe(400);
  expect(publish).not.toHaveBeenCalled();
  expect((await app(request(await token()))).status).toBe(202);
  expect(publish).toHaveBeenCalledOnce();
  expect((await app(request(await token()))).status).toBe(202);
  expect(publish).toHaveBeenCalledTimes(2);
  expect((await app(request(await token(), { body: '' }))).status).toBe(202);
  expect(publish).toHaveBeenCalledTimes(3);
});

it('leaves unavailable dispatch recoverable and suppresses private errors', async () => {
  const app = createNativeExecutionHandler({ verify, publish: async () => { throw Error('private diagnostic'); } });
  const result = await app(request(await token()));
  expect(result.status).toBe(503); expect(await result.text()).toBe('');
  const unavailable = createNativeExecutionHandler({ verify: async () => { throw Error('private key/config'); }, publish: vi.fn() });
  expect((await unavailable(request(await token()))).status).toBe(503);
});
