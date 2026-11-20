import { NativeGoogleError, NativeGoogleTokensSchema, type NativeGoogleConnection } from '../../../../packages/contracts/src/native-google';
import { GoogleDiscoveryEventSchema, type GoogleDiscoveryEvent, type GoogleDiscoveryLease } from '../../../../packages/contracts/src/native-google-discovery';
import { GoogleCredentialVault } from './vault';
import { exactGoogleReadScopes, type GoogleReadTransport } from './transport';

export interface GoogleDiscoveryPrivateStore {
  claim(id: string, operationId: string): Promise<GoogleDiscoveryLease>;
  reserveRefresh(id: string, operationId: string): Promise<NativeGoogleConnection>;
  completeRefresh(id: string, operationId: string, connection: NativeGoogleConnection): Promise<GoogleDiscoveryLease>;
  fail(id: string, operationId: string): Promise<true>;
}
/** Minimal fixed-provider event projection. No arbitrary URL, attendees,
 * description/location collection, redirects, retries or browser credentials. */
export class FixedGoogleDiscoveryEventTransport {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async read(accessToken: string, eventId: string, outer: AbortSignal): Promise<GoogleDiscoveryEvent> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId) || !/^[\x21-\x7e]{1,8192}$/.test(accessToken)) throw new NativeGoogleError('GOOGLE_DENIED');
    const signal = AbortSignal.any([outer, AbortSignal.timeout(8000)]);
    const fields = 'kind,id,etag,status,updated,summary,start(dateTime),end(dateTime)';
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?fields=${encodeURIComponent(fields)}`;
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      response = await this.fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      if (!response.ok || response.redirected || response.url && response.url !== url || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw Error();
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > 16384)) throw Error();
      const reader = response.body?.getReader(); if (!reader) throw Error();
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 16384) throw Error(); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      signal.throwIfAborted();
      const event = GoogleDiscoveryEventSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (event.id !== eventId) throw Error();
      return event;
    } catch { await response?.body?.cancel().catch(() => {}); throw new NativeGoogleError('GOOGLE_UNAVAILABLE'); }
  }
}

export class NativeGoogleDiscoveryReader {
  readonly binding: Readonly<{ clientId: string; redirectUri: string; expectedEmail: string }>;
  constructor(config: { clientId: string; redirectUri: string; expectedEmail: string }, private readonly store: GoogleDiscoveryPrivateStore, private readonly vault: GoogleCredentialVault,
    private readonly oauth: Pick<GoogleReadTransport, 'binding' | 'account' | 'refresh'>, private readonly events: Pick<FixedGoogleDiscoveryEventTransport, 'read'>, private readonly now = Date.now) {
    if (!Object.isFrozen(oauth.binding) || oauth.binding.clientId !== config.clientId || oauth.binding.redirectUri !== config.redirectUri || config.expectedEmail !== 'richverseecotech@gmail.com') throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');
    this.binding = Object.freeze({ clientId: config.clientId, redirectUri: config.redirectUri, expectedEmail: config.expectedEmail });
  }
  async read(id: string, operationId: string, outer: AbortSignal): Promise<{ event: GoogleDiscoveryEvent; observedAt: string; session: GoogleDiscoveryLease['session'] }> {
    const signal = AbortSignal.any([outer, AbortSignal.timeout(12000)]);
    let claimed = false;
    try {
      signal.throwIfAborted(); let lease = await this.store.claim(id, operationId); claimed = true;
      const check = () => { signal.throwIfAborted(); if (Date.parse(lease.expiresAt) <= this.now() || lease.connection.clientId !== this.binding.clientId || lease.connection.accountEmail !== this.binding.expectedEmail || lease.target.calendarId !== 'primary' || lease.connection.status !== 'connected') throw new NativeGoogleError('GOOGLE_DENIED'); };
      check(); let tokens = NativeGoogleTokensSchema.parse(this.vault.open(lease.connection.tokens, lease.connection.binding, 'oauth_tokens'));
      if (Date.parse(tokens.expiresAt) <= this.now() + 15000) {
        const reserved = await this.store.reserveRefresh(id, operationId);
        if (reserved.status !== 'refreshing' || JSON.stringify(reserved.binding) !== JSON.stringify(lease.connection.binding)) throw new NativeGoogleError('GOOGLE_CONFLICT');
        signal.throwIfAborted(); const requestedAt = this.now(), result = await this.oauth.refresh(tokens.refreshToken, signal); exactGoogleReadScopes(result.scopes.join(' '));
        if (!Number.isInteger(result.expiresIn) || result.expiresIn < 60 || result.expiresIn > 86400) throw new NativeGoogleError('GOOGLE_DENIED');
        const account = await this.oauth.account(result.accessToken, signal);
        if (account.subject !== lease.connection.accountSubject || account.email !== this.binding.expectedEmail) throw new NativeGoogleError('GOOGLE_DENIED');
        const binding = { ...lease.connection.binding, credentialVersion: lease.connection.binding.credentialVersion + 1 };
        tokens = NativeGoogleTokensSchema.parse({ accessToken: result.accessToken, refreshToken: result.refreshToken ?? tokens.refreshToken, expiresAt: new Date(requestedAt + result.expiresIn * 1000).toISOString() });
        signal.throwIfAborted(); lease = await this.store.completeRefresh(id, operationId, { ...lease.connection, binding, tokens: this.vault.seal(tokens, binding, 'oauth_tokens') });
      } else {
        const account = await this.oauth.account(tokens.accessToken, signal);
        if (account.subject !== lease.connection.accountSubject || account.email !== this.binding.expectedEmail) throw new NativeGoogleError('GOOGLE_DENIED');
      }
      check();
      const event = await this.events.read(tokens.accessToken, lease.target.eventId, signal), observedAt = new Date(this.now()).toISOString();
      check(); return { event, observedAt, session: lease.session };
    } catch (error) {
      if (claimed) await this.store.fail(id, operationId).catch(() => {});
      if (error instanceof NativeGoogleError) throw error;
      throw new NativeGoogleError('GOOGLE_UNAVAILABLE');
    }
  }
}
