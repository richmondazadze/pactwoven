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
