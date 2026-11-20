import { VercelWorkloadIdentitySchema, createVercelWorkloadVerifier } from '@pactwoven/service-identity';
export type { VercelWorkloadIdentity as NativeNudgeIdentity } from '@pactwoven/service-identity';
export const createNativeNudgeVerifier = createVercelWorkloadVerifier;
export function readNativeNudgeIdentity(values: Record<string, string | undefined>) {
  return VercelWorkloadIdentitySchema.parse({ team: values.NATIVE_API_TEAM_SLUG, teamId: values.NATIVE_API_TEAM_ID,
    project: values.NATIVE_API_PROJECT_NAME, projectId: values.NATIVE_API_PROJECT_ID });
}

function response(status: number): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function emptyBody(request: Request): Promise<boolean> {
  if (request.body === null) return true;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        // Node adapters expose a stream even for a zero-byte POST. Accept its
        // EOF, but never collect caller content or consume unbounded chunks.
        for (let chunks = 0; chunks < 8; chunks++) {
          const value = await reader.read();
          if (value.done) return true;
          if (value.value.byteLength) return false;
        }
        return false;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('Request body did not finish.')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function createNativeExecutionHandler(dependencies: {
  verify: (request: Request) => Promise<boolean>;
  publish: () => Promise<unknown>;
}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET' && !url.search) {
      return Response.json({ service: 'pactwoven-native-execution', status: 'alive' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname !== '/internal/nudge' || url.search) return response(404);
    if (request.method !== 'POST') return response(405);
    // There is no request body protocol to smuggle a target or source URL into.
    if (request.headers.has('content-length') && request.headers.get('content-length') !== '0') return response(400);
    try {
      if (!await dependencies.verify(request)) return response(401);
      if (!await emptyBody(request)) return response(400);
      // Do not debounce away a request that committed after another scan's
      // snapshot. The transactional publication claim fences competing scans.
      await dependencies.publish();
      return response(202);
    } catch { return response(503); }
  };
}
