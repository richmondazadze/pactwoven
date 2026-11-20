import { describe, expect, it } from 'vitest';
import { nativeExecutionOrigin, readNativeApiConfig, readNativeDelegatedApiConfig, readNativePaidApiConfig } from './config.js';

const url = (role: string) => {
  const value = new URL('postgresql://ep-native-test.neon.tech/pactwoven_dev?sslmode=verify-full');
  value.username = role; value.password = 'fixture-password'; return value.href;
};
const values = { APP_ENVIRONMENT: 'development', FOUNDATION_DATABASE_URL: url('foundation'),
  NATIVE_TASK_API_DATABASE_URL: url('api'), WEB_ORIGINS: 'https://pactwoven.vercel.app,http://127.0.0.1:3001',
  CLERK_ISSUER: 'https://fixture.clerk.accounts.dev', CLERK_SECRET_KEY: 'sk_test_fixture' };

describe('separate native API configuration', () => {
  it('initializes from API credentials alone, independently of the wake-up bridge', () => {
    const result = readNativeApiConfig(values);
    expect(result.environment).toBe('development');
    expect(result.identity.authorizedParties).toEqual(values.WEB_ORIGINS.split(','));
    expect(Object.keys(result)).toEqual(['environment', 'foundationDatabaseUrl', 'nativeDatabaseUrl', 'allowedOrigins', 'identity']);
  });
  it.each(['AZURE_OPENAI_API_KEY', 'NATIVE_TASK_WORKER_DATABASE_URL', 'NATIVE_TASK_DISPATCH_DATABASE_URL', 'SIGNER_PRIVATE_KEY',
    'NATIVE_DELEGATION_WORKER_DATABASE_URL', 'NATIVE_DELEGATION_COORDINATOR_DATABASE_URL', 'NATIVE_DELEGATION_DISPATCH_DATABASE_URL'])
  ('rejects known wrong-audience secret %s without exposing its value', key => {
    for (const value of ['wrong-audience-private-value', ' ']) {
      let error: unknown;
      try { readNativeApiConfig({ ...values, [key]: value }); } catch (result) { error = result; }
      expect(String(error)).toContain('not configured'); expect(String(error)).not.toContain(value === ' ' ? key : value);
    }
    expect(() => readNativeApiConfig({ ...values, [key]: '' })).not.toThrow();
  });
  it('preserves innocuous platform and unrelated nonsecret configuration', () => {
    expect(readNativeApiConfig({ ...values, VERCEL_URL: 'native-api.vercel.app', BUILD_LABEL: 'test-r3' }))
      .toEqual(readNativeApiConfig(values));
  });
  it.each([undefined, 'production', 'simulation'])('rejects unsupported application environment %s', environment => {
    expect(() => readNativeApiConfig({ ...values, APP_ENVIRONMENT: environment })).toThrow('not configured');
  });
  it.each(['*', 'https://user:password@example.com', 'http://external.example', 'https://example.com/path',
    'https://example.com?secret=x', 'https://example.com,https://example.com', ''])('rejects unsafe browser origin %s', origin => {
    expect(() => readNativeApiConfig({ ...values, WEB_ORIGINS: origin })).toThrow('not configured');
  });
  it.each(['sslmode=require', 'sslmode=disable', 'sslmode=verify-full&sslmode=require', 'sslmode=verify-full&options=unsafe'])('preserves verified TLS restrictions: %s', query => {
    expect(() => readNativeApiConfig({ ...values, NATIVE_TASK_API_DATABASE_URL: url('api').split('?')[0] + '?' + query })).toThrow('not configured');
  });
  it('rejects other databases, shared credentials, public DB destinations and live Clerk keys', () => {
    for (const changed of [
      { NATIVE_TASK_API_DATABASE_URL: url('api').replace('/pactwoven_dev', '/production') },
      { NATIVE_TASK_API_DATABASE_URL: url('foundation') },
      { NATIVE_TASK_API_DATABASE_URL: url('api').replace('ep-native-test', 'ep-other') },
      { NATIVE_TASK_API_DATABASE_URL: url('api').replace('.neon.tech', '.example.com') },
      { CLERK_SECRET_KEY: 'sk_live_fixture' },
    ]) expect(() => readNativeApiConfig({ ...values, ...changed })).toThrow('not configured');
  });
  it.each([undefined, '', 'http://pactwoven-native.vercel.app', 'https://vercel.app', 'https://other.example',
    'https://pactwoven-native.vercel.app.evil.example', 'https://nested.pactwoven-native.vercel.app',
    'https://user:password@pactwoven-native.vercel.app', 'https://pactwoven-native.vercel.app:8443',
    'https://pactwoven-native.vercel.app/internal/nudge', 'https://pactwoven-native.vercel.app?token=x',
    'https://pactwoven-native.vercel.app#path'])('rejects unsafe configured execution origin %s', origin => {
    expect(() => nativeExecutionOrigin(origin)).toThrow('not configured');
  });
  it('normalizes only the configured Vercel HTTPS origin', () => {
    expect(nativeExecutionOrigin('https://pactwoven-native.vercel.app/')).toBe('https://pactwoven-native.vercel.app');
  });
  it('sanitizes configuration errors', () => {
    let error: unknown;
    try { readNativeApiConfig({ ...values, NATIVE_TASK_API_DATABASE_URL: 'private-value' }); } catch (value) { error = value; }
    expect(String(error)).toContain('not configured'); expect(String(error)).not.toContain('private-value');
  });
});

