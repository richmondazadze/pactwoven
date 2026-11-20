import { describe, expect, it } from 'vitest';
import { ConfigurationError, readDevelopmentConfig } from './config.js';
function fixtureDatabaseUrl(source: string): string {
  const url = new URL(source);
  url.password = 'fixture';
  return url.href;
}


const valid = () => ({
  APP_ENVIRONMENT: 'development',
  DATABASE_URL: fixtureDatabaseUrl('postgresql://runtime@127.0.0.1:55439/pactwoven_dev'),
  CLERK_SECRET_KEY: ['sk', 'test', 'fixture'].join('_'),
  CLERK_PUBLISHABLE_KEY: `pk_test_${btoa('pactwoven-fixture.clerk.accounts.dev$').replace(/=+$/, '')}`,
  CLERK_ISSUER: 'https://pactwoven-fixture.clerk.accounts.dev',
});

describe('development environment boundary', () => {
  it('requires native task access on the same protected database with a separate login', () => {
    const named = (name: string) => fixtureDatabaseUrl(`postgresql://${name}@127.0.0.1:55439/pactwoven_dev`);
    const values = { ...valid(), PROVISIONER_DATABASE_URL: named('provisioner'), ACCESS_DATABASE_URL: named('access'),
      MANDATE_DATABASE_URL: named('mandate'), CUSTODY_SETUP_WRITER_DATABASE_URL: named('custody_writer'),
      CUSTODY_SETUP_VERIFIER_DATABASE_URL: named('custody_verifier'), FINANCIAL_POLICY_AUTHORIZER_DATABASE_URL: named('financial_authorizer'),
      FINANCIAL_POLICY_VERIFIER_DATABASE_URL: named('financial_verifier') };
    expect(readDevelopmentConfig({ ...values, NATIVE_TASK_API_DATABASE_URL: named('native_api') }).credentials?.nativeTaskDatabaseUrl).toBe(named('native_api'));
    expect(readDevelopmentConfig(valid()).credentials).not.toHaveProperty('nativeTaskDatabaseUrl');
    for (const value of ['', named('runtim%65'), named('provisioner'), named('access'), named('mandate'), named('custody_writer'),
      named('custody_verifier'), named('financial_authorizer'), named('financial_verifier'),
      named('native_api').replace(':55439', ':55440'), named('native_api') + '?options=role%3Downer']) {
      expect(() => readDevelopmentConfig({ ...values, NATIVE_TASK_API_DATABASE_URL: value })).toThrow(ConfigurationError);
    }
    expect(() => readDevelopmentConfig({ NATIVE_TASK_API_DATABASE_URL: named('native_api') })).toThrow(ConfigurationError);
    const hosted = (name: string) => fixtureDatabaseUrl(`postgresql://${name}@ep-fixture.aws.neon.tech/pactwoven_dev?sslmode=verify-full`);
    expect(readDevelopmentConfig({ ...valid(), DATABASE_URL: hosted('runtime'), NATIVE_TASK_API_DATABASE_URL: hosted('native_api') }).credentials?.nativeTaskDatabaseUrl).toBe(hosted('native_api'));
    expect(() => readDevelopmentConfig({ ...valid(), DATABASE_URL: hosted('runtime'), NATIVE_TASK_API_DATABASE_URL: hosted('native_api').replace('verify-full', 'require') })).toThrow(ConfigurationError);
  });
  it('requires the complete financial pair on the same database with distinct capability identities', () => {
    const named = (name: string) => fixtureDatabaseUrl(`postgresql://${name}@127.0.0.1:55439/pactwoven_dev`);
    const values = { ...valid(), PROVISIONER_DATABASE_URL: named('provisioner'), ACCESS_DATABASE_URL: named('access'),
      MANDATE_DATABASE_URL: named('mandate'), CUSTODY_SETUP_WRITER_DATABASE_URL: named('custody_writer'),
      CUSTODY_SETUP_VERIFIER_DATABASE_URL: named('custody_verifier'), FINANCIAL_POLICY_AUTHORIZER_DATABASE_URL: named('financial_authorizer'),
      FINANCIAL_POLICY_VERIFIER_DATABASE_URL: named('financial_verifier') };
    expect(readDevelopmentConfig(values).credentials?.financialPolicy).toEqual({
      authorizerDatabaseUrl: named('financial_authorizer'), verifierDatabaseUrl: named('financial_verifier') });
    expect(readDevelopmentConfig(valid()).credentials).not.toHaveProperty('financialPolicy');
    for (const field of ['FINANCIAL_POLICY_AUTHORIZER_DATABASE_URL', 'FINANCIAL_POLICY_VERIFIER_DATABASE_URL'] as const) {
      for (const username of ['runtime', 'provisioner', 'access', 'mandate', 'custody_writer', 'custody_verifier', 'custody_verifi%65r']) {
        expect(() => readDevelopmentConfig({ ...values, [field]: named(username) })).toThrow(ConfigurationError);
      }
      for (const value of [undefined, '', named('other').replace(':55439', ':55440'),
        named('other').replace('/pactwoven_dev', '/other_database'), named('other') + '?user=runtime']) {
        expect(() => readDevelopmentConfig({ ...values, [field]: value })).toThrow(ConfigurationError);
      }
      for (const value of [values[field], '']) expect(() => readDevelopmentConfig({ [field]: value })).toThrow(ConfigurationError);
    }
    for (const username of ['financial_authorizer', 'financial_authoriz%65r']) {
      expect(() => readDevelopmentConfig({ ...values, FINANCIAL_POLICY_VERIFIER_DATABASE_URL: named(username) })).toThrow(ConfigurationError);
    }
  });
  it('requires verified hosted financial connections and sanitizes their failures', () => {
    const named = (name: string) => fixtureDatabaseUrl(`postgresql://${name}@ep-fixture.aws.neon.tech/pactwoven_dev?sslmode=verify-full`);
    const values = { ...valid(), DATABASE_URL: named('runtime'), FINANCIAL_POLICY_AUTHORIZER_DATABASE_URL: named('financial_authorizer'),
      FINANCIAL_POLICY_VERIFIER_DATABASE_URL: named('financial_verifier') };
    expect(readDevelopmentConfig(values).credentials?.financialPolicy?.authorizerDatabaseUrl).toBe(named('financial_authorizer'));
    for (const field of ['FINANCIAL_POLICY_AUTHORIZER_DATABASE_URL', 'FINANCIAL_POLICY_VERIFIER_DATABASE_URL'] as const) {
      for (const value of [values[field].replace('verify-full', 'require'), values[field] + '&sslmode=disable',
        values[field].replace('ep-fixture', 'ep-other'), values[field] + '&options=role%3Downer', 'invalid-sensitive-connection']) {
        let failure: unknown;
        try { readDevelopmentConfig({ ...values, [field]: value }); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(ConfigurationError);
        expect(String(failure)).not.toMatch(/postgres|fixture|sensitive|owner|verify-full/);
      }
    }
  });
  it('requires a complete custody writer/verifier pair distinct from all other capabilities', () => {
    const named = (name: string) => fixtureDatabaseUrl(`postgresql://${name}@127.0.0.1:55439/pactwoven_dev`);
    const values = { ...valid(), PROVISIONER_DATABASE_URL: named('provisioner'), ACCESS_DATABASE_URL: named('access'),
      MANDATE_DATABASE_URL: named('mandate'), CUSTODY_SETUP_WRITER_DATABASE_URL: named('custody_writer'),
      CUSTODY_SETUP_VERIFIER_DATABASE_URL: named('custody_verifier') };
    expect(readDevelopmentConfig(values).credentials?.custodySetup).toEqual({ writerDatabaseUrl: named('custody_writer'), verifierDatabaseUrl: named('custody_verifier') });
    expect(readDevelopmentConfig(valid()).credentials).not.toHaveProperty('custodySetup');
    for (const field of ['CUSTODY_SETUP_WRITER_DATABASE_URL', 'CUSTODY_SETUP_VERIFIER_DATABASE_URL'] as const) {
      for (const username of ['runtime', 'provisioner', 'access', 'mandate', 'runtim%65']) {
        expect(() => readDevelopmentConfig({ ...values, [field]: named(username) })).toThrow(ConfigurationError);
      }
      for (const value of [undefined, '', named('custody_other').replace(':55439', ':55440'),
        named('custody_other').replace('/pactwoven_dev', '/other_database'), named('custody_other') + '?user=runtime']) {
        expect(() => readDevelopmentConfig({ ...values, [field]: value })).toThrow(ConfigurationError);
      }
      expect(() => readDevelopmentConfig({ [field]: values[field] })).toThrow(ConfigurationError);
    }
    expect(() => readDevelopmentConfig({ ...values, CUSTODY_SETUP_VERIFIER_DATABASE_URL: named('custody_writer') })).toThrow(ConfigurationError);
    expect(() => readDevelopmentConfig({ ...values, CUSTODY_SETUP_VERIFIER_DATABASE_URL: named('custody_writ%65r') })).toThrow(ConfigurationError);
  });
  it('applies verified hosted TLS and sanitized errors to each custody connection', () => {
    const named = (name: string) => fixtureDatabaseUrl(`postgresql://${name}@ep-fixture.aws.neon.tech/pactwoven_dev?sslmode=verify-full`);
    const values = { ...valid(), DATABASE_URL: named('runtime'), CUSTODY_SETUP_WRITER_DATABASE_URL: named('custody_writer'),
      CUSTODY_SETUP_VERIFIER_DATABASE_URL: named('custody_verifier') };
    expect(readDevelopmentConfig(values).credentials?.custodySetup?.writerDatabaseUrl).toBe(named('custody_writer'));
    for (const field of ['CUSTODY_SETUP_WRITER_DATABASE_URL', 'CUSTODY_SETUP_VERIFIER_DATABASE_URL'] as const) {
      for (const value of [values[field].replace('verify-full', 'require'), values[field] + '&sslmode=disable',
        values[field].replace('ep-fixture', 'ep-other'), values[field] + '&options=role%3Downer', 'invalid-sensitive-connection']) {
        let failure: unknown;
        try { readDevelopmentConfig({ ...values, [field]: value }); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(ConfigurationError);
        expect(String(failure)).not.toMatch(/postgres|fixture|sensitive|owner|verify-full/);
      }
    }
  });
  it('keeps mandate credentials distinct from every other development capability', () => {
    const values = { ...valid(), PROVISIONER_DATABASE_URL: fixtureDatabaseUrl('postgresql://provisioner@127.0.0.1:55439/pactwoven_dev'),
      ACCESS_DATABASE_URL: fixtureDatabaseUrl('postgresql://access@127.0.0.1:55439/pactwoven_dev') };
    const mandate = fixtureDatabaseUrl('postgresql://mandate@127.0.0.1:55439/pactwoven_dev');
    expect(readDevelopmentConfig({ ...values, MANDATE_DATABASE_URL: mandate }).credentials?.mandateDatabaseUrl).toBe(mandate);
    for (const MANDATE_DATABASE_URL of [values.DATABASE_URL, values.PROVISIONER_DATABASE_URL, values.ACCESS_DATABASE_URL,
      fixtureDatabaseUrl('postgresql://acce%73s@127.0.0.1:55439/pactwoven_dev'),
      fixtureDatabaseUrl('postgresql://mandate@localhost:55440/pactwoven_dev'),
      fixtureDatabaseUrl('postgresql://mandate@127.0.0.1:55439/other_database'), mandate + '?options=role%3Downer']) {
      expect(() => readDevelopmentConfig({ ...values, MANDATE_DATABASE_URL })).toThrow(ConfigurationError);
    }
    expect(() => readDevelopmentConfig({ MANDATE_DATABASE_URL: mandate })).toThrow(ConfigurationError);
  });
  it('requires a third distinct access identity on the same protected development database', () => {
    const PROVISIONER_DATABASE_URL = fixtureDatabaseUrl('postgresql://provisioner@127.0.0.1:55439/pactwoven_dev');
    const access = fixtureDatabaseUrl('postgresql://access@127.0.0.1:55439/pactwoven_dev');
    expect(readDevelopmentConfig({ ...valid(), PROVISIONER_DATABASE_URL, ACCESS_DATABASE_URL: access }).credentials?.accessDatabaseUrl).toBe(access);
    for (const ACCESS_DATABASE_URL of [valid().DATABASE_URL, PROVISIONER_DATABASE_URL,
      fixtureDatabaseUrl('postgresql://runtim%65@127.0.0.1:55439/pactwoven_dev'),
      fixtureDatabaseUrl('postgresql://access@localhost:55440/pactwoven_dev'),
      fixtureDatabaseUrl('postgresql://access@127.0.0.1:55439/pactwoven_backend_test'), access + '?options=role%3Downer']) {
      expect(() => readDevelopmentConfig({ ...valid(), PROVISIONER_DATABASE_URL, ACCESS_DATABASE_URL })).toThrow(ConfigurationError);
    }
    expect(() => readDevelopmentConfig({ ACCESS_DATABASE_URL: access })).toThrow(ConfigurationError);
  });
  it('permits dedicated development configuration and an explicitly unconfigured local shell', () => {
    expect(readDevelopmentConfig(valid()).environment).toBe('development');
    expect(readDevelopmentConfig({}).credentials).toBeNull();
  });

  it('rejects production, staging or simulation flags with actual development credentials', () => {
    for (const APP_ENVIRONMENT of ['production', 'staging', 'simulation']) {
      expect(() => readDevelopmentConfig({ ...valid(), APP_ENVIRONMENT })).toThrow(ConfigurationError);
    }
  });

  it('rejects live keys, mismatched issuers and partial configuration without including values in errors', () => {
    for (const changed of [
      { CLERK_SECRET_KEY: ['sk', 'live', 'sensitive_fixture'].join('_') },
      { CLERK_ISSUER: 'https://other.clerk.accounts.dev' },
      { CLERK_ISSUER: `${valid().CLERK_ISSUER}/` },
      { CLERK_PUBLISHABLE_KEY: '' },
      { DATABASE_URL: '' },
    ]) {
      let failure: unknown;
      try { readDevelopmentConfig({ ...valid(), ...changed }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(ConfigurationError);
      expect(String(failure)).not.toMatch(/sensitive_fixture|postgresql|other\.clerk/);
    }
  });

  it('requires exact secure origins and a certificate-verified dedicated hosted database', () => {
    for (const ALLOWED_ORIGINS of ['*', '', 'http://example.com', 'https://example.com/path', 'https://example.com/',
      'https://example.com?key=fixture', 'https://user:pass@example.com', 'https://example.com,https://example.com']) {
      expect(() => readDevelopmentConfig({ ...valid(), ALLOWED_ORIGINS })).toThrow(ConfigurationError);
    }
    for (const DATABASE_URL of [fixtureDatabaseUrl('postgresql://runtime@example.com/pactwoven_dev?sslmode=verify-full'),
      fixtureDatabaseUrl('postgresql://runtime@ep-fixture.aws.neon.tech/pactwoven_dev?sslmode=require'),
      fixtureDatabaseUrl('postgresql://runtime@127.0.0.1:55439/pactwoven_backend_test')]) {
      expect(() => readDevelopmentConfig({ ...valid(), DATABASE_URL })).toThrow(ConfigurationError);
    }
    expect(readDevelopmentConfig({ ...valid(),
      DATABASE_URL: fixtureDatabaseUrl('postgresql://runtime@ep-fixture.aws.neon.tech/pactwoven_dev?sslmode=verify-full'),
      ALLOWED_ORIGINS: 'https://pactwoven-development.example.com',
    }).allowedOrigins).toEqual(['https://pactwoven-development.example.com']);
  });

  it('keeps provisioner and runtime identities separate on the same database', () => {
    expect(() => readDevelopmentConfig({ ...valid(), PROVISIONER_DATABASE_URL: valid().DATABASE_URL })).toThrow(ConfigurationError);
    expect(() => readDevelopmentConfig({ ...valid(), PROVISIONER_DATABASE_URL: fixtureDatabaseUrl('postgresql://runtim%65@127.0.0.1:55439/pactwoven_dev') })).toThrow(ConfigurationError);
    expect(() => readDevelopmentConfig({ ...valid(), PROVISIONER_DATABASE_URL: fixtureDatabaseUrl('postgresql://provisioner@localhost:55440/pactwoven_dev') })).toThrow(ConfigurationError);
    expect(readDevelopmentConfig({ ...valid(), PROVISIONER_DATABASE_URL: fixtureDatabaseUrl('postgresql://provisioner@127.0.0.1:55439/pactwoven_dev') }).credentials).not.toBeNull();
  });

  it('rejects connection-string query overrides and duplicate TLS options before the pg parser sees them', () => {
    const target = fixtureDatabaseUrl('postgresql://runtime@ep-fixture.aws.neon.tech/pactwoven_dev?sslmode=verify-full');
    for (const suffix of ['&sslmode=disable', '&sslmode=verify-full', '&host=unapproved.example.com',
      '&user=owner', '&password=replacement', '&port=5433', '&options=-c%20role=owner',
      '&sslcert=/private/file', '&sslrootcert=/private/file', '&ssl=false', '&channel_binding=disable']) {
      expect(() => readDevelopmentConfig({ ...valid(), DATABASE_URL: target + suffix })).toThrow(ConfigurationError);
    }
    expect(() => readDevelopmentConfig({ ...valid(),
      PROVISIONER_DATABASE_URL: fixtureDatabaseUrl('postgresql://provisioner@127.0.0.1:55439/pactwoven_dev?user=runtime'),
    })).toThrow(ConfigurationError);
  });
});
