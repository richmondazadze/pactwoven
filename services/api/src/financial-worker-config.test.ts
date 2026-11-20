import { describe, expect, it } from 'vitest';
import { readFinancialWorkerConfig, type FinancialWorkerBindings } from './financial-worker-config.js';
const issuer = 'https://financial-fixture.clerk.accounts.dev';
const db = (name: string) => {
  const url = new URL(`postgresql://${name}.internal:5432/pactwoven_dev?sslmode=disable`);
  url.username = name; url.password = 'synthetic';
  return { connectionString: url.href, user: name, host: `${name}.internal`, database: 'pactwoven_dev', port: 5432 };
};
function bindings(): FinancialWorkerBindings {
  return { APP_ENVIRONMENT: 'development', WORKER_ROLE: 'financial', ALLOWED_ORIGINS: 'http://localhost:3000,https://app.example',
    CLERK_ISSUER: issuer, CLERK_SECRET_KEY: 'sk_test_synthetic', CLERK_PUBLISHABLE_KEY: `pk_test_${btoa('financial-fixture.clerk.accounts.dev$').replace(/=+$/, '')}`,
    FINANCIAL_POLICY_AUTHORIZER_DATABASE: db('authorizer'), FINANCIAL_POLICY_VERIFIER_DATABASE: db('verifier'),
    CUSTODY_SETUP_WRITER_DATABASE: db('writer'), CUSTODY_SETUP_VERIFIER_DATABASE: db('custody_verifier'),
    EXPECTED_FINANCIAL_POLICY_AUTHORIZER_DATABASE_USER: 'financial_authorizer', EXPECTED_FINANCIAL_POLICY_VERIFIER_DATABASE_USER: 'financial_verifier',
    EXPECTED_CUSTODY_SETUP_WRITER_DATABASE_USER: 'custody_writer', EXPECTED_CUSTODY_SETUP_VERIFIER_DATABASE_USER: 'custody_verifier' };
}
describe('private financial worker configuration', () => {
  it('captures four independent proxy configurations and origin principals', () => {
    const input = bindings(), output = readFinancialWorkerConfig(input);
    expect(output.environment).toBe('development'); expect(output.financialAuthorizer.expectedUser).toBe('financial_authorizer');
    input.FINANCIAL_POLICY_AUTHORIZER_DATABASE = db('replacement'); input.ALLOWED_ORIGINS = 'https://other.example';
    expect(output.financialAuthorizer.connectionString).toContain('authorizer.internal'); expect(output.allowedOrigins).toContain('http://localhost:3000');
  });
  it.each(['DATABASE_URL', 'DATABASE', 'IDENTITY_PROVISIONER', 'FINANCIAL_AUTHORITY', 'MANDATE_DATABASE', 'SUPPLIER_DATABASE', 'CUSTODY_SETUP_WRITER_DATABASE_URL'])('rejects foreign binding %s', field => {
    expect(() => readFinancialWorkerConfig({ ...bindings(), [field]: 'private-value' })).toThrow('Development Worker bindings are not configured correctly.');
  });
  it.each(['production', 'staging', ''])('rejects environment %s', APP_ENVIRONMENT => {
    expect(() => readFinancialWorkerConfig({ ...bindings(), APP_ENVIRONMENT })).toThrow();
  });
  it('rejects missing capabilities, duplicate origin principals and reused proxy bindings', () => {
    const keys = ['FINANCIAL_POLICY_AUTHORIZER_DATABASE', 'FINANCIAL_POLICY_VERIFIER_DATABASE', 'CUSTODY_SETUP_WRITER_DATABASE', 'CUSTODY_SETUP_VERIFIER_DATABASE'] as const;
    for (const key of keys) {
      const input = bindings(); delete input[key]; expect(() => readFinancialWorkerConfig(input)).toThrow();
    }
    expect(() => readFinancialWorkerConfig({ ...bindings(), EXPECTED_CUSTODY_SETUP_VERIFIER_DATABASE_USER: 'financial_authorizer' })).toThrow();
    expect(() => readFinancialWorkerConfig({ ...bindings(), CUSTODY_SETUP_WRITER_DATABASE: db('authorizer') })).toThrow();
  });
  it.each(['https://app.example/', 'https://app.example,https://app.example', 'http://public.example', 'https://user:pass@app.example', 'https://app.example#fragment'])('rejects invalid origin %s', ALLOWED_ORIGINS => {
    expect(() => readFinancialWorkerConfig({ ...bindings(), ALLOWED_ORIGINS })).toThrow();
  });
  it('rejects live credentials, issuer mismatch and incoherent database metadata without exposing values', () => {
    for (const patch of [{ CLERK_SECRET_KEY: 'sk_live_PRIVATE' }, { CLERK_ISSUER: 'https://other.clerk.accounts.dev' },
      { FINANCIAL_POLICY_VERIFIER_DATABASE: { ...db('verifier'), user: 'other' } }, { EXPECTED_CUSTODY_SETUP_WRITER_DATABASE_USER: 'Invalid-role' }]) {
      expect(() => readFinancialWorkerConfig({ ...bindings(), ...patch })).toThrow('Development Worker bindings are not configured correctly.');
    }
  });
});
