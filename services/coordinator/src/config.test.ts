import { describe, expect, it } from 'vitest';
import { CoordinatorConfigurationError, readCoordinatorConfig } from './config.js';

const values = () => {
  const database = new URL('postgresql://native_worker@127.0.0.1:55447/pactwoven_dev');
  database.password = 'fixture';
  return { APP_ENVIRONMENT: 'development', NATIVE_TASK_WORKER_DATABASE_URL: database.href,
    AZURE_OPENAI_ENDPOINT: 'https://fixture.services.ai.azure.com/openai/v1/responses',
    AZURE_OPENAI_API_KEY: 'synthetic-test-value', NATIVE_WORKER_ID: 'worker-one' };
};

describe('coordinator protected configuration', () => {
  it('uses the separate worker binding and preserves a full responses endpoint', () => {
    const input = values();
    expect(readCoordinatorConfig(input)).toMatchObject({ environment: 'development', endpoint: input.AZURE_OPENAI_ENDPOINT, databaseUrl: input.NATIVE_TASK_WORKER_DATABASE_URL });
    expect(readCoordinatorConfig({ ...input, AZURE_OPENAI_ENDPOINT: input.AZURE_OPENAI_ENDPOINT.replace('/responses', '') }).endpoint).toBe(input.AZURE_OPENAI_ENDPOINT);
  });
  it('fails closed for partial configuration, production promotion, unsafe DSNs and endpoint substitution', () => {
    for (const changed of [{ APP_ENVIRONMENT: 'production' }, { NATIVE_TASK_WORKER_DATABASE_URL: '' }, { AZURE_OPENAI_API_KEY: '' },
      { NATIVE_TASK_WORKER_DATABASE_URL: values().NATIVE_TASK_WORKER_DATABASE_URL + '?options=role%3Downer' },
      { NATIVE_TASK_WORKER_DATABASE_URL: values().NATIVE_TASK_WORKER_DATABASE_URL.replace('127.0.0.1', 'private.example') },
      { AZURE_OPENAI_ENDPOINT: 'https://attacker.example/openai/v1/responses' }]) {
      expect(() => readCoordinatorConfig({ ...values(), ...changed })).toThrow(CoordinatorConfigurationError);
    }
    expect(() => readCoordinatorConfig({})).toThrow(CoordinatorConfigurationError);
  });
  it('requires verified TLS for a hosted worker database and hides bad input in errors', () => {
    const base = values().NATIVE_TASK_WORKER_DATABASE_URL.replace('127.0.0.1:55447', 'ep-fixture.aws.neon.tech');
    expect(readCoordinatorConfig({ ...values(), NATIVE_TASK_WORKER_DATABASE_URL: base + '?sslmode=verify-full' }).databaseUrl).toContain('sslmode=verify-full');
    try { readCoordinatorConfig({ ...values(), NATIVE_TASK_WORKER_DATABASE_URL: base + '?sslmode=require' }); }
    catch (error) { expect(String(error)).not.toMatch(/fixture|postgres|synthetic-test-value/); return; }
    throw new Error('Expected unverified TLS to be rejected.');
  });
});
