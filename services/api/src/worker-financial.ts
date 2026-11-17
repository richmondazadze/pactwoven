import { z } from 'zod';
import { IdSchema, HashSchema, FinancialPolicyVersionSchema, FinancialPolicyHttpRequestSchema,
  FinancialPolicyHttpRecoveryLocatorSchema, FinancialPolicyHttpContextSchema, FinancialPolicyHttpRecordResponseSchema,
  FinancialPolicyHttpDraftIndexResponseSchema, FinancialPolicyHttpGovernanceIndexResponseSchema,
  FinancialPolicyHttpMutationResponseSchema, FinancialPolicyHttpRecoveryResponseSchema,
  FinancialPolicyPreparationRequestSchema, FinancialPolicyPreparationResponseSchema,
  CustodyUuidSchema, CustodyPrepareHttpSchema, CustodyChallengeHttpSchema, CustodyConfirmationHttpSchema,
  CustodyConfirmHttpSchema, CustodyCancelHttpSchema, CustodyApiRecoveryQuerySchema,
  CustodyApiRecoveryContextSchema, CustodyApiReadResponseSchema, CustodyApiMutationResponseSchema,
  CustodyApiRecoveryResponseSchema } from '@pactwoven/contracts';
import { canonicalJson, commandDigest, custodyRecordHash, custodySpecificationHash, DomainError } from '@pactwoven/domain';
import type { FinancialPolicyGateway } from './financial-policy-service.js';
import type { FinancialPolicyWriteGateway } from './financial-policy-write-service.js';
import type { FinancialPolicyPreparationGateway } from './financial-policy-preparation-service.js';
import type { CustodySetupGateway } from './custody-setup-service.js';
import type { ServiceBinding } from './worker-config.js';
import { privateDeadline, readPrivateJson, serviceJsonRequest } from './worker-service.js';
import { snapshotFinancialPolicyWriteRequest, snapshotFinancialPolicyPreparationSelection,
  validateFinancialPolicyWriteResponse, validateFinancialPolicyPreparationResponse,
  validateCustodyApiOperation, validateCustodyApiMutationResponse } from './financial-worker-result.js';

