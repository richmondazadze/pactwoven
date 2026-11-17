import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { ApiErrorSchema, IdempotencyKeySchema, supplierScopesMatch, supplierScopePolicyPairsMatch } from '@pactwoven/contracts';
import { DomainError, canonicalJson, commandDigest, immutable, supplierScopeCategoryDigest, supplierScopePolicyCommandDigest } from '@pactwoven/domain';
import {
  SupplierRelationshipHttpRequestSchema, SupplierRelationshipHttpResponseSchema,
  SupplierRelationshipStatusHttpSchema, SupplierRelationshipCommandHttpSchema, SupplierRelationshipRecoveryHttpSchema,
  SupplierScopePolicyReadHttpSchema, SupplierScopePolicyCommandHttpSchema,
  supplierRelationshipHttpRoutes, supplierRelationshipHttpBodyLimits,
  type SupplierRelationshipHttpKind, type SupplierRelationshipHttpRequest, type SupplierRelationshipHttpResponse, type SupplierRelationshipHttpGateway,
} from '../../../packages/contracts/src/supplier-relationship-http.js';
import type { ApiEnv } from './app.js';

const bodyDeadlineMs = 5_000;
const invalid = () => new DomainError('SUPPLIER_INPUT_INVALID', 422, 'Use the exact supported supplier operation parameters.');
const timeout = () => new DomainError('REQUEST_TIMEOUT', 408, 'The supplier request body did not arrive in time.');
const outcomeUnknown = () => new DomainError('SUPPLIER_OUTCOME_UNKNOWN', 503,
  'The supplier result is unconfirmed. Preserve the exact original request and use explicit recovery.');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw invalid(); return result.data;
}

// The same bounded grammar walk used by financial-policy write routes: detect
// decoded duplicate names before JSON.parse can discard one of their values.
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

/** Complete bounded UTF-8 input before any authentication or database await. */
export async function readSupplierRelationshipJson(request: Request, maximumBytes: number): Promise<unknown> {
  if (!(Object.values(supplierRelationshipHttpBodyLimits) as number[]).includes(maximumBytes) || request.bodyUsed || request.body?.locked) {
    throw new DomainError('SETUP_REQUIRED', 503, 'Supplier body limits are not configured.');
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get('content-type') ?? '') ||
    !['', 'identity'].includes((request.headers.get('content-encoding') ?? '').trim().toLowerCase())) {
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 415, 'Send uncompressed UTF-8 JSON.');
  }
  const length = request.headers.get('content-length'), transfer = request.headers.get('transfer-encoding');
  if (transfer !== null && (transfer.trim().toLowerCase() !== 'chunked' || length !== null)) throw invalid();
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw invalid();
  if (length !== null && Number(length) > maximumBytes) throw new DomainError('BODY_TOO_LARGE', 413, 'The supplier request exceeds its size limit.');
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
      if (bytes > maximumBytes) throw new DomainError('BODY_TOO_LARGE', 413, 'The supplier request exceeds its size limit.');
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

