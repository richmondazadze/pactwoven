import { googleOAuthConfiguration } from '../../api/src/native-google-service';
import type { ProtectedGoogleKeyring } from '../../connectors/src/google/vault';
import { readNativeApiConfig, readNativeDelegatedApiConfig } from './config';

export const GOOGLE_FOREGROUND_LANES = ['observer', 'api', 'review', 'auth', 'reader'] as const;
export type GoogleForegroundLane = typeof GOOGLE_FOREGROUND_LANES[number];
export class NativeGoogleConfigurationError extends Error {
  constructor() { super('Google Calendar is not configured. Check its protected development bindings.'); }
}
type Values = Record<string, string | undefined>;
function required(value: string | undefined): string {
  if (!value || value.length > 8192 || value.trim() !== value) throw new NativeGoogleConfigurationError();
  return value;
}

/** No provider discovery, token exchange, generated vault key or fallback key.
 * The foreground receives only its five reviewed SQL capabilities. */
export function readNativeGoogleConfig(values: Values) {
  try {
    if (['GOOGLE_WORKER_DATABASE_URL', 'GOOGLE_CONTENT_DATABASE_URL'].some(key => Boolean(values[key]))) throw Error();
    const base = readNativeApiConfig(values), foundation = new URL(base.foundationDatabaseUrl);
    const existing = [base.foundationDatabaseUrl, base.nativeDatabaseUrl];
    if (values.NATIVE_DELEGATION_API_DATABASE_URL) existing.push(readNativeDelegatedApiConfig(values).delegationDatabaseUrl);
    const users = new Set(existing.map(value => decodeURIComponent(new URL(value).username)));
    if (users.size !== existing.length) throw Error();
    const databaseUrls = {} as Record<GoogleForegroundLane, string>;
    for (const lane of GOOGLE_FOREGROUND_LANES) {
      const url = new URL(required(values[`GOOGLE_${lane.toUpperCase()}_DATABASE_URL`]));
      const name = decodeURIComponent(url.username), seen = new Set<string>();
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !name || !url.password || url.hash ||
        url.pathname !== foundation.pathname || url.port !== foundation.port ||
        url.hostname.replace('-pooler.', '.') !== foundation.hostname.replace('-pooler.', '.') || users.has(name)) throw Error();
      for (const [key, value] of url.searchParams) {
        if (seen.has(key) || !['sslmode', 'channel_binding'].includes(key) ||
          (key === 'sslmode' && value !== 'verify-full') || (key === 'channel_binding' && value !== 'require')) throw Error();
        seen.add(key);
      }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.searchParams.get('sslmode') !== 'verify-full') throw Error();
      users.add(name); databaseUrls[lane] = url.href;
    }
    const publicWebOrigin = required(values.GOOGLE_PUBLIC_WEB_ORIGIN);
    if (!base.allowedOrigins.includes(publicWebOrigin)) throw Error();
    const oauth = googleOAuthConfiguration({ publicWebOrigin, clientId: required(values.GOOGLE_OAUTH_CLIENT_ID),
      clientSecret: required(values.GOOGLE_OAUTH_CLIENT_SECRET), expectedEmail: 'richverseecotech@gmail.com' });
    const activeKeyId = required(values.GOOGLE_VAULT_ACTIVE_KEY_ID), input: unknown = JSON.parse(required(values.GOOGLE_VAULT_KEYS));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error();
    const entries = Object.entries(input);
    if (entries.length < 1 || entries.length > 4) throw Error();
    const keys = new Map<string, Uint8Array>();
    for (const [id, encoded] of entries) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw Error();
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.length !== 32 || bytes.toString('base64url') !== encoded) throw Error();
      keys.set(id, new Uint8Array(bytes));
    }
    if (!keys.has(activeKeyId)) throw Error();
    const keyring: ProtectedGoogleKeyring = Object.freeze({ activeKeyId, getKey: (id: string) => keys.get(id)?.slice() });
    return { base, oauth, databaseUrls: Object.freeze(databaseUrls), keyring };
  } catch { throw new NativeGoogleConfigurationError(); }
}
