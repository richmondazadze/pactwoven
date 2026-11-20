import { describe, expect, it } from 'vitest';
import { GoogleOverviewSchema } from './google-access';
describe('Google permissions without retained event details', () => {
  const legacy = { id: 'review_1', version: 1, rootTitle: 'Prepare delivery', expiresAt: '2026-11-19T00:00:00Z', status: 'active', details: 'unavailable', preparedAt: '2026-11-18T12:00:00Z' };
  const overview = { availability: 'ready', connections: [], tasks: [], consents: [legacy] };
  it('retains a usable status and version without inventing event names or times', () => { expect(GoogleOverviewSchema.parse(overview).consents[0]).toEqual(legacy); });
  it('rejects invented event details on an unavailable record and private target fields', () => {
    for (const change of [{ eventName: 'Invented name' }, { startsAt: '2026-11-19T00:00:00Z' }, { eventId: 'private_provider_id' }, { details: 'available' }]) expect(GoogleOverviewSchema.safeParse({ ...overview, consents: [{ ...legacy, ...change }] }).success).toBe(false);
  });
});
