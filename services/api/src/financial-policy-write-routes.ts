import type { Context, Hono, Next } from 'hono';
import { z } from 'zod';
import { ApiErrorSchema, IdSchema, IdempotencyKeySchema, financialPolicyHttpRoute, FinancialPolicyHttpMutationResponseSchema,
  FinancialPolicyResponsibilityDocumentHttpSchema, FinancialPolicyGovernanceDocumentHttpSchema, FinancialPolicyDraftHttpSchema,
  FinancialPolicyWithdrawHttpSchema, FinancialPolicyGovernanceHttpSchema, type FinancialPolicyHttpMutationResponse } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';
import { validateFinancialPolicyWire } from './financial-policy-service.js';
import { snapshotFinancialPolicyWriteRequest, validateFinancialPolicyWriteResponse, safeFinancialPolicyWriteApiError,
  financialPolicyWriteOutcomeUnknown, type FinancialPolicyWriteGateway, type FinancialPolicyWriteKind } from './financial-policy-write-service.js';

export const financialPolicyWriteBodyLimits = Object.freeze({ document: 256 * 1024, draft: 32 * 1024, governance: 32 * 1024, withdraw: 8 * 1024 });
const bodyDeadlineMs = 5_000;
const invalid = () => new DomainError('FINANCIAL_POLICY_INPUT_INVALID', 422, 'Use the exact supported policy write parameters.');
const timeout = () => new DomainError('REQUEST_TIMEOUT', 408, 'The policy request body did not arrive in time.');
function parsed<T>(schema: z.ZodType<T>, raw: unknown): T { const value = schema.safeParse(raw); if (!value.success) throw invalid(); return value.data; }

/** Walk JSON syntax before JSON.parse can discard duplicate decoded property names. */
function strictObject(text: string): object {
  let at = 0, values = 0;
  const whitespace = () => { while (at < text.length && /[\u0020\t\r\n]/.test(text[at]!)) at++; };
  function string(): string {
    const start = at; if (text[at++] !== '"') throw invalid(); let escaped = false;
    while (at < text.length) {
      const character = text[at++]!;
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') { try { return JSON.parse(text.slice(start, at)) as string; } catch { throw invalid(); } }
    }
    throw invalid();
  }
  function value(depth: number): void {
    if (depth > 12 || ++values > 1_024) throw invalid(); whitespace(); const character = text[at];
    if (character === '{') {
      at++; whitespace(); const keys = new Set<string>(); if (text[at] === '}') { at++; return; }
      for (;;) {
        whitespace(); const key = string();
        if (key.length > 128 || keys.size >= 32 || keys.has(key)) throw invalid(); keys.add(key);
        whitespace(); if (text[at++] !== ':') throw invalid(); value(depth + 1); whitespace();
        if (text[at] === '}') { at++; return; } if (text[at++] !== ',') throw invalid();
      }
    }
    if (character === '[') {
      at++; whitespace(); let count = 0; if (text[at] === ']') { at++; return; }
      for (;;) {
        if (++count > 100) throw invalid(); value(depth + 1); whitespace();
        if (text[at] === ']') { at++; return; } if (text[at++] !== ',') throw invalid();
      }
    }
    if (character === '"') { string(); return; }
    for (const literal of ['true', 'false', 'null']) if (text.startsWith(literal, at)) { at += literal.length; return; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
    if (!number || !Number.isFinite(Number(number[0]))) throw invalid(); at += number[0].length;
  }
  value(0); whitespace(); if (at !== text.length) throw invalid();
  let input: unknown; try { input = JSON.parse(text); } catch { throw invalid(); }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid(); return input;
}

/** Route-specific bounded streaming only; this parser neither authenticates nor accepts a pre-parsed object. */
export async function readFinancialPolicyWriteJson(request: Request, maximumBytes: number): Promise<unknown> {
  if (!(Object.values(financialPolicyWriteBodyLimits) as number[]).includes(maximumBytes) || request.bodyUsed || request.body?.locked)
    throw new DomainError('SETUP_REQUIRED', 503, 'Financial-policy writes are not configured.');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get('content-type') ?? '') ||
    !['', 'identity'].includes((request.headers.get('content-encoding') ?? '').trim().toLowerCase()))
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 415, 'Send uncompressed UTF-8 JSON.');
  const length = request.headers.get('content-length'), transfer = request.headers.get('transfer-encoding');
  if (transfer !== null && (transfer.trim().toLowerCase() !== 'chunked' || length !== null)) throw invalid();
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw invalid();
  if (length !== null && Number(length) > maximumBytes) throw new DomainError('BODY_TOO_LARGE', 413, 'The policy request exceeds its size limit.');
  if (request.signal.aborted) throw timeout();
  const reader = request.body?.getReader(); if (!reader) throw invalid();
  let bytes = 0, text = '', timer: ReturnType<typeof setTimeout> | undefined;
  const decoder = new TextDecoder('utf-8', { fatal: true }), startedAt = Date.now();
  let abort: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeout()), bodyDeadlineMs); abort = () => reject(timeout());
    request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort();
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw invalid(); bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new DomainError('BODY_TOO_LARGE', 413, 'The policy request exceeds its size limit.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    if (length !== null && Number(length) !== bytes) throw invalid();
    const input = strictObject(text);
    if (request.signal.aborted || Date.now() - startedAt >= bodyDeadlineMs) throw timeout();
    return input;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof DomainError) throw error; throw invalid();
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

