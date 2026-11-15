import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  pool: vi.fn(), repository: vi.fn(), authentication: vi.fn(), readers: vi.fn(), verifier: vi.fn(), gateway: vi.fn(),
  authorizer: { end: vi.fn() }, observer: { end: vi.fn() }, service: { context: vi.fn() },
}));
vi.mock('@pactwoven/db', () => ({
  createFinancialAuthorityPool: doubles.pool,
  PostgresFinancialPolicyRepository: class { constructor(...args: unknown[]) { doubles.repository(...args); } },
  PostgresFinancialAuthenticationRepository: class { constructor(...args: unknown[]) { doubles.authentication(...args); } },
  PostgresFinancialPolicyReaders: class { constructor(...args: unknown[]) { doubles.readers(...args); } },
}));
vi.mock('./financial-policy-verifier.js', () => ({ createClerkFinancialPolicyVerifier: doubles.verifier }));
vi.mock('./financial-policy-service.js', () => ({ createFinancialPolicyGateway: doubles.gateway }));
import { createDevelopmentFinancialPolicy } from './financial-policy-development.js';

const configuration = () => ({ authorizerDatabaseUrl: 'authorizer-fixture', verifierDatabaseUrl: 'verifier-fixture',
  identity: { secretKey: 'identity-fixture', issuer: 'https://identity.example.test', authorizedParties: ['http://127.0.0.1:3001'] } });
beforeEach(() => {
  vi.resetAllMocks();
  doubles.authorizer.end.mockResolvedValue(undefined); doubles.observer.end.mockResolvedValue(undefined);
  doubles.pool.mockResolvedValueOnce(doubles.authorizer).mockResolvedValueOnce(doubles.observer);
  doubles.verifier.mockReturnValue({ observe: vi.fn() }); doubles.gateway.mockReturnValue(doubles.service);
});

describe('development financial policy construction', () => {
  it('wires verified capabilities to the read gateway without executing a request', async () => {
    const config = configuration(), value = await createDevelopmentFinancialPolicy(config);
    expect(doubles.pool.mock.calls).toEqual([['authorizer-fixture', 'authorizer'], ['verifier-fixture', 'verifier']]);
    expect(doubles.repository).toHaveBeenCalledExactlyOnceWith(doubles.authorizer);
    expect(doubles.authentication).toHaveBeenCalledExactlyOnceWith(doubles.observer);
    expect(doubles.readers).toHaveBeenCalledExactlyOnceWith(doubles.authorizer, doubles.observer);
    expect(doubles.verifier).toHaveBeenCalledExactlyOnceWith(config.identity, 'development');
    expect(doubles.gateway.mock.calls[0]![0]).toMatchObject({ environment: 'development', issuer: config.identity.issuer,
      verifier: doubles.verifier.mock.results[0]!.value });
    expect(value.gateway).toBe(doubles.service); expect(doubles.service.context).not.toHaveBeenCalled();
    expect(doubles.authorizer.end).not.toHaveBeenCalled(); await value.close();
  });
  it('captures both connections and identity settings before pool creation can yield', async () => {
    let release!: (value: unknown) => void;
    doubles.pool.mockReset().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(doubles.observer);
    const config = configuration(), original = structuredClone(config), pending = createDevelopmentFinancialPolicy(config);
    config.authorizerDatabaseUrl = 'changed-authorizer'; config.verifierDatabaseUrl = 'changed-verifier';
    config.identity.secretKey = 'changed-secret'; config.identity.issuer = 'https://other.example.test';
    config.identity.authorizedParties.push('http://127.0.0.1:9999');
    release(doubles.authorizer); const value = await pending;
    expect(doubles.pool.mock.calls).toEqual([[original.authorizerDatabaseUrl, 'authorizer'], [original.verifierDatabaseUrl, 'verifier']]);
    expect(doubles.verifier).toHaveBeenCalledExactlyOnceWith(original.identity, 'development');
    expect(doubles.gateway.mock.calls[0]![0].issuer).toBe(original.identity.issuer); await value.close();
  });
  it('stops construction after the first rejected capability and hides diagnostics', async () => {
    doubles.pool.mockReset().mockRejectedValueOnce(new Error('private first-pool diagnostic'));
    const error = await createDevelopmentFinancialPolicy(configuration()).catch(value => value);
    expect(String(error)).toContain('Financial policy development setup failed.');
    expect(String(error)).not.toContain('diagnostic'); expect(doubles.pool).toHaveBeenCalledTimes(1);
    expect(doubles.gateway).not.toHaveBeenCalled(); expect(doubles.authorizer.end).not.toHaveBeenCalled();
  });
  it('closes an initialized authorizer if the verifier capability is rejected', async () => {
    doubles.pool.mockReset().mockResolvedValueOnce(doubles.authorizer).mockRejectedValueOnce(new Error('private second-pool diagnostic'));
    await expect(createDevelopmentFinancialPolicy(configuration())).rejects.toThrow('Financial policy development setup failed.');
    expect(doubles.authorizer.end).toHaveBeenCalledTimes(1); expect(doubles.observer.end).not.toHaveBeenCalled();
    expect(doubles.gateway).not.toHaveBeenCalled();
  });
  it.each(['reject', 'throw'] as const)('closes both initialized capabilities when construction and cleanup %s', async mode => {
    doubles.gateway.mockImplementation(() => { throw new Error('private construction diagnostic'); });
    if (mode === 'reject') doubles.authorizer.end.mockRejectedValue(new Error('private cleanup diagnostic'));
    else doubles.authorizer.end.mockImplementation(() => { throw new Error('private cleanup diagnostic'); });
    const error = await createDevelopmentFinancialPolicy(configuration()).catch(value => value);
    expect(String(error)).toContain('Financial policy development setup failed.'); expect(String(error)).not.toContain('diagnostic');
    expect(doubles.authorizer.end).toHaveBeenCalledTimes(1); expect(doubles.observer.end).toHaveBeenCalledTimes(1);
  });
  it('closes each capability once across overlapping and repeated shutdown calls', async () => {
    const value = await createDevelopmentFinancialPolicy(configuration()), first = value.close(), second = value.close();
    expect(first).toBe(second); await Promise.all([first, second]); await value.close();
    expect(doubles.authorizer.end).toHaveBeenCalledTimes(1); expect(doubles.observer.end).toHaveBeenCalledTimes(1);
  });
});
