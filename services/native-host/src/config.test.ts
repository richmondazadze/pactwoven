import { describe, expect, it } from 'vitest';
import { readNativeDispatchConfig, readNativeWorkerConfig } from './config.js';

const url = (role: string) => {
  const value = new URL('postgresql://ep-native-test.neon.tech/pactwoven_dev?sslmode=verify-full');
  value.username = role; value.password = 'fixture-password'; return value.href;
};
const values = { APP_ENVIRONMENT: 'development', NATIVE_TASK_WORKER_DATABASE_URL: url('worker'),
  NATIVE_API_ORIGIN: 'https://pactwoven-native-api.vercel.app',
  NATIVE_TASK_DISPATCH_DATABASE_URL: url('dispatcher'),
  AZURE_OPENAI_ENDPOINT: 'https://smartstudy-oai.services.ai.azure.com/openai/v1/responses', AZURE_OPENAI_API_KEY: 'synthetic-key' };
describe('native execution protected development configuration', () => {
  it('initializes the trusted execution audience with separate worker/dispatch logins', () => {
    expect(readNativeWorkerConfig(values).endpoint).toBe(values.AZURE_OPENAI_ENDPOINT);
    expect(readNativeWorkerConfig(values).apiOrigin).toBe(values.NATIVE_API_ORIGIN);
    expect(readNativeDispatchConfig(values).databaseUrl).toBe(values.NATIVE_TASK_DISPATCH_DATABASE_URL);
  });
  it.each([undefined, 'http://pactwoven-native-api.vercel.app', 'https://evil.test',
    'https://nested.pactwoven-native-api.vercel.app', 'https://pactwoven-native-api.vercel.app:444',
    'https://user@pactwoven-native-api.vercel.app', 'https://pactwoven-native-api.vercel.app/path',
    'https://pactwoven-native-api.vercel.app?query=yes', 'https://pactwoven-native-api.vercel.app#fragment'])('rejects an unsafe authority origin %s', origin => {
    expect(() => readNativeWorkerConfig({ ...values, NATIVE_API_ORIGIN: origin })).toThrow('not configured');
  });
  it.each(['FOUNDATION_DATABASE_URL', 'NATIVE_TASK_API_DATABASE_URL', 'CLERK_SECRET_KEY', 'SIGNER_PRIVATE_KEY'])('rejects a misplaced %s secret', key => {
    expect(() => readNativeWorkerConfig({ ...values, [key]: 'wrong-audience' })).toThrow('not configured');
    expect(() => readNativeDispatchConfig({ ...values, [key]: 'wrong-audience' })).toThrow('not configured');
  });
  it.each([undefined, 'production', 'simulation'])('rejects unsupported environment %s', environment => {
    expect(() => readNativeWorkerConfig({ ...values, APP_ENVIRONMENT: environment })).toThrow('not configured');
  });
  it.each(['sslmode=require', 'sslmode=disable', 'sslmode=verify-full&sslmode=require', 'sslmode=verify-full&options=unsafe'])('rejects weaker or ambiguous TLS %s', query => {
    expect(() => readNativeDispatchConfig({ ...values, NATIVE_TASK_DISPATCH_DATABASE_URL: url('dispatcher').split('?')[0] + '?' + query })).toThrow('not configured');
  });
  it('rejects another database, shared logins and public database destinations', () => {
    for (const changed of [
      { NATIVE_TASK_WORKER_DATABASE_URL: url('worker').replace('/pactwoven_dev', '/production') },
      { NATIVE_TASK_WORKER_DATABASE_URL: url('dispatcher') },
      { NATIVE_TASK_WORKER_DATABASE_URL: url('worker').replace('ep-native-test', 'ep-other') },
      { NATIVE_TASK_WORKER_DATABASE_URL: url('worker').replace('.neon.tech', '.example.com') },
    ]) expect(() => readNativeWorkerConfig({ ...values, ...changed })).toThrow('not configured');
  });
  it('sanitizes configuration failures without embedding secret values', () => {
    let message = '';
    try { readNativeWorkerConfig({ ...values, NATIVE_TASK_WORKER_DATABASE_URL: 'private-value' }); } catch (error) { message = String(error); }
    expect(message).toContain('not configured'); expect(message).not.toContain('private-value');
  });
});
