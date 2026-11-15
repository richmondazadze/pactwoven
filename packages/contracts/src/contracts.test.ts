import { describe, expect, it } from 'vitest';
import { BaseUnitsSchema, CreateResponsibilityCommandSchema, ServiceWindowSchema } from './index';

describe('public contract boundaries', () => {
  it('preserves exact integer units while rejecting rounding, signs and overflow', () => {
    expect(BaseUnitsSchema.parse('18446744073709551615')).toBe('18446744073709551615');
    for (const value of ['-1', '01', '1.0', '1e3', 'NaN', '18446744073709551616']) {
      expect(BaseUnitsSchema.safeParse(value).success, value).toBe(false);
    }
  });
  it('rejects injected actor/tenant fields and unbound creation versions', () => {
    const payload = { title: 'Harbor Hall', description: '', siteId: 'site-1', requirements: [], acceptancePolicy: '',
      window: { startsAt: '2026-11-15T13:00:00Z', endsAt: '2026-11-15T14:00:00Z', timeZone: 'America/Chicago' } };
    expect(CreateResponsibilityCommandSchema.safeParse({ expectedVersion: 0, mandateVersion: null, authorityEpoch: null, payload }).success).toBe(true);
    expect(CreateResponsibilityCommandSchema.safeParse({ expectedVersion: 0, mandateVersion: null, authorityEpoch: null, payload: { ...payload, organizationId: 'other' } }).success).toBe(false);
    expect(CreateResponsibilityCommandSchema.safeParse({ expectedVersion: -1, mandateVersion: null, authorityEpoch: null, payload }).success).toBe(false);
  });
  it('rejects invalid time zones and reversed service windows', () => {
    expect(ServiceWindowSchema.safeParse({ startsAt: '2026-11-15T14:00:00Z', endsAt: '2026-11-15T13:00:00Z', timeZone: 'America/Chicago' }).success).toBe(false);
    expect(ServiceWindowSchema.safeParse({ startsAt: '2026-11-15T13:00:00Z', endsAt: '2026-11-15T14:00:00Z', timeZone: 'Imaginary/Place' }).success).toBe(false);
  });
});
