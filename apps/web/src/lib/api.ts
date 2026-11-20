import { z } from 'zod';
import { ApiErrorSchema } from '@pactwoven/contracts';
import { getApiBase } from './config';
export class RequestError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 0, public readonly correlationId?: string, public readonly fields?: Record<string, string[]>) { super(message); this.name = 'RequestError'; }
}
export type TokenSource = () => Promise<string | null>;
export type ApiRequestOptions = { signal?: AbortSignal; body?: unknown; idempotencyKey?: string; beforeDispatch?: () => undefined };
export function apiRequest<T>(path: string, schema: z.ZodType<T>, getToken: TokenSource, options: ApiRequestOptions = {}): Promise<T> {
  return requestApiAtBase(getApiBase(), path, schema, getToken, options);
}
// Shared authenticated transport. Callers choose only a validated configured base.
export async function requestApiAtBase<T>(base: string | null, path: string, schema: z.ZodType<T>, getToken: TokenSource, options: ApiRequestOptions = {}): Promise<T> {
  if (!base) throw new RequestError('API_NOT_CONFIGURED', 'The workspace service is not connected yet.');
  if (!path.startsWith('/v1/')) throw new RequestError('INVALID_PATH', 'This request is not supported.');
  options.signal?.throwIfAborted();
  const token = await getToken();
  options.signal?.throwIfAborted();
  if (!token) throw new RequestError('SESSION_REQUIRED', 'Sign in again to continue.', 401);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-Correlation-Id': crypto.randomUUID() };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const url = `${base}${path}`;
  const init: RequestInit = { method: options.body === undefined ? 'GET' : 'POST', headers, cache: 'no-store', credentials: 'omit', ...(options.signal ? { signal: options.signal } : {}), ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) };
  // No async handoff remains between this current-state check and transport.
  // A rejected local check is not a lost network response.
  options.beforeDispatch?.();
  options.signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new RequestError('NETWORK_UNAVAILABLE', options.body === undefined ? 'The workspace could not be reached. Try again when your connection returns.' : 'The response could not be confirmed. Keep this draft and request reference; do not create a second request.');
  }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(value);
    if (parsed.success) { const e = parsed.data.error; throw new RequestError(e.code, e.message, response.status, e.correlationId, e.fields); }
    throw new RequestError('REQUEST_FAILED', response.status === 401 ? 'Your session is no longer valid. Sign in again.' : response.status === 403 ? 'Your current organization access does not permit this action.' : 'The workspace could not complete this request.', response.status);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RequestError('RESPONSE_UNVERIFIED', 'The service returned an unrecognized record. No outcome has been assumed.');
  return parsed.data;
}
