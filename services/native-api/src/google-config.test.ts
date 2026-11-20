import { describe, expect, it } from 'vitest';
import { GOOGLE_FOREGROUND_LANES, readNativeGoogleConfig } from './google-config';

function url(role: string) {
  const u = new URL('postgresql://ep-google-test.neon.tech/pactwoven_dev?sslmode=verify-full');
  u.username = role; u.password = 'synthetic-password'; return u.href;
}
function values(): Record<string, string> {
  return { APP_ENVIRONMENT: 'development', FOUNDATION_DATABASE_URL: url('foundation'), NATIVE_TASK_API_DATABASE_URL: url('native'),
    NATIVE_DELEGATION_API_DATABASE_URL: url('delegated'), WEB_ORIGINS: 'https://pactwoven.vercel.app,http://127.0.0.1:3001',
    CLERK_ISSUER: 'https://fixture.clerk.accounts.dev', CLERK_SECRET_KEY: 'sk_test_fixture', GOOGLE_PUBLIC_WEB_ORIGIN: 'https://pactwoven.vercel.app',
    GOOGLE_OAUTH_CLIENT_ID: 'synthetic.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-oauth-value',
    GOOGLE_VAULT_ACTIVE_KEY_ID: 'current', GOOGLE_VAULT_KEYS: JSON.stringify({ current: Buffer.alloc(32, 11).toString('base64url'), previous: Buffer.alloc(32, 12).toString('base64url') }),
    ...Object.fromEntries(GOOGLE_FOREGROUND_LANES.map(lane => [`GOOGLE_${lane.toUpperCase()}_DATABASE_URL`, url('google_' + lane)])) };
}

describe('foreground Google configuration', () => {
  it('binds the selected account, exact callback and five separate foreground roles', () => {
    const config = readNativeGoogleConfig(values());
    expect(config.oauth.expectedEmail).toBe('richverseecotech@gmail.com');
    expect(config.oauth.redirectUri).toBe('https://pactwoven.vercel.app/app/settings/connections/google/callback');
    expect(Object.keys(config.databaseUrls)).toEqual(GOOGLE_FOREGROUND_LANES);
    expect(config.keyring.getKey('missing')).toBeUndefined();
    const copy = config.keyring.getKey('current')!; copy.fill(0);
    expect(config.keyring.getKey('current')).toEqual(new Uint8Array(32).fill(11));
    expect(config.keyring.getKey('previous')).toEqual(new Uint8Array(32).fill(12));
    expect(JSON.stringify(config.keyring)).not.toContain(Buffer.alloc(32, 11).toString('base64url'));
  });
  it.each(GOOGLE_FOREGROUND_LANES)('requires a distinct, bound and TLS-verified %s pool', lane => {
    const env = values(), variable = `GOOGLE_${lane.toUpperCase()}_DATABASE_URL`;
    for (const bad of ['', url('foundation'), url('native'), url('delegated'), url('wrong').replace('ep-google-test', 'ep-other'), url('wrong').replace('/pactwoven_dev', '/other'), url('wrong').replace('verify-full', 'require'), url('wrong') + '&sslmode=verify-full', url('wrong') + '&options=unsafe']) {
      expect(() => readNativeGoogleConfig({ ...env, [variable]: bad })).toThrow('not configured');
    }
    const other = GOOGLE_FOREGROUND_LANES.find(item => item !== lane)!;
    expect(() => readNativeGoogleConfig({ ...env, [variable]: url('google_' + other) })).toThrow('not configured');
  });
  it.each(['GOOGLE_WORKER_DATABASE_URL', 'GOOGLE_CONTENT_DATABASE_URL', 'AZURE_OPENAI_API_KEY', 'SIGNER_PRIVATE_KEY'])('rejects unused private capability %s without exposing its value', key => {
    expect(() => readNativeGoogleConfig({ ...values(), [key]: 'sensitive-input' })).toThrow('not configured');
    try { readNativeGoogleConfig({ ...values(), [key]: 'sensitive-input' }); } catch (error) { expect(String(error)).not.toContain('sensitive-input'); }
  });
  it('rejects percent-encoded aliases among existing database roles', () => {
    for (const changed of [
      { NATIVE_TASK_API_DATABASE_URL: url('foundation').replace('foundation:', '%66oundation:') },
      { NATIVE_DELEGATION_API_DATABASE_URL: url('foundation').replace('foundation:', '%66oundation:') },
      { NATIVE_DELEGATION_API_DATABASE_URL: url('native').replace('native:', '%6eative:') },
    ]) expect(() => readNativeGoogleConfig({ ...values(), ...changed })).toThrow('not configured');
  });
  it('rejects missing or malformed vault keys without generating a replacement', () => {
    for (const keys of ['', '{}', 'null', '[]', '{', JSON.stringify({ current: 'invalid' }), JSON.stringify({ current: Buffer.alloc(31).toString('base64url') }), JSON.stringify({ current: Buffer.alloc(32).toString('base64') })]) {
      expect(() => readNativeGoogleConfig({ ...values(), GOOGLE_VAULT_KEYS: keys })).toThrow('not configured');
    }
    expect(() => readNativeGoogleConfig({ ...values(), GOOGLE_VAULT_ACTIVE_KEY_ID: 'unknown' })).toThrow('not configured');
  });
  it('requires an approved HTTPS origin and valid OAuth client identity', () => {
    for (const origin of ['http://127.0.0.1:3001', 'https://foreign.example', 'https://pactwoven.vercel.app/path', 'https://pactwoven.vercel.app/']) {
      expect(() => readNativeGoogleConfig({ ...values(), GOOGLE_PUBLIC_WEB_ORIGIN: origin })).toThrow('not configured');
    }
    expect(() => readNativeGoogleConfig({ ...values(), GOOGLE_OAUTH_CLIENT_ID: 'invalid-client' })).toThrow('not configured');
  });
});
