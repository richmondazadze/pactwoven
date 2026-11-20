import { isNativePaidQuoteRoute } from '../../api/src/native-paid-quote-routes';
import { isNativePaidWorkIntentRoute } from '../../api/src/native-paid-work-intent-routes';
import { isNativePaidToolHttpRoute } from '../../api/src/native-paid-tool-routes';
import { isNativeAgentConversationRoute } from '../../api/src/native-agent-conversation-http';
import { isNativeGoogleHttpRoute } from '../../../packages/contracts/src/native-google-http';
import { isNativeWorkTeamActivityHttpRoute } from '../../../packages/contracts/src/native-work-team-activity';
import { isNativeWorkActivityHttpRoute } from '../../../packages/contracts/src/native-work-activity';
import { isNativeVoiceHttpRoute } from '../../../packages/contracts/src/native-voice';

type NativeApp = { fetch(request: Request): Response | Promise<Response> };
type Dependencies = {
  app: () => Promise<NativeApp>;
  memoryApp?: () => Promise<NativeApp>;
  workApp?: () => Promise<NativeApp>;
  paidApp?: () => Promise<NativeApp>;
  googleApp?: () => Promise<NativeApp>;
  nudge: () => Promise<unknown>;
  defer: (work: Promise<unknown>) => void;
  authority?: (request: Request) => Promise<Response>;
  delegatedAuthority?: (request: Request) => Promise<Response>;
};
function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, correlationId: crypto.randomUUID() } },
    { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}
export function createNativeHttpHandler(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === '/internal/native-delegated-authority') {
      return dependencies.delegatedAuthority ? dependencies.delegatedAuthority(request)
        : failure(503, 'DURABLE_SERVICE_UNAVAILABLE', 'Current delegation authority is unavailable.');
    }
    if (path === '/internal/native-authority') {
      return dependencies.authority ? dependencies.authority(request) : failure(503, 'DURABLE_SERVICE_UNAVAILABLE', 'Current task authority is unavailable.');
    }
    if (path === '/health' && request.method === 'GET') {
      return Response.json({ service: 'pactwoven-native-api', status: 'alive' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (isNativeGoogleHttpRoute(path, request.method)) {
      if (!dependencies.googleApp) return failure(503, 'SETUP_REQUIRED', 'Google Calendar access is not connected yet.');
      try { return await (await dependencies.googleApp()).fetch(request); }
      catch { return failure(503, 'DURABLE_SERVICE_UNAVAILABLE', 'The Google connection request has not been confirmed. Recover the original request before retrying.'); }
    }
    if (/^\/v1\/memory(?:\/(?:operations\/)?[A-Za-z0-9_-]+)?$/.test(path)) {
      if (!dependencies.memoryApp) return failure(503, 'SETUP_REQUIRED', 'Saved memory is not connected yet.');
      try { return await (await dependencies.memoryApp()).fetch(request); }
      catch { return failure(503, 'DURABLE_SERVICE_UNAVAILABLE', 'The saved memory request has not been confirmed.'); }
    }
    if (/^\/v1\/agent-work(?:\/(?:[A-Za-z0-9_-]+(?:\/(?:control|controls\/[A-Za-z0-9_-]+))?|operations\/[A-Za-z0-9_-]+))?$/.test(path) || isNativeAgentConversationRoute(path, request.method) || isNativeWorkActivityHttpRoute(path, request.method) || isNativeWorkTeamActivityHttpRoute(path, request.method) || isNativeVoiceHttpRoute(path, request.method) || isNativePaidWorkIntentRoute(path, request.method) || isNativePaidToolHttpRoute(path, request.method) || isNativePaidQuoteRoute(path, request.method)) {
      const selectedApp=(isNativePaidWorkIntentRoute(path,request.method)||isNativePaidToolHttpRoute(path,request.method)||isNativePaidQuoteRoute(path,request.method))&&dependencies.paidApp ? dependencies.paidApp : dependencies.workApp;
      if (!selectedApp) return failure(503, 'SETUP_REQUIRED', 'Background advisory work is not connected yet.');
      let response: Response;
      try { response = await (await selectedApp()).fetch(request); }
      catch { return failure(503, 'DURABLE_SERVICE_UNAVAILABLE', 'This work request has not been confirmed.'); }
      if (request.method === 'POST' && response.ok && (path === '/v1/agent-work/confirm' || path === '/v1/agent-work/paid/confirm' || path.endsWith('/control') || (isNativePaidQuoteRoute(path, request.method) && /\/equipment\/(?:approve|recover)$/.test(path)))) {
        const nudge = Promise.resolve().then(dependencies.nudge).catch(() => {
          console.error('Delegated work wake-up was not confirmed; its saved outbox remains available for recovery.');
        });
        try { dependencies.defer(nudge); } catch { /* Durable committed work remains authoritative. */ }
      }
      return response;
    }
    if (!/^\/v1\/tasks(?:\/[A-Za-z0-9_-]+(?:\/(?:control|messages|continuation))?)?$/.test(path)) {
      return failure(404, 'NOT_FOUND', 'Resource not found.');
    }
    let response: Response;
    try { response = await (await dependencies.app()).fetch(request); }
    catch { return failure(503, 'DURABLE_SERVICE_UNAVAILABLE', 'The work service is temporarily unavailable. Your request has not been confirmed.'); }
    if (request.method === 'POST' && response.ok) {
      // The database has already committed task + dispatch. This is only the
      // low-latency nudge; bounded wake retries run first; the scheduled scan remains the outage fallback.
      const nudge = Promise.resolve().then(dependencies.nudge).catch(() => {
        console.error('Native work wake-up was not confirmed; its saved outbox remains available for recovery.');
      });
      try { dependencies.defer(nudge); } catch { /* The committed request is still authoritative. */ }
    }
    return response;
  };
}
