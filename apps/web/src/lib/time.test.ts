import { describe, expect, it } from 'vitest';
import { zonedDateTimeToIso } from './time';
describe('site-local service windows', () => {
  it('uses the site zone, independently of the operator’s computer zone', () => {
    expect(zonedDateTimeToIso('2026-11-15T07:00','America/Chicago')).toBe('2026-11-15T13:00:00.000Z');
    expect(zonedDateTimeToIso('2026-11-15T07:00','Asia/Kolkata')).toBe('2026-11-15T01:30:00.000Z');
  });
  it('rejects nonexistent and repeated clock-change times instead of silently shifting a deadline', () => {
    expect(()=>zonedDateTimeToIso('2026-03-08T02:30','America/Chicago')).toThrow('does not exist');
    expect(()=>zonedDateTimeToIso('2026-11-01T01:30','America/Chicago')).toThrow('occurs twice');
  });
  it('preserves valid times on either side of a clock transition', () => {
    expect(zonedDateTimeToIso('2026-11-01T00:30','America/Chicago')).toBe('2026-11-01T05:30:00.000Z');
    expect(zonedDateTimeToIso('2026-11-01T02:30','America/Chicago')).toBe('2026-11-01T08:30:00.000Z');
  });
});