/** Correlates a trusted gateway response to the exact captured request. Parsing and hashes do not authenticate its issuer. */
export async function validateSupplierRelationshipHttpResponse(input: SupplierRelationshipHttpRequest, raw: unknown): Promise<SupplierRelationshipHttpResponse> {
  try {
    const request = immutable(SupplierRelationshipHttpRequestSchema.parse(input));
    const response = immutable(SupplierRelationshipHttpResponseSchema.parse(raw));
    if (response.kind !== request.kind) throw outcomeUnknown();
    if (response.kind === 'relationship-status' && request.kind === 'relationship-status') {
      const v = response.projection;
      if (!supplierScopesMatch(v.scope, request.query.scope) ||
        (request.query.revision === null ? !v.current : v.revision !== request.query.revision) ||
        (v.relationshipGate === 'SATISFIED' && Date.parse(v.expiresAt) <= Date.now())) throw outcomeUnknown();
    }
    if (response.kind === 'policy-read' && request.kind === 'policy-read') {
      if (!same(response.policy.reference, request.query.policy) || Date.parse(response.policy.issuedAt) > Date.now()) throw outcomeUnknown();
      for (const { definitionHash, ...category } of response.policy.categories) {
        if (definitionHash !== await supplierScopeCategoryDigest(response.policy.reference.pair, category)) throw outcomeUnknown();
      }
    }
    if (response.kind === 'policy-command' && request.kind === 'policy-command') {
      const receipt = response.receipt;
      if (receipt.identity.idempotencyKey !== request.mutation.idempotencyKey ||
        !supplierScopePolicyPairsMatch(receipt.identity.pair, request.mutation.command.pair) ||
        receipt.result.version !== request.mutation.command.expectedVersion + 1 || Date.parse(receipt.recordedAt) > Date.now() ||
        receipt.commandDigest !== await supplierScopePolicyCommandDigest(request.mutation, receipt.identity.actorId)) throw outcomeUnknown();
    }
    const receipt = response.kind === 'relationship-command' ? response.receipt : response.kind === 'relationship-recover' ? response.original?.receipt : undefined;
    const mutation = request.kind === 'relationship-command' ? request.mutation : response.kind === 'relationship-recover' ? response.original?.mutation : undefined;
    if (receipt && mutation) {
      const command = mutation.command, result = receipt.result, action = command.payload.action;
      const expectedDigest = await commandDigest({ namespace: 'pactwoven/supplier-relationship-command/v1', identity: {
        scope: command.scope, organizationId: receipt.identity.organizationId, actorId: receipt.identity.actorId, idempotencyKey: mutation.idempotencyKey,
      }, command });
      if (!supplierScopesMatch(receipt.identity.scope, command.scope) || receipt.identity.idempotencyKey !== mutation.idempotencyKey ||
        receipt.commandDigest !== expectedDigest || result.revision !== command.expectedVersion + 1 || Date.parse(receipt.recordedAt) > Date.now() ||
        (action === 'create' ? result.proposal.version !== 1 : action === 'revise' ? result.proposal.version !== command.targetProposal!.version + 1 : !same(result.proposal, command.targetProposal)) ||
        (action === 'create' || action === 'revise' ? result.status !== 'PROPOSED' : action === 'approve' ? !['PROPOSED', 'ACTIVE'].includes(result.status) :
          result.status !== (action === 'suspend' ? 'SUSPENDED' : 'REVOKED'))) throw outcomeUnknown();
    }
    if (response.kind === 'relationship-recover' && request.kind === 'relationship-recover' && response.original !== null) {
      const original = response.original;
      if (!same(original.receipt.identity, request.query.identity) || original.receipt.commandDigest !== request.query.commandDigest ||
        original.mutation.command.payload.action !== request.query.action) throw outcomeUnknown();
    }
    return response;
  } catch { throw outcomeUnknown(); }
}

