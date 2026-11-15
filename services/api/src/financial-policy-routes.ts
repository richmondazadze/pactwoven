import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { ApiErrorSchema, IdSchema, HashSchema, IdempotencyKeySchema, FinancialPolicyVersionSchema,
  FinancialPolicyHttpKindSchema, FinancialPolicyHttpContextSchema, FinancialPolicyHttpRecordResponseSchema,
  FinancialPolicyHttpDraftIndexResponseSchema, FinancialPolicyHttpGovernanceIndexResponseSchema,
  FinancialPolicyHttpRecoveryLocatorSchema, FinancialPolicyHttpRecoveryResponseSchema } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';
import { safeFinancialPolicyApiError, validateFinancialPolicyWire, type FinancialPolicyGateway } from './financial-policy-service.js';

// A bounded default keeps index payloads predictable; clients may request 1–50 records.
export const FINANCIAL_POLICY_INDEX_DEFAULT_LIMIT = 20;
const unverified = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'The financial-policy response could not be verified.');
const invalid = () => new DomainError('FINANCIAL_POLICY_INPUT_INVALID', 422, 'Use the exact supported policy read parameters.');
function input<T>(schema: z.ZodType<T>, raw: unknown): T { const parsed = schema.safeParse(raw); if (!parsed.success) throw invalid(); return parsed.data; }
const bearer = (value: string | undefined) => {
  const match = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(value ?? '');
  if (!match) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again.'); return match[1]!;
};
function parameters(url: URL, allowed: string[], required: string[] = []): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  // The supported selectors need no escaping. Encoded names/values and empty aliases are rejected.
  if (url.search && (!/^\?[A-Za-z0-9_=&-]+$/.test(url.search) || url.search.slice(1).split('&').some(part => !/^[A-Za-z][A-Za-z0-9]*=[A-Za-z0-9_-]+$/.test(part)))) throw invalid();
  for (const [key, value] of url.searchParams) { if (!allowed.includes(key) || Object.hasOwn(result, key)) throw invalid(); result[key] = value; }
  if (required.some(key => !Object.hasOwn(result, key))) throw invalid(); return result;
}
function integer(value: string, maximum: number) {
  if (!/^[1-9][0-9]*$/.test(value)) throw invalid();
  const number = Number(value); if (!Number.isSafeInteger(number) || number > maximum) throw invalid(); return number;
}
const patterns = [
  '/v1/responsibilities/:id/financial-policies/context',
  '/v1/responsibilities/:id/financial-policies',
  '/v1/financial-governance/context',
  '/v1/financial-governance',
  '/v1/financial-governance/documents/:documentId/versions/:version',
  '/v1/financial-governance/operations/:key',
  '/v1/responsibilities/:id/financial-policy-documents/:documentId/versions/:version',
  '/v1/responsibilities/:id/financial-policy-operations/:key',
  '/v1/responsibilities/:id/financial-policies/:policyId/versions/:version',
  '/v1/financial-governance/:proposalId/versions/:version',
] as const;
const canonicalPaths = patterns.map(path => new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[A-Za-z0-9_-]+')}$`));
function family(url: URL) {
  let path = url.pathname; try { path = decodeURIComponent(path); } catch { /* malformed encoding is rejected if it names this family */ }
  return /^\/v1\//.test(path) && /\/(?:financial-policies|financial-policy-documents|financial-policy-operations|financial-governance)(?:\/|$)/.test(path);
}
function headers(c: Context<ApiEnv>) { c.header('Cache-Control', 'private, no-store'); c.header('Referrer-Policy', 'no-referrer'); }
function failure(c: Context<ApiEnv>, error: unknown) {
  headers(c); const safe = safeFinancialPolicyApiError(error);
  const candidate = c.get('correlationId'), correlationId = typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID();
  return c.json(validateFinancialPolicyWire(ApiErrorSchema, { error: { code: safe.code, message: safe.message, correlationId } }), safe.status);
}

/** Register before generic identity middleware: these handlers capture selectors before any provider await. */
export function registerFinancialPolicyRoutes(app: Hono<ApiEnv>, gateway: FinancialPolicyGateway | undefined): void {
  const captured = gateway && { context: gateway.context.bind(gateway), index: gateway.index.bind(gateway),
    get: gateway.get.bind(gateway), recover: gateway.recover.bind(gateway) };
  const service = () => { if (!captured) throw new DomainError('SETUP_REQUIRED', 503, 'Financial-policy reads are not configured.'); return captured; };
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url); if (!family(url)) return next(); headers(c);
    try {
      if (url.hash || url.href.endsWith('?') || url.pathname.includes('%') || !canonicalPaths.some(pattern => pattern.test(url.pathname))) throw invalid();
      if (c.req.method !== 'GET') throw new DomainError('NOT_FOUND', 404, 'Resource not found.');
      if (c.req.raw.body !== null || c.req.header('Transfer-Encoding') !== undefined || ![undefined, '0'].includes(c.req.header('Content-Length'))) throw invalid();
      await next();
    } catch (error) { return failure(c, error); }
  });
  const run = (work: (c: Context<ApiEnv>, url: URL) => Promise<Response>) => async (c: Context<ApiEnv>) => {
    headers(c); try { return await work(c, new URL(c.req.url)); } catch (error) { return failure(c, error); }
  };
  const responsibility = (c: Context<ApiEnv>) => c.req.param('id') === undefined ? null : input(IdSchema, c.req.param('id'));
  const context = run(async (c, url) => {
    const rid = responsibility(c), q = parameters(url, ['assetKey']), assetKey = q.assetKey === undefined ? null : input(HashSchema, q.assetKey);
    const s = service(), token = bearer(c.req.header('Authorization'));
    const result = validateFinancialPolicyWire(FinancialPolicyHttpContextSchema, await s.context(token, rid, assetKey));
    if (result.responsibilityId !== rid || result.asset !== null && result.asset.pin.key !== assetKey) throw unverified();
    return c.json(result);
  });
  const index = run(async (c, url) => {
    const rid = responsibility(c), q = parameters(url, ['afterId', 'limit']);
    const query = { afterId: q.afterId === undefined ? null : input(IdSchema, q.afterId),
      limit: q.limit === undefined ? FINANCIAL_POLICY_INDEX_DEFAULT_LIMIT : integer(q.limit, 50) };
    const s = service(), token = bearer(c.req.header('Authorization')), raw = await s.index(token, rid, { ...query });
    const result = rid === null ? validateFinancialPolicyWire(FinancialPolicyHttpGovernanceIndexResponseSchema, raw) :
      validateFinancialPolicyWire(FinancialPolicyHttpDraftIndexResponseSchema, raw);
    if (result.responsibilityId !== rid || result.items.length > query.limit ||
      result.items.some(item => query.afterId !== null && item.policy.record.id <= query.afterId) ||
      result.nextId !== null && result.items.length !== query.limit) throw unverified();
    return c.json(result);
  });
  const get = (kind: 'document' | 'draft' | 'governance', idParameter: string) => run(async (c, url) => {
    parameters(url, []); const rid = responsibility(c), id = input(IdSchema, c.req.param(idParameter));
    const version = input(FinancialPolicyVersionSchema, integer(c.req.param('version') ?? '', Number.MAX_SAFE_INTEGER));
    const s = service(), token = bearer(c.req.header('Authorization'));
    const result = validateFinancialPolicyWire(FinancialPolicyHttpRecordResponseSchema, await s.get(token, { responsibilityId: rid, id, version, kind }));
    if (result.responsibilityId !== rid || result.policy.record.kind !== kind || result.policy.reference.id !== id || result.policy.reference.version !== version) throw unverified();
    return c.json(result);
  });
  const recover = run(async (c, url) => {
    const rid = responsibility(c), q = parameters(url, ['kind', 'targetId', 'requestHash'], ['kind', 'targetId', 'requestHash']);
    const locator = input(FinancialPolicyHttpRecoveryLocatorSchema, { responsibilityId: rid, key: input(IdempotencyKeySchema, c.req.param('key')),
      kind: input(FinancialPolicyHttpKindSchema, q.kind), targetId: input(IdSchema, q.targetId), publicRequestHash: input(HashSchema, q.requestHash) });
    const s = service(), token = bearer(c.req.header('Authorization'));
    const result = validateFinancialPolicyWire(FinancialPolicyHttpRecoveryResponseSchema, await s.recover(token, { ...locator }));
    if (result.responsibilityId !== rid || result.key !== locator.key || result.kind !== locator.kind || result.targetId !== locator.targetId || result.publicRequestHash !== locator.publicRequestHash) throw unverified();
    return c.json(result);
  });
  app.all(patterns[0], context); app.all(patterns[1], index);
  app.all(patterns[2], context); app.all(patterns[3], index);
  app.all(patterns[4], get('document', 'documentId')); app.all(patterns[5], recover);
  app.all(patterns[6], get('document', 'documentId')); app.all(patterns[7], recover);
  app.all(patterns[8], get('draft', 'policyId')); app.all(patterns[9], get('governance', 'proposalId'));
}
