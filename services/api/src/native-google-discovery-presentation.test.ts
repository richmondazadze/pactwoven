import { describe, expect, it } from 'vitest';
import { googleDisplayText, googleEventLinkTarget, googleNamedEvent } from './native-google-discovery-presentation';
const email = 'richverseecotech@gmail.com', eventId = 'event_123', encoded = Buffer.from(eventId + ' ' + email).toString('base64url');
describe('primary Calendar event presentation boundary', () => {
  it.each([`https://calendar.google.com/calendar/event?eid=${encoded}`, `https://calendar.google.com/calendar/render?action=VIEW&eid=${encoded}`, `https://calendar.google.com/calendar/u/0/r/eventedit/${encoded}`])('normalizes a specific primary event link without following it', url => expect(googleEventLinkTarget(url, email)).toEqual({ calendarId: 'primary', eventId }));
  it.each([
    'https://calendar.google.com', `https://calendar.google.com.attacker.test/calendar/event?eid=${encoded}`, `http://calendar.google.com/calendar/event?eid=${encoded}`,
    `https://user:secret@calendar.google.com/calendar/event?eid=${encoded}`, `https://calendar.google.com/calendar/event?eid=${encoded}&eid=${encoded}`,
    `https://calendar.google.com/calendar/event?eid=${encoded}&redirect=https://other.test`, `https://calendar.google.com/calendar/event?eid=${encoded}#fragment`,
    `https://calendar.google.com/calendar/event?eid=${Buffer.from(eventId + ' shared@group.calendar.google.com').toString('base64url')}`,
    `https://calendar.google.com/calendar/event?eid=${Buffer.from('../other ' + email).toString('base64url')}`,
    'https://calendar.google.com/calendar/event?eid=malformed',
  ])('rejects ambiguous, foreign or shared targets', url => expect(() => googleEventLinkTarget(url, email)).toThrow());
  it.each(['Bearer secret', 'access_token=private', 'client_secret=private', 'https://provider.test/?code=private', 'abcdef12-abcd-abcd-abcd-abcdef123456', 'a'.repeat(43), 'bad\nname', 'bad\u202ename', 'eyJheader.payload.signature'])('rejects unsafe display material', name => expect(() => googleDisplayText(name)).toThrow());
  it('preserves meaningful text and exact timed event facts', () => {
    expect(googleDisplayText(' North studio delivery ')).toBe('North studio delivery');
    const event = { kind: 'calendar#event', id: eventId, etag: '"v2"', status: 'confirmed', updated: '2026-11-18T18:00:00Z', summary: 'North studio delivery', start: { dateTime: '2026-11-19T12:00:00-06:00' }, end: { dateTime: '2026-11-19T13:00:00-06:00' } };
    expect(googleNamedEvent(event, eventId, Date.parse('2026-11-18T18:01:00Z'))).toEqual(event);
    for (const change of [{ status: 'cancelled' }, { id: 'other_event' }, { start: { date: '2026-11-19' } }, { summary: eventId }, { end: event.start }, { updated: '2026-11-20T18:00:00Z' }]) expect(() => googleNamedEvent({ ...event, ...change }, eventId, Date.parse('2026-11-18T18:01:00Z'))).toThrow();
  });
});
