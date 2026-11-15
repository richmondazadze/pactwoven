import type { Context, Hono } from 'hono';
import { ApiErrorSchema, FINANCIAL_POLICY_PREPARATION_REQUEST_MAX_BYTES } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';
import { readFinancialPolicyWriteJson } from './financial-policy-write-routes.js';
import { snapshotFinancialPolicyPreparationSelection, validateFinancialPolicyPreparationResponse,
  safeFinancialPolicyPreparationApiError, financialPolicyPreparationUnverified,
  type FinancialPolicyPreparationGateway } from './financial-policy-preparation-service.js';

const organizationPath = '/v1/financial-governance-preparation';
const responsibilityPath = '/v1/responsibilities/:id/financial-policy-preparation';
const canonical = /^\/v1\/(?:financial-governance-preparation|responsibilities\/[A-Za-z0-9_-]+\/financial-policy-preparation)$/;
const invalid = () => new DomainError('FINANCIAL_POLICY_INPUT_INVALID', 422, 'Use the exact supported policy preparation parameters.');
function family(url: URL) {
  let path = url.pathname;
  // Recognition only: decoding never makes an alias valid. Catch nested escaped
  // spellings before they can fall through to the generic identity middleware.
  for (;;) {
    if (/\/financial-(?:policy|governance)-preparation/.test(path)) return true;
    // Supported names are ASCII. Tolerant recognition also catches a named
    // family beside malformed escapes; the canonical check still rejects it.
    const decoded = path.replace(/%(?:25)+/gi, '%').replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded === path) return false; path = decoded; // Every iteration strictly shortens the path.
  }
  return false;
}
function headers(c: Context<ApiEnv>) { c.header('Cache-Control', 'private, no-store'); c.header('Referrer-Policy', 'no-referrer'); }
function failure(c: Context<ApiEnv>, error: unknown) {
  headers(c); const safe = safeFinancialPolicyPreparationApiError(error), candidate = c.get('correlationId');
  const correlationId = typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID();
  return c.json(ApiErrorSchema.parse({ error: { code: safe.code, message: safe.message, correlationId } }), safe.status);
}

/** Mount after shared CORS/health and before financial routes and generic identity middleware. */
export function registerFinancialPolicyPreparationRoutes(app: Hono<ApiEnv>, gateway: FinancialPolicyPreparationGateway | undefined): void {
  const prepare = gateway?.prepare.bind(gateway);
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url); if (!family(url)) return next(); headers(c);
    try {
      if (!canonical.test(url.pathname) || url.pathname.includes('%') || url.href.includes('?') || url.href.includes('#')) throw invalid();
      if (c.req.method !== 'POST') throw new DomainError('NOT_FOUND', 404, 'Resource not found.');
      if (c.req.header('Idempotency-Key') !== undefined) throw invalid();
      await next();
    } catch (error) { return failure(c, error); }
  });
  const handler = (organization: boolean) => async (c: Context<ApiEnv>) => {
    headers(c);
    try {
      const responsibilityId = organization ? null : c.req.param('id'), authorization = c.req.header('Authorization');
      const q = snapshotFinancialPolicyPreparationSelection(responsibilityId,
        await readFinancialPolicyWriteJson(c.req.raw, FINANCIAL_POLICY_PREPARATION_REQUEST_MAX_BYTES));
      const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(authorization ?? '')?.[1];
      if (!prepare) throw new DomainError('SETUP_REQUIRED', 503, 'Financial-policy preparation is not configured.');
      if (!token) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again.');
      const raw = await prepare(token, q.responsibilityId, structuredClone(q.selection));
      try {
        const wire = await validateFinancialPolicyPreparationResponse(q.responsibilityId, q.selection, raw);
        const at = Date.now();
        if (Date.parse(wire.observation.observedAt) > at || Date.parse(wire.observation.expiresAt) <= at) throw financialPolicyPreparationUnverified();
        return c.json(wire, 200);
      } catch { throw financialPolicyPreparationUnverified(); }
    } catch (error) { return failure(c, error); }
  };
  app.all(organizationPath, handler(true)); app.all(responsibilityPath, handler(false));
}