describe('separate delegated authority configuration', () => {
  it('keeps v1 usable without v2 enrollment and requires a dedicated v2 credential', () => {
    expect(() => readNativeApiConfig(values)).not.toThrow();
    expect(() => readNativeDelegatedApiConfig(values)).toThrow('not configured');
    const config = readNativeDelegatedApiConfig({ ...values, NATIVE_DELEGATION_API_DATABASE_URL: url('delegation') });
    expect(config.delegationDatabaseUrl).toBe(url('delegation'));
    expect(config.identity).toEqual(readNativeApiConfig(values).identity);
  });
  it.each([url('api'), url('foundation'), url('delegation').replace('ep-native-test', 'ep-other'),
    url('delegation').replace('verify-full', 'require'), url('delegation').replace('/pactwoven_dev', '/other'),
    url('delegation').replace('.neon.tech', '.example.com')])('rejects a widened delegation destination or audience %#', value => {
    expect(() => readNativeDelegatedApiConfig({ ...values, NATIVE_DELEGATION_API_DATABASE_URL: value })).toThrow('not configured');
  });
  it('accepts the same verified Neon endpoint through its pooler name', () => {
    expect(() => readNativeDelegatedApiConfig({ ...values,
      NATIVE_DELEGATION_API_DATABASE_URL: url('delegation').replace('ep-native-test.', 'ep-native-test-pooler.') })).not.toThrow();
  });
});


describe('isolated paid API configuration',()=>{
  const paid={...values,PAID_TOOL_API_DATABASE_URL:url('paid_api'),PAID_TOOL_SOURCE_KEY:'source',PAID_TOOL_FEE_KEY:'fee',PAID_TOOL_ORGANIZATION_ID:'org',PAID_TOOL_ALLOW_NEW_WORK:'1'};
  it('keeps absent paid setup optional',()=>{expect(readNativePaidApiConfig(values)).toBeUndefined();});
  it('requires its own verified-TLS role and explicit organization',()=>{expect(readNativePaidApiConfig(paid)).toMatchObject({organizationId:'org',allowNewWork:true,sourceKey:'source',feeKey:'fee'});});
  it.each(['PAID_TOOL_SOURCE_KEY','PAID_TOOL_FEE_KEY','PAID_TOOL_API_DATABASE_URL','PAID_TOOL_ORGANIZATION_ID','PAID_TOOL_ALLOW_NEW_WORK'])('rejects partial setup missing%s',key=>{expect(()=>readNativePaidApiConfig({...paid,[key]:undefined})).toThrow('not configured');});
  it('rejects shared audience credentials and changed database hosts',()=>{for(const changed of [{PAID_TOOL_API_DATABASE_URL:url('api')},{PAID_TOOL_API_DATABASE_URL:url('foundation')},{PAID_TOOL_API_DATABASE_URL:url('delegated'),NATIVE_DELEGATION_API_DATABASE_URL:url('delegated')},{PAID_TOOL_API_DATABASE_URL:url('paid_api').replace('ep-native-test','ep-other')},{PAID_TOOL_FEE_KEY:'source'}])expect(()=>readNativePaidApiConfig({...paid,...changed})).toThrow('not configured');});
  it.each(['PAID_TOOL_SOURCE_PRIVATE_KEY','PAID_TOOL_SIGNER_DATABASE_URL','PAID_TOOL_POLICY_DATABASE_URL','PAID_TOOL_BROADCASTER_DATABASE_URL','PAID_TOOL_OBSERVER_DATABASE_URL','PAID_TOOL_DELIVERY_DATABASE_URL','PAID_TOOL_SCHEDULER_DATABASE_URL'])('rejects execution secret%s in this API',key=>{expect(()=>readNativePaidApiConfig({...paid,[key]:'private'})).toThrow('not configured');});
  it('can disable new work while retaining original receipt access',()=>{expect(readNativePaidApiConfig({...paid,PAID_TOOL_ALLOW_NEW_WORK:'0'})?.allowNewWork).toBe(false);});
});
