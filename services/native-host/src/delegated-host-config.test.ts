import { describe, expect, it } from 'vitest';
import { readDelegatedHostConfig, readDelegatedHostDispatchConfig } from './delegated-host-config';
const url = (role: string) => {
  const value = new URL('postgresql://ep-native-test.us-east-1.aws.neon.tech/pactwoven_dev?sslmode=verify-full&channel_binding=require');
  value.username = role;value.password = 'synthetic-password';return value.href;
};
const identity = (serviceId: string) => ({ serviceId, serviceVersion: 1, workloadIdentityId: serviceId });
const services = { coordinator: identity('coordinator'), research: identity('specialist'), planning: identity('specialist'), escalation: identity('specialist') };
const values = { APP_ENVIRONMENT: 'development', NATIVE_DELEGATION_COORDINATOR_DATABASE_URL: url('coordinator_role'),
  NATIVE_DELEGATION_WORKER_DATABASE_URL: url('worker_role'), NATIVE_DELEGATION_DISPATCH_DATABASE_URL: url('dispatch_role'),
  NATIVE_DELEGATION_SERVICES: JSON.stringify(services), NATIVE_API_ORIGIN: 'https://pactwoven-native-api.vercel.app',
  AZURE_OPENAI_ENDPOINT: 'https://smartstudy-oai.services.ai.azure.com/openai/v1/responses', AZURE_OPENAI_API_KEY: 'synthetic-model-key' };
describe('delegated host protected configuration', () => {
  it('accepts three distinct verified database audiences and one exact specialist identity', () => {
    expect(readDelegatedHostConfig(values)).toMatchObject({ environment: 'development', services,
      databases: { coordinator: url('coordinator_role'), worker: url('worker_role'), dispatcher: url('dispatch_role') }, apiOrigin: values.NATIVE_API_ORIGIN });
  });
  it('initializes dispatch configuration independently of model, authority and roster settings', () => {
    expect(readDelegatedHostDispatchConfig({ ...values, AZURE_OPENAI_API_KEY: undefined, AZURE_OPENAI_ENDPOINT: undefined,
      NATIVE_DELEGATION_SERVICES: undefined, NATIVE_API_ORIGIN: undefined })).toEqual({ environment: 'development', databaseUrl: url('dispatch_role') });
  });
  it('accepts the same physical endpoint with a pooler alias and explicit default port', () => {
    expect(() => readDelegatedHostConfig({ ...values, NATIVE_DELEGATION_WORKER_DATABASE_URL: url('worker_role').replace('ep-native-test.', 'ep-native-test-pooler.').replace('/pactwoven_dev', ':5432/pactwoven_dev') })).not.toThrow();
  });
  it.each(['production', 'simulation', 'staging', undefined])('denies environment %s', APP_ENVIRONMENT => {
    expect(() => readDelegatedHostConfig({ ...values, APP_ENVIRONMENT })).toThrow('not configured');
  });
  it.each(['sslmode=require', 'sslmode=disable', 'sslmode=verify-ca', 'sslmode=verify-full&sslmode=require',
    'sslmode=verify-full&options=unsafe', 'sslmode=verify-full&channel_binding=disable'])('rejects weaker or ambiguous connection options: %s', query => {
    expect(() => readDelegatedHostDispatchConfig({ ...values, NATIVE_DELEGATION_DISPATCH_DATABASE_URL: url('dispatch_role').split('?')[0] + '?' + query })).toThrow('not configured');
  });
  it.each([
    url('worker_role').replace('/pactwoven_dev', '/production'), url('worker_role').replace('ep-native-test.', 'ep-other.'),
    url('worker_role').replace('.neon.tech', '.example.com'), url('worker_role').replace('ep-native-test.us-east-1.aws.neon.tech', '127.0.0.1'),
    url('worker_role') + '#fragment', url('worker_role').replace('worker_role:', 'worker_role%0A:'), url('worker_role').replace('/pactwoven_dev', ':6543/pactwoven_dev'),
  ])('rejects an invalid worker destination without exposing it', NATIVE_DELEGATION_WORKER_DATABASE_URL => {
    expect(() => readDelegatedHostConfig({ ...values, NATIVE_DELEGATION_WORKER_DATABASE_URL })).toThrow('not configured');
  });
  it('compares decoded login identities and rejects aliasing any role', () => {
    for (const username of ['coordinator_role', '%63oordinator_role', 'dispatch_role']) {
      expect(() => readDelegatedHostConfig({ ...values, NATIVE_DELEGATION_WORKER_DATABASE_URL: url(username) })).toThrow('not configured');
    }
  });
  it.each(['FOUNDATION_DATABASE_URL', 'DATABASE_URL', 'NATIVE_TASK_API_DATABASE_URL', 'NATIVE_DELEGATION_API_DATABASE_URL',
    'CLERK_SECRET_KEY', 'SIGNER_PRIVATE_KEY', 'CUSTODY_SETUP_WRITER_DATABASE_URL', 'UNKNOWN_DATABASE_URL'])('rejects a misplaced %s credential', key => {
    expect(() => readDelegatedHostConfig({ ...values, [key]: 'synthetic-misplaced-secret' })).toThrow('not configured');
    expect(() => readDelegatedHostDispatchConfig({ ...values, [key]: 'synthetic-misplaced-secret' })).toThrow('not configured');
  });
  it('permits the separately configured legacy execution audiences', () => {
    expect(() => readDelegatedHostConfig({ ...values, NATIVE_TASK_WORKER_DATABASE_URL: url('legacy_worker'), NATIVE_TASK_DISPATCH_DATABASE_URL: url('legacy_dispatch') })).not.toThrow();
  });
  it.each([
    undefined, '{malformed', JSON.stringify({ ...services, root: services.coordinator }),
    JSON.stringify({ ...services, coordinator: services.research }), JSON.stringify({ ...services, planning: identity('other') }),
    JSON.stringify({ ...services, escalation: { ...services.escalation, serviceVersion: 2 } }),
  ])('requires a complete exact roster', NATIVE_DELEGATION_SERVICES => {
    expect(() => readDelegatedHostConfig({ ...values, NATIVE_DELEGATION_SERVICES })).toThrow('not configured');
  });
  it.each(['http://native.vercel.app', 'https://other.example', 'https://user@native.vercel.app', 'https://native.vercel.app/path',
    'https://native.vercel.app?query=x', 'https://native.vercel.app#fragment', 'https://nested.native.vercel.app'])('denies an unsafe API authority origin %s', NATIVE_API_ORIGIN => {
    expect(() => readDelegatedHostConfig({ ...values, NATIVE_API_ORIGIN })).toThrow('not configured');
  });
  it('sanitizes parse errors and refuses an arbitrary model endpoint', () => {
    expect(() => readDelegatedHostConfig({ ...values, AZURE_OPENAI_ENDPOINT: 'https://attacker.example/responses' })).toThrow('not configured');
    let error: unknown; try { readDelegatedHostConfig({ ...values, NATIVE_DELEGATION_SERVICES: 'secret-roster-value' }); } catch (caught) { error = caught; }
    expect(String(error)).not.toContain('secret-roster-value'); expect(String(error)).not.toContain('synthetic-password');
  });
});