const errorMessages = {
  AUTH_REQUIRED: [401, 'Sign in again to continue.'], FORBIDDEN: [403, 'Current organization membership is required.'],
  STEP_UP_REQUIRED: [403, 'Fresh verification of both factors is required.'], SETUP_REQUIRED: [503, 'Supplier operations are not configured.'],
  IDENTITY_UNAVAILABLE: [503, 'Identity verification is temporarily unavailable.'], NOT_FOUND: [404, 'Resource not found.'],
  SUPPLIER_INPUT_INVALID: [422, 'Use the exact supported supplier operation parameters.'],
  BODY_TOO_LARGE: [413, 'The supplier request exceeds its size limit.'], REQUEST_TIMEOUT: [408, 'The supplier request body did not arrive in time.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Send uncompressed UTF-8 JSON.'],
  SUPPLIER_ACCESS_DENIED: [403, 'Current exact supplier access is required.'],
  SUPPLIER_VERIFICATION_REFUSED: [403, 'Current exact supplier authentication is required.'],
  SUPPLIER_VERIFICATION_UNAVAILABLE: [503, 'Supplier authentication is temporarily unavailable.'],
  SUPPLIER_APPROVER_REFUSED: [403, 'Exact current original approver membership is required.'],
  SUPPLIER_APPROVER_UNAVAILABLE: [503, 'Original approver membership verification is temporarily unavailable.'],
  SUPPLIER_OBSERVATION_EXPIRED: [409, 'Supplier verification expired. Obtain fresh verification for the original request.'],
  SUPPLIER_AUTHORITY_IMMUTABLE: [409, 'Supplier authority records cannot be replaced or removed.'],
  SUPPLIER_OUTCOME_UNKNOWN: [503, 'The supplier result is unconfirmed. Preserve the exact original request and use explicit recovery.'],
} as const;
function headers(c: Context<ApiEnv>) {
  c.header('Cache-Control', 'private, no-store'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Content-Type-Options', 'nosniff');
}
function failure(c: Context<ApiEnv>, error: unknown) {
  headers(c);
  const code = error instanceof DomainError && Object.hasOwn(errorMessages, error.code) ? error.code as keyof typeof errorMessages : 'SUPPLIER_OUTCOME_UNKNOWN';
  const [status, message] = errorMessages[code], candidate = c.get('correlationId');
  const correlationId = typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID();
  return c.json(ApiErrorSchema.parse({ error: { code, message, correlationId } }), status);
}
function family(url: URL): boolean {
  let path = url.pathname; try { path = decodeURIComponent(path); } catch { /* Matching raw families still refuse malformed encodings below. */ }
  return /^\/v1\/(?:supplier-relationships|supplier-scope-policies)(?:\/|$)/.test(path);
}

/** Mount before generic identity/body middleware. The supplied service remains in the same process as its private handles. */
export function registerSupplierRelationshipRoutes(app: Hono<ApiEnv>, gateway: SupplierRelationshipHttpGateway | undefined): void {
  const submit = gateway?.submit.bind(gateway), routes = Object.values(supplierRelationshipHttpRoutes);
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url); if (!family(url)) return next(); headers(c);
    try {
      if (url.search || url.hash || url.href.endsWith('?') || url.href.endsWith('#') || url.pathname.includes('%') || !routes.includes(url.pathname as typeof routes[number])) throw invalid();
      if (c.req.method !== 'POST') throw new DomainError('NOT_FOUND', 404, 'Resource not found.');
      await next();
    } catch (error) { return failure(c, error); }
  });
  for (const [kind, path] of Object.entries(supplierRelationshipHttpRoutes) as [SupplierRelationshipHttpKind, string][]) {
    app.all(path, async c => {
      headers(c);
      try {
        const authorization = c.req.header('Authorization'), keyHeader = c.req.header('Idempotency-Key');
        const command = kind === 'relationship-command' || kind === 'policy-command';
        const key = command ? parsed(IdempotencyKeySchema, keyHeader) : null;
        if (!command && keyHeader !== undefined) throw invalid();
        const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(authorization ?? '')?.[1];
        if (!token) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.');
        const body = await readSupplierRelationshipJson(c.req.raw, supplierRelationshipHttpBodyLimits[kind]);
        let input: unknown;
        switch (kind) {
          case 'relationship-status': input = { kind, query: parsed(SupplierRelationshipStatusHttpSchema, body) }; break;
          case 'relationship-recover': input = { kind, query: parsed(SupplierRelationshipRecoveryHttpSchema, body) }; break;
          case 'policy-read': input = { kind, query: parsed(SupplierScopePolicyReadHttpSchema, body) }; break;
          case 'relationship-command': input = { kind, mutation: { idempotencyKey: key, command: parsed(SupplierRelationshipCommandHttpSchema, body) } }; break;
          case 'policy-command': input = { kind, mutation: { idempotencyKey: key, command: parsed(SupplierScopePolicyCommandHttpSchema, body) } }; break;
        }
        const request = immutable(parsed(SupplierRelationshipHttpRequestSchema, input));
        if (!submit) throw new DomainError('SETUP_REQUIRED', 503, 'Supplier operations are not configured.');
        const raw = await submit(token, request);
        const response = await validateSupplierRelationshipHttpResponse(request, raw);
        return c.json(response, 200);
      } catch (error) { return failure(c, error); }
    });
  }
}
