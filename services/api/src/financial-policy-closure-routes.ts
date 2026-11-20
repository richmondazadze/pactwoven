import type { Hono } from 'hono';
import { ApiErrorSchema, FINANCIAL_POLICY_ORIGINAL_CLOSURE_MAX_BYTES, financialPolicyOriginalClosureRoute } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';
import type { FinancialPolicyClosureGateway } from './financial-policy-closure-service.js';
import { readFinancialPolicyWriteJson } from './financial-policy-write-routes.js';
import { safeFinancialPolicyWriteApiError } from './financial-policy-write-service.js';
import { snapshotFinancialPolicyClosureRequest, validateFinancialPolicyClosureResponse } from './financial-worker-closure-result.js';

const canonical = /^\/v1\/(?:financial-governance\/operations\/[A-Za-z0-9_-]+|responsibilities\/[A-Za-z0-9_-]+\/financial-policy-operations\/[A-Za-z0-9_-]+)\/close$/;
const invalid = () => new DomainError('FINANCIAL_POLICY_INPUT_INVALID', 422, 'Use the exact original closure route and body.');
function family(url: URL) {
  let path = url.pathname;
  for (;;) {
    if (/\/(?:financial-policy-operations|financial-governance\/operations)\//.test(path) && /\/close(?:\/|$)/.test(path)) return true;
    const decoded = path.replace(/%(?:25)+/gi, '%').replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded === path) return false; path = decoded;
  }
}
/** Capture exact body/route/key before token verification; reject aliases without provider work. */
export function registerFinancialPolicyClosureRoutes(app: Hono<ApiEnv>, gateway: FinancialPolicyClosureGateway | undefined): void {
  const close = gateway?.close.bind(gateway);
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url); if (!family(url)) return next();
    c.header('Cache-Control', 'private, no-store'); c.header('Referrer-Policy', 'no-referrer');
    try {
      if (!canonical.test(url.pathname) || url.pathname.includes('%') || url.href.includes('?') || url.href.includes('#')) throw invalid();
      if (c.req.method !== 'POST') throw new DomainError('NOT_FOUND', 404, 'Resource not found.');
      const authorization = c.req.header('Authorization'), key = c.req.header('Idempotency-Key');
      const input = snapshotFinancialPolicyClosureRequest(await readFinancialPolicyWriteJson(c.req.raw, FINANCIAL_POLICY_ORIGINAL_CLOSURE_MAX_BYTES));
      if (url.pathname !== financialPolicyOriginalClosureRoute(input.locator) || key !== input.locator.key) throw invalid();
      if (!close) throw new DomainError('SETUP_REQUIRED', 503, 'Original request closure is not configured.');
      const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(authorization ?? '')?.[1];
      if (!token) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again.');
      const raw = await close(token, structuredClone(input));
      return c.json(await validateFinancialPolicyClosureResponse(input, raw), 200);
    } catch (error) {
      const safe = safeFinancialPolicyWriteApiError(error), candidate = c.get('correlationId');
      const correlationId = typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID();
      return c.json(ApiErrorSchema.parse({ error: { code: safe.code, message: safe.message, correlationId } }), safe.status);
    }
  });
}