export const financialUrl = 'https://pactwoven-financial.internal/internal/financial/dispatch';
export const financialRequestBytes = 280 * 1024;
export const financialResponseBytes = 2 * 1024 * 1024 + 16 * 1024;
export type FinancialGateways = {
  financialPolicy: FinancialPolicyGateway;
  financialPolicyWrite: FinancialPolicyWriteGateway;
  financialPolicyPreparation: FinancialPolicyPreparationGateway;
  custodySetup: CustodySetupGateway;
};
const requestContext = z.strictObject({ url: z.string().url().max(4096), method: z.enum(['GET', 'POST']),
  correlationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const responsibilityId = IdSchema.nullable();
const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('policy-context'), responsibilityId, assetKey: HashSchema.nullable() }),
  z.strictObject({ kind: z.literal('policy-index'), responsibilityId, query: z.strictObject({ afterId: IdSchema.nullable(), limit: z.number().int().min(1).max(50) }) }),
  z.strictObject({ kind: z.literal('policy-get'), selector: z.strictObject({ responsibilityId, id: IdSchema,
    version: FinancialPolicyVersionSchema, kind: z.enum(['document', 'draft', 'governance']) }).refine(v => v.kind === 'document' || (v.kind === 'draft') === (v.responsibilityId !== null)) }),
  z.strictObject({ kind: z.literal('policy-recover'), locator: FinancialPolicyHttpRecoveryLocatorSchema }),
  z.strictObject({ kind: z.literal('policy-submit'), command: FinancialPolicyHttpRequestSchema.refine(v => ['save_document', 'save_draft', 'withdraw_draft', 'propose_governance'].includes(v.kind)) }),
  z.strictObject({ kind: z.literal('policy-prepare'), responsibilityId, selection: FinancialPolicyPreparationRequestSchema }),
  z.strictObject({ kind: z.literal('custody-context'), responsibilityId: IdSchema }),
  z.strictObject({ kind: z.literal('custody-get'), responsibilityId: IdSchema, setupId: CustodyUuidSchema }),
  z.strictObject({ kind: z.literal('custody-recover'), responsibilityId: IdSchema, query: CustodyApiRecoveryQuerySchema }),
  z.strictObject({ kind: z.literal('custody-prepare'), responsibilityId: IdSchema, input: CustodyPrepareHttpSchema }),
  z.strictObject({ kind: z.literal('custody-challenge'), responsibilityId: IdSchema, setupId: CustodyUuidSchema, input: CustodyChallengeHttpSchema }),
  z.strictObject({ kind: z.literal('custody-confirmation'), responsibilityId: IdSchema, setupId: CustodyUuidSchema, input: CustodyConfirmationHttpSchema }),
  z.strictObject({ kind: z.literal('custody-confirm'), responsibilityId: IdSchema, setupId: CustodyUuidSchema, input: CustodyConfirmHttpSchema }),
  z.strictObject({ kind: z.literal('custody-cancel'), responsibilityId: IdSchema, setupId: CustodyUuidSchema, input: CustodyCancelHttpSchema }),
]);
const requestSchema = z.strictObject({ nonce: z.uuid(), request: requestContext, action: actionSchema });
type Action = z.infer<typeof actionSchema>;
type Input = z.infer<typeof requestSchema>;
const safeErrors = {
  AUTH_REQUIRED: [401, 'Sign in again.'], FORBIDDEN: [403, 'Current access is required.'],
  STEP_UP_REQUIRED: [403, 'Fresh verification of both factors is required.'],
  IDENTITY_UNAVAILABLE: [503, 'Identity verification is temporarily unavailable.'],
  SETUP_REQUIRED: [503, 'The development financial service is not configured.'], NOT_FOUND: [404, 'Resource not found.'],
  BODY_TOO_LARGE: [413, 'The request exceeds its size limit.'], REQUEST_TIMEOUT: [408, 'The request body took too long.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Send uncompressed UTF-8 JSON.'], VALIDATION_FAILED: [422, 'Check the exact request.'],
  UNSAFE_DATABASE_ROLE: [503, 'The development financial service is temporarily unavailable.'],
  FINANCIAL_POLICY_INPUT_INVALID: [422, 'Use the exact supported policy parameters.'],
  FINANCIAL_POLICY_INVALID: [422, 'The reviewed financial-policy material is inconsistent.'],
  FINANCIAL_POLICY_ACCESS_DENIED: [403, 'Current scoped policy access is required.'],
  FINANCIAL_POLICY_SCOPE_CHANGED: [409, 'The policy scope changed. Refresh the review.'],
  FINANCIAL_POLICY_EXPIRED: [409, 'The policy observation or reviewed interval expired.'],
  FINANCIAL_POLICY_UNAVAILABLE: [409, 'The complete policy review is unavailable.'],
  FINANCIAL_POLICY_KEY_CONFLICT: [409, 'Preserve the original policy request identity.'],
  FINANCIAL_POLICY_OUTCOME_UNKNOWN: [503, 'The result is unconfirmed. Preserve the original key and request hash; use original-result lookup.'],
  CUSTODY_ACCESS_DENIED: [403, 'Current owner and site access are required.'],
  CUSTODY_SCOPE_CHANGED: [409, 'The exact setup scope changed.'], CUSTODY_EXPIRED: [409, 'The setup verification expired. Check the original request.'],
  CUSTODY_KEY_CONFLICT: [409, 'The key is bound to another exact request.'], CUSTODY_INPUT_INVALID: [422, 'Check the exact custody setup request.'],
  CUSTODY_OUTCOME_UNKNOWN: [503, 'The original setup result is unconfirmed. Check the same request key.'],
} as const;
type ErrorCode = keyof typeof safeErrors;
const errorCodeSchema = z.enum(Object.keys(safeErrors) as [ErrorCode, ...ErrorCode[]]);
const responseSchema = z.strictObject({ schemaVersion: z.literal(1), environment: z.literal('development'), issuer: z.string().url(),
  nonce: z.uuid(), tokenHash: HashSchema, requestHash: HashSchema, actionHash: HashSchema, request: requestContext,
  respondedAt: z.iso.datetime(), outcome: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ok'), data: z.unknown() }), z.strictObject({ status: z.literal('error'), code: errorCodeSchema }),
  ]) });
