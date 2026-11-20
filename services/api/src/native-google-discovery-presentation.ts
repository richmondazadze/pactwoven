import { GoogleDiscoveryEventSchema, type GoogleDiscoveryEvent, type GoogleDiscoveryTarget } from '../../../packages/contracts/src/native-google-discovery';
import { NativeGoogleError } from '../../../packages/contracts/src/native-google';

/** A permission label must never substitute infrastructure or credentials for a name. */
export function googleDisplayText(value: unknown, max = 300): string {
  if (typeof value !== 'string') throw new NativeGoogleError('GOOGLE_UNAVAILABLE');
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text) ||
    /bearer\s|access[_-]?token|client[_-]?secret|refresh[_-]?token|-----BEGIN|\bsk-[A-Za-z0-9]|https?:\/\//i.test(text) ||
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(text) ||
    /^[A-Za-z0-9_-]{32,}$/.test(text) || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)) throw new NativeGoogleError('GOOGLE_UNAVAILABLE');
  return text;
}

/** Google event links encode "eventId calendarId". Never fetch the supplied URL. */
export function googleEventLinkTarget(input: string, expectedEmail: string): GoogleDiscoveryTarget {
  try {
    const url = new URL(input);
    if (input.length > 4096 || url.origin !== 'https://calendar.google.com' || url.username || url.password || url.hash) throw Error();
    let encoded: string;
    const route = /^\/calendar(?:\/u\/\d+)?\/r\/eventedit\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (route && !url.search) encoded = route[1]!;
    else {
      if (!/^\/calendar\/(?:event|render)$/.test(url.pathname) || url.searchParams.getAll('eid').length !== 1 ||
        [...url.searchParams.keys()].some(key => !['eid', 'action', 'ctz'].includes(key) || url.searchParams.getAll(key).length !== 1) ||
        url.searchParams.has('action') && url.searchParams.get('action') !== 'VIEW') throw Error();
      encoded = url.searchParams.get('eid')!;
    }
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) throw Error();
    const raw = Buffer.from(encoded.replace(/=+$/, ''), 'base64url');
    if (raw.toString('base64url') !== encoded.replace(/=+$/, '')) throw Error();
    const decoded = raw.toString('utf8');
    if (!Buffer.from(decoded).equals(raw)) throw Error();
    const match = /^([A-Za-z0-9_-]{1,128}) ([^\s]+)$/.exec(decoded);
    if (!match || !['primary', expectedEmail].includes(match[2]!)) throw Error();
    return { calendarId: 'primary', eventId: match[1]! };
  } catch { throw new NativeGoogleError('GOOGLE_DENIED'); }
}

export function googleNamedEvent(input: unknown, eventId: string, observedAt: number): GoogleDiscoveryEvent {
  // Timed, explicitly offset events only. Never guess an all-day timezone.
  const value = GoogleDiscoveryEventSchema.safeParse(input);
  if (!value.success || value.data.id !== eventId || Date.parse(value.data.updated) > observedAt || Date.parse(value.data.end.dateTime) <= Date.parse(value.data.start.dateTime)) throw new NativeGoogleError('GOOGLE_UNAVAILABLE');
  googleDisplayText(value.data.summary);
  if ([value.data.id, value.data.etag].includes(value.data.summary)) throw new NativeGoogleError('GOOGLE_UNAVAILABLE');
  return value.data;
}