function headers(c: Context<ApiEnv>) { c.header('Cache-Control', 'private, no-store'); c.header('Referrer-Policy', 'no-referrer'); }
function failure(c: Context<ApiEnv>, error: unknown) {
  headers(c); const safe = safeFinancialPolicyWriteApiError(error), candidate = c.get('correlationId');
  const correlationId = typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID();
  return c.json(validateFinancialPolicyWire(ApiErrorSchema, { error: { code: safe.code, message: safe.message, correlationId } }), safe.status);
}
function current(response: FinancialPolicyHttpMutationResponse) {
  const now = Date.now();
  if (Date.parse(response.observation.observedAt) > now || Date.parse(response.observation.expiresAt) <= now) throw financialPolicyWriteOutcomeUnknown();
}

/** Mount before financial-policy read routes; only the five exact writer endpoints consume a body. */
export function registerFinancialPolicyWriteRoutes(app: Hono<ApiEnv>, gateway: FinancialPolicyWriteGateway | undefined): void {
  const submit = gateway?.submit.bind(gateway);
  const handler = (kind: FinancialPolicyWriteKind, idParameter: string, maximum: number, schema: z.ZodType, organization: boolean) =>
    async (c: Context<ApiEnv>, next: Next) => {
      const url = new URL(c.req.url), target = c.req.param(idParameter);
      // These literal reader paths retain their original handler/method/error behavior.
      if (kind === 'propose_governance' && ['context', 'documents', 'operations'].includes(target ?? '') && url.pathname === `/v1/financial-governance/${target}` ||
        kind === 'save_draft' && target === 'context' && url.pathname === `/v1/responsibilities/${c.req.param('id')}/financial-policies/context` && !url.pathname.includes('%')) return next();
      headers(c);
      try {
        const responsibilityId = organization ? null : parsed(IdSchema, c.req.param('id')), id = parsed(IdSchema, target);
        const identity = { kind, responsibilityId, id };
        let route: string; try { route = financialPolicyHttpRoute(identity); } catch { throw invalid(); }
        if (url.pathname !== route || url.pathname.includes('%') || url.search || url.hash || url.href.endsWith('?')) throw invalid();
        if (c.req.method !== 'POST') throw new DomainError('NOT_FOUND', 404, 'Resource not found.');
        const key = parsed(IdempotencyKeySchema, c.req.header('Idempotency-Key')), authorization = c.req.header('Authorization');
        const input = parsed(schema, await readFinancialPolicyWriteJson(c.req.raw, maximum));
        const request = snapshotFinancialPolicyWriteRequest({ ...identity, route, key, input });
        const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(authorization ?? '')?.[1];
        if (!submit) throw new DomainError('SETUP_REQUIRED', 503, 'Financial-policy writes are not configured.');
        if (!token) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again.');
        const raw = await submit(token, structuredClone(request));
        // A returned result may already be durable; typed validation failures are no longer input errors.
        try {
          const wire = validateFinancialPolicyWire(FinancialPolicyHttpMutationResponseSchema, raw); current(wire);
          const response = await validateFinancialPolicyWriteResponse(request, wire); current(response);
          return c.json(response, 200);
        } catch { throw financialPolicyWriteOutcomeUnknown(); }
      } catch (error) { return failure(c, error); }
    };
  app.all('/v1/financial-governance/documents/:documentId', handler('save_document', 'documentId', financialPolicyWriteBodyLimits.document, FinancialPolicyGovernanceDocumentHttpSchema, true));
  app.all('/v1/responsibilities/:id/financial-policy-documents/:documentId', handler('save_document', 'documentId', financialPolicyWriteBodyLimits.document, FinancialPolicyResponsibilityDocumentHttpSchema, false));
  app.all('/v1/responsibilities/:id/financial-policies/:draftId/withdraw', handler('withdraw_draft', 'draftId', financialPolicyWriteBodyLimits.withdraw, FinancialPolicyWithdrawHttpSchema, false));
  app.all('/v1/responsibilities/:id/financial-policies/:draftId', handler('save_draft', 'draftId', financialPolicyWriteBodyLimits.draft, FinancialPolicyDraftHttpSchema, false));
  app.all('/v1/financial-governance/:proposalId', handler('propose_governance', 'proposalId', financialPolicyWriteBodyLimits.governance, FinancialPolicyGovernanceHttpSchema, true));
}