const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const isCustody = (a: { kind: string }) => a.kind.startsWith('custody-');
const unknownCode = (a: { kind: string }) => isCustody(a) ? 'CUSTODY_OUTCOME_UNKNOWN' : 'FINANCIAL_POLICY_OUTCOME_UNKNOWN';
const permittedError = (a: Action, code: ErrorCode) => !code.startsWith(isCustody(a) ? 'FINANCIAL_POLICY_' : 'CUSTODY_');
function unavailable(a: { kind: string }) { const code = unknownCode(a); return new DomainError(code, 503, safeErrors[code][1]); }
async function affinity(input: Input, token: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return { nonce: input.nonce, tokenHash: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''),
    requestHash: await commandDigest(input), actionHash: await commandDigest(input.action), request: input.request };
}
function query(url: URL, allowed: string[]) {
  const out: Record<string, string> = {};
  if (url.search && (!/^\?[A-Za-z0-9_=&-]+$/.test(url.search) ||
      url.search.slice(1).split('&').some(part => !/^[A-Za-z][A-Za-z0-9]*=[A-Za-z0-9_-]+$/.test(part)))) throw new Error();
  for (const [key, value] of url.searchParams) { if (!allowed.includes(key) || Object.hasOwn(out, key)) throw new Error(); out[key] = value; }
  return out;
}
function validateRoute(input: Input) {
  const { action: a, request: r } = input, u = new URL(r.url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || u.href.endsWith('?') || u.pathname.includes('%')) throw new Error();
  let path: string, method = 'GET';
  const rid = 'responsibilityId' in a ? a.responsibilityId : a.kind === 'policy-get' ? a.selector.responsibilityId
    : a.kind === 'policy-recover' ? a.locator.responsibilityId : a.command.responsibilityId;
  const base = rid === null ? '/v1/financial-governance' : `/v1/responsibilities/${rid}/financial-policies`;
  const custody = `/v1/responsibilities/${rid}/custody-setups`;
  switch (a.kind) {
    case 'policy-context': path = `${base}/context`; if (!equal(query(u, ['assetKey']), a.assetKey === null ? {} : { assetKey: a.assetKey })) throw new Error(); break;
    case 'policy-index': {
      path = base; const q = query(u, ['afterId', 'limit']);
      if (q.limit !== undefined && !/^[1-9][0-9]*$/.test(q.limit) ||
          !equal({ afterId: q.afterId ?? null, limit: q.limit === undefined ? 20 : Number(q.limit) }, a.query)) throw new Error(); break;
    }
    case 'policy-get': path = a.selector.kind === 'document' ? (rid === null ? `${base}/documents` : `/v1/responsibilities/${rid}/financial-policy-documents`) : base;
      path += `/${a.selector.id}/versions/${a.selector.version}`; query(u, []); break;
    case 'policy-recover': path = rid === null ? `${base}/operations/${a.locator.key}` : `/v1/responsibilities/${rid}/financial-policy-operations/${a.locator.key}`;
      if (!equal(query(u, ['kind', 'targetId', 'requestHash']), { kind: a.locator.kind, targetId: a.locator.targetId, requestHash: a.locator.publicRequestHash })) throw new Error(); break;
    case 'policy-submit': path = snapshotFinancialPolicyWriteRequest(a.command).route; method = 'POST'; query(u, []); break;
    case 'policy-prepare': snapshotFinancialPolicyPreparationSelection(rid, a.selection);
      path = rid === null ? '/v1/financial-governance-preparation' : `/v1/responsibilities/${rid}/financial-policy-preparation`; method = 'POST'; query(u, []); break;
    case 'custody-context': path = `${custody}/recovery-context`; query(u, []); break;
    case 'custody-get': path = `${custody}/${a.setupId}`; query(u, []); break;
    case 'custody-recover': path = `${custody}/operations/${a.query.key}`;
      if (!equal(query(u, ['kind']), { kind: a.query.kind })) throw new Error(); break;
    case 'custody-prepare': path = custody; method = 'POST'; query(u, []); break;
    default: path = `${custody}/${a.setupId}/${({ 'custody-challenge': 'owner-challenge', 'custody-confirmation': 'owner-confirmation-challenge', 'custody-confirm': 'confirm-owner', 'custody-cancel': 'cancel' } as const)[a.kind]}`;
      method = 'POST'; query(u, []);
  }
  if (u.pathname !== path || r.method !== method) throw new Error();
}
function fresh(v: { scope: { environment: string }; observation: { observedAt: string; expiresAt: string } }) {
  const now = Date.now();
  if (v.scope.environment !== 'development' || Date.parse(v.observation.observedAt) > now || Date.parse(v.observation.expiresAt) <= now) throw new Error();
}
async function parseResult(a: Action, input: unknown) {
  if (a.kind === 'policy-context') {
    const v = FinancialPolicyHttpContextSchema.parse(input); fresh(v);
    if (v.responsibilityId !== a.responsibilityId || v.asset !== null && v.asset.pin.key !== a.assetKey) throw new Error(); return v;
  }
  if (a.kind === 'policy-index') {
    const v = (a.responsibilityId === null ? FinancialPolicyHttpGovernanceIndexResponseSchema : FinancialPolicyHttpDraftIndexResponseSchema).parse(input); fresh(v);
    if (v.responsibilityId !== a.responsibilityId || v.items.length > a.query.limit || v.nextId !== null && v.items.length !== a.query.limit ||
        v.items.some(item => a.query.afterId !== null && item.policy.record.id <= a.query.afterId)) throw new Error(); return v;
  }
  if (a.kind === 'policy-get') {
    const v = FinancialPolicyHttpRecordResponseSchema.parse(input); fresh(v);
    if (v.responsibilityId !== a.selector.responsibilityId || v.policy.record.kind !== a.selector.kind ||
        v.policy.reference.id !== a.selector.id || v.policy.reference.version !== a.selector.version) throw new Error(); return v;
  }
  if (a.kind === 'policy-recover') {
    const v = FinancialPolicyHttpRecoveryResponseSchema.parse(input); fresh(v);
    if (!equal({ responsibilityId: v.responsibilityId, kind: v.kind, key: v.key, targetId: v.targetId, publicRequestHash: v.publicRequestHash }, a.locator)) throw new Error(); return v;
  }
  if (a.kind === 'policy-submit') { const v = await validateFinancialPolicyWriteResponse(a.command, input); fresh(v); return v; }
  if (a.kind === 'policy-prepare') { const v = await validateFinancialPolicyPreparationResponse(a.responsibilityId, a.selection, input); fresh(v); return v; }
  if (a.kind === 'custody-context') {
    const v = CustodyApiRecoveryContextSchema.parse(input), now = Date.now();
    if (v.responsibilityId !== a.responsibilityId || Date.parse(v.observedAt) > now || Date.parse(v.expiresAt) <= now) throw new Error(); return v;
  }
  if (a.kind === 'custody-get') {
    const v = CustodyApiReadResponseSchema.parse(input), d = v.setup.draft, b = v.setup.binding;
    if (v.setup.setupId !== a.setupId || d.setupId !== a.setupId || d.responsibilityId !== a.responsibilityId ||
        v.review.responsibility.id !== a.responsibilityId || v.review.organization.id !== d.organizationId || v.review.owner.actorId !== d.actorId ||
        v.setup.draftHash !== await custodyRecordHash(d) || !equal(d.specification, { id: v.review.id, version: v.review.version, recordHash: await custodySpecificationHash(v.review) }) ||
        b && (b.setupId !== a.setupId || b.organizationId !== d.organizationId || b.actorId !== d.actorId || b.responsibilityId !== a.responsibilityId ||
          !equal(b.draft, { id: d.id, version: d.version, recordHash: v.setup.draftHash }) || !equal(b.specification, v.review) || !equal(b.specificationRef, d.specification)) ||
        v.setup.state === 'confirmed' && !b || v.setup.state === 'pending' && b) throw new Error(); return v;
  }
  if (a.kind === 'custody-recover') {
    const v = CustodyApiRecoveryResponseSchema.parse(input), r = v.operation;
    if (v.responsibilityId !== a.responsibilityId || v.kind !== a.query.kind || v.key !== a.query.key || (v.status === 'recorded') !== (r !== null)) throw new Error();
    if (r) { await validateCustodyApiOperation(r);
      if (r.organizationId !== v.organizationId || r.actorId !== v.actorId || r.responsibilityId !== v.responsibilityId || r.kind !== v.kind || r.key !== v.key) throw new Error(); }
    return v;
  }
  const kind = a.kind.slice('custody-'.length) as 'prepare' | 'challenge' | 'confirmation' | 'confirm' | 'cancel';
  return validateCustodyApiMutationResponse(input, kind, a.responsibilityId, a.input.key, 'setupId' in a ? a.setupId : undefined, a.input);
}
function dispatch(g: FinancialGateways, token: string, input: Input) {
  const a = input.action, trace = input.request.correlationId;
  switch (a.kind) {
    case 'policy-context': return g.financialPolicy.context(token, a.responsibilityId, a.assetKey);
    case 'policy-index': return g.financialPolicy.index(token, a.responsibilityId, a.query);
    case 'policy-get': return g.financialPolicy.get(token, a.selector);
    case 'policy-recover': return g.financialPolicy.recover(token, a.locator);
    case 'policy-submit': return g.financialPolicyWrite.submit(token, snapshotFinancialPolicyWriteRequest(a.command));
    case 'policy-prepare': return g.financialPolicyPreparation.prepare(token, a.responsibilityId, a.selection);
    case 'custody-context': return g.custodySetup.recoveryContext(token, a.responsibilityId, trace);
    case 'custody-get': return g.custodySetup.get(token, a.responsibilityId, a.setupId, trace);
    case 'custody-recover': return g.custodySetup.recover(token, a.responsibilityId, a.query, trace);
    case 'custody-prepare': return g.custodySetup.prepare(token, a.responsibilityId, a.input, trace);
    case 'custody-challenge': return g.custodySetup.challenge(token, a.responsibilityId, a.setupId, a.input, trace);
    case 'custody-confirmation': return g.custodySetup.confirmation(token, a.responsibilityId, a.setupId, a.input, trace);
    case 'custody-confirm': return g.custodySetup.confirm(token, a.responsibilityId, a.setupId, a.input, trace);
    case 'custody-cancel': return g.custodySetup.cancel(token, a.responsibilityId, a.setupId, a.input, trace);
  }
}
/** Intake validation precedes gateway construction, identity checks and opening database pools. */
export async function handlePrivateFinancialRequest(request: Request, issuer: string, createGateways: () => FinancialGateways): Promise<Response> {
  if (request.url !== financialUrl || request.method !== 'POST') return new Response(null, { status: 404, headers });
  const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401, headers });
  let input: Input;
  try {
    const length = request.headers.get('Content-Length');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get('Content-Type') ?? '') ||
        !['', 'identity'].includes((request.headers.get('Content-Encoding') ?? '').toLowerCase()) ||
        length !== null && (!/^\d+$/.test(length) || Number(length) > financialRequestBytes)) throw new Error();
    input = requestSchema.parse(await privateDeadline(5_000, signal => readPrivateJson(request.body, signal, financialRequestBytes)));
    validateRoute(input);
  } catch { return Response.json({ error: { code: 'VALIDATION_FAILED' } }, { status: 422, headers }); }
  const expected = await affinity(input, token);
  const respond = (outcome: z.infer<typeof responseSchema>['outcome'], status: number) => {
    const body = JSON.stringify(responseSchema.parse({ schemaVersion: 1, environment: 'development', issuer, ...expected, respondedAt: new Date().toISOString(), outcome }));
    if (new TextEncoder().encode(body).byteLength > financialResponseBytes) throw new Error();
    return new Response(body, { status, headers });
  };
  try { return respond({ status: 'ok', data: await parseResult(input.action, await dispatch(createGateways(), token, input)) }, 200); }
  catch (error) {
    const code = error instanceof DomainError && Object.hasOwn(safeErrors, error.code) &&
      safeErrors[error.code as ErrorCode][0] === error.status && permittedError(input.action, error.code as ErrorCode) ? error.code as ErrorCode : unknownCode(input.action);
    return respond({ status: 'error', code }, safeErrors[code][0]);
  }
}

