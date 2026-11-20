/** Exact public Google read/consent entry points. OAuth codes and event targets
 * belong in bounded request bodies, never URL path segments. */
const nativeGooglePaths = new Set([
  '/v1/google/connect', '/v1/google/callback', '/v1/google/recover', '/v1/google/revoke',
  '/v1/google/consent/prepare', '/v1/google/consent/confirm', '/v1/google/consent/recover', '/v1/google/consent/revoke',
  '/v1/google/overview', '/v1/google/event-baseline', '/v1/google/consent/prepare-event',
]);

export function isNativeGoogleHttpRoute(pathname: string, method: string): boolean {
  return (method === 'POST' || method === 'OPTIONS') && nativeGooglePaths.has(pathname);
}
