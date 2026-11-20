import { GOOGLE_CALENDAR_READ_SCOPE, NativeGoogleError, NativeGoogleEventSchema, type NativeGoogleEvent } from '../../../../packages/contracts/src/native-google';

export interface GoogleTokenResult { accessToken: string; refreshToken?: string; expiresIn: number; scopes: readonly string[] }
export interface GoogleAccount { subject: string; email: string }
export interface GoogleReadTransport {
  readonly binding: Readonly<{ clientId: string; redirectUri: string }>;
  exchange(code: string, verifier: string, signal: AbortSignal): Promise<GoogleTokenResult>;
  refresh(refreshToken: string, signal: AbortSignal): Promise<GoogleTokenResult>;
  account(accessToken: string, signal: AbortSignal): Promise<GoogleAccount>;
  event(accessToken: string, calendarId: string, eventId: string, signal: AbortSignal): Promise<NativeGoogleEvent>;
}
export function exactGoogleReadScopes(input: unknown): readonly string[] {
  if (typeof input !== 'string' || input.length > 2048) throw new NativeGoogleError('GOOGLE_DENIED');
  const scopes = input.split(' ').filter(Boolean).map(v => v === 'https://www.googleapis.com/auth/userinfo.email' ? 'email' : v);
  if (scopes.length !== 3 || new Set(scopes).size !== 3 || !['openid','email',GOOGLE_CALENDAR_READ_SCOPE].every(v => scopes.includes(v))) throw new NativeGoogleError('GOOGLE_DENIED');
  return ['openid','email',GOOGLE_CALENDAR_READ_SCOPE];
}
const object = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new NativeGoogleError('GOOGLE_UNAVAILABLE'); return v as Record<string,unknown>;
};
const token = (v: unknown): string => {
  if (typeof v !== 'string' || v.length < 1 || v.length > 8192 || !/^[\x21-\x7e]+$/.test(v)) throw new NativeGoogleError('GOOGLE_UNAVAILABLE'); return v;
};
export class FixedGoogleReadTransport implements GoogleReadTransport {
  readonly binding: Readonly<{ clientId: string; redirectUri: string }>;
  constructor(private readonly config: { clientId: string; clientSecret: string; redirectUri: string }, private readonly fetcher: typeof fetch = fetch) {
    if (!config.clientId || !config.clientSecret || !config.redirectUri) throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');
    this.config = Object.freeze({ ...config });
    this.binding = Object.freeze({ clientId: config.clientId, redirectUri: config.redirectUri });
  }
  private async request(url: string, init: RequestInit, outer: AbortSignal): Promise<unknown> {
    const signal = AbortSignal.any([outer, AbortSignal.timeout(8000)]);
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      response = await this.fetcher(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', signal });
      if (!response.ok || response.redirected || (response.url && response.url !== url) || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new NativeGoogleError('GOOGLE_UNAVAILABLE');
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > 262144)) throw new NativeGoogleError('GOOGLE_UNAVAILABLE');
      const reader = response.body?.getReader(); if (!reader) throw new NativeGoogleError('GOOGLE_UNAVAILABLE');
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const value = await reader.read(); if (value.done) break;
          length += value.value.byteLength; if (length > 262144) throw new NativeGoogleError('GOOGLE_UNAVAILABLE'); chunks.push(value.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      signal.throwIfAborted(); return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      if (error instanceof NativeGoogleError) throw error;
      throw new NativeGoogleError('GOOGLE_UNAVAILABLE');
    }
  }
  private async tokens(parameters: Record<string,string>, signal: AbortSignal): Promise<GoogleTokenResult> {
    const data = object(await this.request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ ...parameters, client_id: this.config.clientId, client_secret: this.config.clientSecret }).toString() }, signal));
    if (data.token_type !== 'Bearer' || typeof data.expires_in !== 'number' || !Number.isInteger(data.expires_in) || data.expires_in < 60 || data.expires_in > 86400) throw new NativeGoogleError('GOOGLE_DENIED');
    return { accessToken: token(data.access_token), ...(data.refresh_token === undefined ? {} : { refreshToken: token(data.refresh_token) }), expiresIn: data.expires_in, scopes: exactGoogleReadScopes(data.scope) };
  }
  exchange(code: string, verifier: string, signal: AbortSignal) {
    return this.tokens({ grant_type: 'authorization_code', code: token(code), code_verifier: token(verifier), redirect_uri: this.config.redirectUri }, signal);
  }
  refresh(refreshToken: string, signal: AbortSignal) { return this.tokens({ grant_type: 'refresh_token', refresh_token: token(refreshToken) }, signal); }
  async account(accessToken: string, signal: AbortSignal): Promise<GoogleAccount> {
    const data = object(await this.request('https://openidconnect.googleapis.com/v1/userinfo', { method: 'GET', headers: { authorization: `Bearer ${token(accessToken)}`, accept: 'application/json' } }, signal));
    if (typeof data.sub !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.sub) || typeof data.email !== 'string' || data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || data.email_verified !== true) throw new NativeGoogleError('GOOGLE_DENIED');
    return { subject: data.sub, email: data.email.toLowerCase() };
  }
  async event(accessToken: string, calendarId: string, eventId: string, signal: AbortSignal): Promise<NativeGoogleEvent> {
    for (const value of [calendarId, eventId]) if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\s\u0000-\u001f\u007f]/.test(value) || value === '.' || value === '..') throw new NativeGoogleError('GOOGLE_DENIED');
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?fields=kind%2Cid%2Cetag%2Cstatus%2Cupdated%2Csummary%2Cdescription%2Clocation%2Cstart%2Cend`;
    const parsed = NativeGoogleEventSchema.safeParse(await this.request(url, { method: 'GET', headers: { authorization: `Bearer ${token(accessToken)}`, accept: 'application/json' } }, signal));
    if (!parsed.success || parsed.data.id !== eventId) throw new NativeGoogleError('GOOGLE_DENIED');
    return parsed.data;
  }
}
