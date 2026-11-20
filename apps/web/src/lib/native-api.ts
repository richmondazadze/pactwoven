import type { z } from 'zod';
import { requestApiAtBase, RequestError, type ApiRequestOptions, type TokenSource } from './api';
import { getNativeApiBase } from './config';

export function nativeApiRequest<T>(path: string, schema: z.ZodType<T>, getToken: TokenSource, options: ApiRequestOptions = {}): Promise<T> {
  const base = getNativeApiBase();
  if (!/^\/v1\/tasks(?:\?[^#]*|\/[A-Za-z0-9_-]{1,128}(?:\/(?:control|messages|continuation))?)?$/.test(path)) {
    return Promise.reject(new RequestError('INVALID_PATH', 'This work request is not supported.'));
  }
  return requestApiAtBase(base, path, schema, getToken, { ...options, beforeDispatch: () => {
    if (base !== getNativeApiBase()) throw new RequestError('SCOPE_CHANGED', 'The work service changed before this request was sent.');
    options.beforeDispatch?.();
  } });
}
