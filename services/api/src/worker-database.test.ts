import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { readDatabaseBinding } from './worker-config.js';
import { createWorkerPool } from './worker-database.js';

function binding() {
  const url = new URL('postgresql://binding.hyperdrive.local:5432/proxy_database?sslmode=disable');
  url.username = 'proxy_user'; url.password = 'fixture';
  return { connectionString: url.href,
    host: 'binding.hyperdrive.local', port: 5432, user: 'proxy_user', database: 'proxy_database' };
}
const matching = { database_matches: true, current_matches: true, session_matches: true };
function pool(rows: unknown[] = [matching]) {
  return { query: vi.fn(async () => ({ rows })), end: vi.fn(async () => {}) };
}

describe('Hyperdrive transport and actual origin identity', () => {
  it('accepts internally consistent synthetic credentials without confusing them with the Neon identity', () => {
    expect(readDatabaseBinding(binding())).toBe(binding().connectionString);
  });

  it.each(['native-proxy.invalid', '127.0.0.1', 'hyperdrive'])('uses the native binding host without assuming a DNS suffix: %s', host => {
    const value=binding(); value.host=host; value.connectionString=value.connectionString.replace('binding.hyperdrive.local',host);
    expect(readDatabaseBinding(value)).toBe(value.connectionString);
  });

  it.each([
    { user: 'another' }, { database: 'another' }, { host: 'other.hyperdrive.local' }, { port: 5433 },
    { port: 0 }, { port: 65536 }, { port: 5432.1 }, { user: '' }, { database: '' },
    { connectionString: binding().connectionString + '&user=owner' },
    { connectionString: binding().connectionString + '&options=-c%20role=owner' },
    { connectionString: binding().connectionString + '&sslmode=disable' },
    { connectionString: binding().connectionString + '#fragment' },
    { connectionString: binding().connectionString.replace('fixture@', '@') },
    { connectionString: binding().connectionString.replace('postgresql:', 'https:') },
    { host: '' },
  ])('rejects transport substitution or query overrides: %j', patch => {
    expect(() => readDatabaseBinding({ ...binding(), ...patch })).toThrow();
  });

  it('checks exact database, current role and session role after the privilege factory succeeds', async () => {
    const db = pool(), factory = vi.fn(async () => db as unknown as Pool);
    expect(await createWorkerPool(factory, 'pactwoven_dev_app')).toBe(db);
    expect(factory).toHaveBeenCalledOnce();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('session_user'), ['pactwoven_dev', 'pactwoven_dev_app']);
    expect(db.end).not.toHaveBeenCalled();
  });

  it.each([
    [], [matching, matching], [{ ...matching, database_matches: false }],
    [{ ...matching, current_matches: false }], [{ ...matching, session_matches: false }],
    [{ ...matching, current_matches: 'true' }], [{}], [null],
  ].map(rows => ({ rows })))('closes an unverified pool before a repository can receive it: %j', async ({ rows }) => {
    const db = pool(rows);
    await expect(createWorkerPool(async () => db as unknown as Pool, 'pactwoven_dev_app')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(db.end).toHaveBeenCalledOnce();
  });

  it('does not bypass or retry a rejected privilege factory', async () => {
    const factory = vi.fn(async (): Promise<Pool> => { throw new Error('privilege rejected'); });
    await expect(createWorkerPool(factory, 'pactwoven_dev_app')).rejects.toThrow('privilege rejected');
    expect(factory).toHaveBeenCalledOnce();
  });

  it('sanitizes identity query and cleanup errors', async () => {
    const db = pool(); db.query.mockRejectedValue(new Error('PRIVATE_ORIGIN_DETAILS')); db.end.mockRejectedValue(new Error('PRIVATE_END_DETAILS'));
    await expect(createWorkerPool(async () => db as unknown as Pool, 'pactwoven_dev_app')).rejects.toThrow('The development database identity could not be verified.');
    expect(db.end).toHaveBeenCalledOnce();
  });
});
