import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  pool: vi.fn(), repository: vi.fn(), authentication: vi.fn(), readers: vi.fn(), verifier: vi.fn(), service: vi.fn(),
  writer: { end: vi.fn() }, readerVerifier: { end: vi.fn() }, gateway: { get: vi.fn() },
}));
vi.mock('@pactwoven/db', () => ({
  createCustodySetupPool: doubles.pool,
  PostgresCustodySetupRepository: class { constructor(...args: unknown[]) { doubles.repository(...args); } },
  PostgresCustodySetupAuthenticationRepository: class { constructor(...args: unknown[]) { doubles.authentication(...args); } },
  PostgresCustodySetupReaders: class { constructor(...args: unknown[]) { doubles.readers(...args); } },
}));
vi.mock('./custody-setup-verifier.js', () => ({ createClerkCustodySetupVerifier: doubles.verifier }));
vi.mock('./custody-setup-service.js', () => ({ createCustodySetupService: doubles.service }));
import { createDevelopmentCustodySetup } from './custody-setup-development.js';

const configuration = () => ({ writerDatabaseUrl: 'writer-fixture', verifierDatabaseUrl: 'verifier-fixture',
  identity: { secretKey: 'identity-fixture', issuer: 'https://identity.example.test', authorizedParties: ['http://127.0.0.1:3001'] } });
beforeEach(() => {
  vi.resetAllMocks();
  doubles.writer.end.mockResolvedValue(undefined); doubles.readerVerifier.end.mockResolvedValue(undefined);
  doubles.pool.mockResolvedValueOnce(doubles.writer).mockResolvedValueOnce(doubles.readerVerifier);
  doubles.verifier.mockReturnValue({ observe: vi.fn() }); doubles.service.mockReturnValue(doubles.gateway);
});

describe('development custody construction', () => {
  it('wires dedicated capabilities and gives both readers the correct pool', async () => {
    const config = configuration(), value = await createDevelopmentCustodySetup(config);
    expect(doubles.pool.mock.calls).toEqual([['writer-fixture', 'writer'], ['verifier-fixture', 'verifier']]);
    expect(doubles.repository).toHaveBeenCalledExactlyOnceWith(doubles.writer);
    expect(doubles.authentication).toHaveBeenCalledExactlyOnceWith(doubles.readerVerifier);
    expect(doubles.readers).toHaveBeenCalledExactlyOnceWith(doubles.writer, doubles.readerVerifier);
    expect(doubles.verifier).toHaveBeenCalledExactlyOnceWith(config.identity);
    expect(doubles.service.mock.calls[0]![0]).toHaveProperty('verifier', doubles.verifier.mock.results[0]!.value);
    expect(value.gateway).toBe(doubles.gateway);
    expect(doubles.writer.end).not.toHaveBeenCalled();
    await value.close();
  });
  it('captures both URLs and identity settings before asynchronous pool creation', async () => {
    let release!: (value: unknown) => void;
    doubles.pool.mockReset().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(doubles.readerVerifier);
    const config = configuration(), original = structuredClone(config), pending = createDevelopmentCustodySetup(config);
    config.writerDatabaseUrl = 'changed-writer'; config.verifierDatabaseUrl = 'changed-verifier';
    config.identity.secretKey = 'changed-identity'; config.identity.issuer = 'https://other.example.test';
    config.identity.authorizedParties.push('http://127.0.0.1:9999');
    release(doubles.writer); const value = await pending;
    expect(doubles.pool.mock.calls).toEqual([[original.writerDatabaseUrl, 'writer'], [original.verifierDatabaseUrl, 'verifier']]);
    expect(doubles.verifier).toHaveBeenCalledExactlyOnceWith(original.identity);
    await value.close();
  });
  it('does not create a verifier or service when the checked writer pool fails', async () => {
    doubles.pool.mockReset().mockRejectedValueOnce(new Error('private pool diagnostic'));
    await expect(createDevelopmentCustodySetup(configuration())).rejects.toThrow('Custody development setup failed.');
    expect(doubles.pool).toHaveBeenCalledTimes(1); expect(doubles.service).not.toHaveBeenCalled();
    expect(doubles.writer.end).not.toHaveBeenCalled();
  });
  it('closes the accepted writer when verifier pool creation fails and sanitizes the error', async () => {
    doubles.pool.mockReset().mockResolvedValueOnce(doubles.writer).mockRejectedValueOnce(new Error('private verifier diagnostic'));
    const error = await createDevelopmentCustodySetup(configuration()).catch(value => value);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('private verifier diagnostic');
    expect(doubles.writer.end).toHaveBeenCalledTimes(1); expect(doubles.service).not.toHaveBeenCalled();
  });
  it('closes both pools if gateway construction fails even when one close rejects', async () => {
    doubles.service.mockImplementation(() => { throw new Error('private construction diagnostic'); });
    doubles.writer.end.mockRejectedValue(new Error('private close diagnostic'));
    const error = await createDevelopmentCustodySetup(configuration()).catch(value => value);
    expect(String(error)).toContain('Custody development setup failed.'); expect(String(error)).not.toContain('diagnostic');
    expect(doubles.writer.end).toHaveBeenCalledTimes(1); expect(doubles.readerVerifier.end).toHaveBeenCalledTimes(1);
  });
  it('closes both pools once across simultaneous and later shutdown calls', async () => {
    const value = await createDevelopmentCustodySetup(configuration());
    const first = value.close(), second = value.close(); expect(second).toBe(first);
    await Promise.all([first, second]); await value.close();
    expect(doubles.writer.end).toHaveBeenCalledTimes(1); expect(doubles.readerVerifier.end).toHaveBeenCalledTimes(1);
  });
});