/** Public adapters carry only exact request snapshots; private gateways independently verify each bearer. */
export function serviceFinancialGateways(binding: ServiceBinding, originalRequest: Request, issuer: string): FinancialGateways {
  const authorization = originalRequest.headers.get('Authorization') ?? '', key = originalRequest.headers.get('Idempotency-Key');
  const url = originalRequest.url, method = originalRequest.method;
  const trace = originalRequest.headers.get('X-Correlation-Id') ?? crypto.randomUUID();
  async function exchange(token: string, action: Action, correlationId = trace) {
    if (authorization !== `Bearer ${token}` || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new DomainError('AUTH_REQUIRED', 401, safeErrors.AUTH_REQUIRED[1]);
    const startedAt = Date.now(); let verifiedFailure: DomainError | undefined;
    try {
      const input = requestSchema.parse({ nonce: crypto.randomUUID(), request: { url, method, correlationId }, action });
      validateRoute(input);
      const expectedKey = input.action.kind === 'policy-submit' ? input.action.command.key : 'input' in input.action ? input.action.input.key : null;
      if (expectedKey !== null && key !== expectedKey || input.action.kind === 'policy-prepare' && key !== null) throw new Error();
      const body = JSON.stringify(input);
      if (new TextEncoder().encode(body).byteLength > financialRequestBytes) throw new Error();
      const expected = await affinity(input, token);
      const { response, data } = await serviceJsonRequest(binding, new Request(financialUrl, { method: 'POST', redirect: 'manual',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body }), financialResponseBytes);
      const v = responseSchema.parse(data), now = Date.now(), at = Date.parse(v.respondedAt);
      if (response.headers.get('Cache-Control') !== 'private, no-store' || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '') ||
          v.issuer !== issuer || at < startedAt - 5_000 || at > now + 5_000 || now - at > 20_000 ||
          !equal({ nonce: v.nonce, tokenHash: v.tokenHash, requestHash: v.requestHash, actionHash: v.actionHash, request: v.request }, expected)) throw new Error();
      if (v.outcome.status === 'error') {
        const [status, message] = safeErrors[v.outcome.code];
        if (response.status !== status || !permittedError(input.action, v.outcome.code)) throw new Error();
        verifiedFailure = new DomainError(v.outcome.code, status, message); throw verifiedFailure;
      }
      if (response.status !== 200) throw new Error();
      return await parseResult(input.action, v.outcome.data);
    } catch (error) { if (verifiedFailure && error === verifiedFailure) throw verifiedFailure; throw unavailable(action); }
  }
  return {
    financialPolicy: {
      context: async (token, responsibilityId, assetKey) => FinancialPolicyHttpContextSchema.parse(await exchange(token, { kind: 'policy-context', responsibilityId, assetKey })),
      index: async (token, responsibilityId, query) => (responsibilityId === null ? FinancialPolicyHttpGovernanceIndexResponseSchema : FinancialPolicyHttpDraftIndexResponseSchema).parse(await exchange(token, { kind: 'policy-index', responsibilityId, query })),
      get: async (token, selector) => FinancialPolicyHttpRecordResponseSchema.parse(await exchange(token, { kind: 'policy-get', selector })),
      recover: async (token, locator) => FinancialPolicyHttpRecoveryResponseSchema.parse(await exchange(token, { kind: 'policy-recover', locator })),
    },
    financialPolicyWrite: { submit: async (token, command) => FinancialPolicyHttpMutationResponseSchema.parse(await exchange(token, { kind: 'policy-submit', command })) },
    financialPolicyPreparation: { prepare: async (token, responsibilityId, selection) => FinancialPolicyPreparationResponseSchema.parse(await exchange(token, { kind: 'policy-prepare', responsibilityId, selection })) },
    custodySetup: {
      recoveryContext: async (token, responsibilityId, trace) => CustodyApiRecoveryContextSchema.parse(await exchange(token, { kind: 'custody-context', responsibilityId }, trace)),
      get: async (token, responsibilityId, setupId, trace) => CustodyApiReadResponseSchema.parse(await exchange(token, { kind: 'custody-get', responsibilityId, setupId }, trace)),
      recover: async (token, responsibilityId, input, trace) => CustodyApiRecoveryResponseSchema.parse(await exchange(token, { kind: 'custody-recover', responsibilityId, query: CustodyApiRecoveryQuerySchema.parse(input) }, trace)),
      prepare: async (token, responsibilityId, input, trace) => CustodyApiMutationResponseSchema.parse(await exchange(token, { kind: 'custody-prepare', responsibilityId, input: CustodyPrepareHttpSchema.parse(input) }, trace)),
      challenge: async (token, responsibilityId, setupId, input, trace) => CustodyApiMutationResponseSchema.parse(await exchange(token, { kind: 'custody-challenge', responsibilityId, setupId, input: CustodyChallengeHttpSchema.parse(input) }, trace)),
      confirmation: async (token, responsibilityId, setupId, input, trace) => CustodyApiMutationResponseSchema.parse(await exchange(token, { kind: 'custody-confirmation', responsibilityId, setupId, input: CustodyConfirmationHttpSchema.parse(input) }, trace)),
      confirm: async (token, responsibilityId, setupId, input, trace) => CustodyApiMutationResponseSchema.parse(await exchange(token, { kind: 'custody-confirm', responsibilityId, setupId, input: CustodyConfirmHttpSchema.parse(input) }, trace)),
      cancel: async (token, responsibilityId, setupId, input, trace) => CustodyApiMutationResponseSchema.parse(await exchange(token, { kind: 'custody-cancel', responsibilityId, setupId, input: CustodyCancelHttpSchema.parse(input) }, trace)),
    },
  };
}
