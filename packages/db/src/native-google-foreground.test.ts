import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { NativeGoogleReadSchema, NativeGoogleEventSchema } from '../../contracts/src/native-google';
import { PostgresNativeGoogleStore } from './native-google-repository';
import { PostgresNativeGoogleAccessRepository } from './native-google-access-repository';

describe('foreground Google repositories without background credentials', () => {
  it('cannot redirect worker reads onto its OAuth login', async () => {
    const query = vi.fn(), pool = { query } as unknown as Pool;
    const store = new PostgresNativeGoogleStore(pool, undefined, 'development');
    await expect(store.resolveRead(randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'GOOGLE_INTEGRATION_REQUIRED' });
    await expect(store.failRefresh(randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'GOOGLE_INTEGRATION_REQUIRED' });
    expect(query).not.toHaveBeenCalled();
  });
  it('retains existing OAuth calls with no worker credential', async () => {
    const query = vi.fn(async () => ({ rows: [{ response: true }] })), pool = { query } as unknown as Pool;
    const store = new PostgresNativeGoogleStore(pool, undefined, 'development');
    await expect(store.failAttempt(randomUUID(), randomUUID())).resolves.toBeUndefined();
    expect(query.mock.calls).toHaveLength(1);
  });
  it('cannot redirect content writes onto an observer, consent or review login', async () => {
    const query = vi.fn(), pool = { query } as unknown as Pool;
    const access = new PostgresNativeGoogleAccessRepository({ observer: pool, api: pool, review: pool }, 'development');
    // Reach the missing-lane check with schema inputs isolated from this test's
    // concern; existing schema suites independently exercise malformed inputs.
    const read = vi.spyOn(NativeGoogleReadSchema, 'parse').mockReturnValue({} as never);
    const event = vi.spyOn(NativeGoogleEventSchema, 'parse').mockReturnValue({} as never);
    try {
      await expect(access.content.retain({} as never, {} as never, 'a'.repeat(64), new AbortController().signal)).rejects.toMatchObject({ code: 'GOOGLE_INTEGRATION_REQUIRED' });
      expect(query).not.toHaveBeenCalled();
    } finally { read.mockRestore(); event.mockRestore(); }
  });
});
