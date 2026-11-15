import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, HashSchema, MandateCollectionQuerySchema, MandateReviewQuerySchema,
  MandateOperationQuerySchema, CreateMandateDocumentRequestSchema, ProposeMandateCommandSchema, MandateDecisionIntentSchema,
  MandateAuthorityIntentSchema, MandatePageSchema, MandateReviewSchema, MandateOperationResultSchema, MandateDocumentQuerySchema, MandateDocumentReadSchema,
  type MandateGateway } from '@pactwoven/contracts';
import { commandDigest, DomainError, mandateIntentHash } from '@pactwoven/domain';
import type { ServiceBinding } from './worker-config.js';
import { privateDeadline, readPrivateJson, serviceJsonRequest } from './worker-service.js';
import { qualifyMandateDocumentResult } from './mandate-document-result.js';

export const mandateUrl = 'https://pactwoven-mandate.internal/internal/mandates/dispatch';
export const mandateRequestBytes = 128 * 1024;
export const mandateResponseBytes = 1024 * 1024;
const requestContextSchema = z.strictObject({ url: z.string().url().max(4096), method: z.enum(['GET', 'POST']),
  correlationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('document-read'), responsibilityId: IdSchema, documentId: IdSchema, query: MandateDocumentQuerySchema }),
  z.strictObject({ kind: z.literal('list'), responsibilityId: IdSchema, query: MandateCollectionQuerySchema }),
  z.strictObject({ kind: z.literal('review'), responsibilityId: IdSchema, proposalId: IdSchema, query: MandateReviewQuerySchema }),
  z.strictObject({ kind: z.literal('operation'), query: MandateOperationQuerySchema }),
  z.strictObject({ kind: z.literal('document'), responsibilityId: IdSchema, key: IdempotencyKeySchema, command: CreateMandateDocumentRequestSchema }),
  z.strictObject({ kind: z.literal('propose'), responsibilityId: IdSchema, key: IdempotencyKeySchema, command: ProposeMandateCommandSchema }),
  z.strictObject({ kind: z.literal('decide'), responsibilityId: IdSchema, proposalId: IdSchema, key: IdempotencyKeySchema, command: MandateDecisionIntentSchema }),
  z.strictObject({ kind: z.literal('control'), responsibilityId: IdSchema, mandateId: IdSchema, key: IdempotencyKeySchema, command: MandateAuthorityIntentSchema }),
]);
const requestSchema = z.strictObject({ nonce: z.uuid(), request: requestContextSchema, action: actionSchema });
type MandateRequest = z.infer<typeof requestSchema>;
type MandateAction = z.infer<typeof actionSchema>;
const safeErrors = {
  AUTH_REQUIRED: [401, 'Sign in again to continue.'],
  FORBIDDEN: [403, 'Current mandate and site access are required.'],
  STEP_UP_REQUIRED: [403, 'Verify both authentication factors again before authorizing this mandate.'],
  INDEPENDENT_APPROVER_REQUIRED: [403, 'A separate eligible person must decide this proposal.'],
  NOT_FOUND: [404, 'The requested mandate record was not found.'],
  VERSION_CONFLICT: [409, 'The record changed. Refresh before reviewing again.'],
  IDEMPOTENCY_CONFLICT: [409, 'This request key was already used for a different command.'],
  AUTHORITY_CHANGED: [409, 'Mandate authority changed. Refresh before reviewing again.'],
  ORGANIZATION_CHANGED: [409, 'Organization authority changed. Refresh before reviewing again.'],
  RESPONSIBILITY_CHANGED: [409, 'The responsibility changed. Review its current version.'],
  REQUESTER_CHANGED: [409, 'The original requester no longer has the required authority.'],
  DECISION_CHANGED: [409, 'The decision changed. Refresh its original record.'],
  DECISION_TERMINAL: [409, 'This proposal already has a final decision. Check the original operation.'],
  PROPOSAL_CURRENT: [409, 'A current proposal already exists. Review it before replacing it.'],
  PROPOSAL_EXPIRED: [409, 'This proposal has expired. Review current authority before proposing again.'],
  PROPOSAL_INVALID: [409, 'The exact proposal could not be verified.'],
  POLICY_DOCUMENT_CHANGED: [409, 'The policy document changed. Review its exact version.'],
  POLICY_DOCUMENT_INVALID: [409, 'The policy document could not be verified.'],
  POLICY_DOCUMENT_UNAVAILABLE: [409, 'The referenced policy document is unavailable.'],
  SITE_UNAVAILABLE: [409, 'The required site is unavailable.'],
  APPROVAL_INVALID: [409, 'The accepted approval could not be verified.'],
  TERMS_EXPIRED: [409, 'The accepted terms have expired.'],
  MANDATE_POLICY_UNSUPPORTED: [422, 'This development flow supports advice-only mandates with no external effects.'],
  VALIDATION_FAILED: [422, 'Check the mandate details.'],
  IDENTITY_UNAVAILABLE: [503, 'Identity verification is temporarily unavailable.'],
  MANDATE_READ_INVALID: [409, 'The mandate history or policy provenance could not be verified.'],
  INTEGRITY_ERROR: [503, 'The mandate record could not be verified.'],
  SERVICE_UNAVAILABLE: [503, 'The mandate service is temporarily unavailable. Check the original operation before retrying.'],
  OUTCOME_UNKNOWN: [503, 'The mandate outcome is unknown. Check the original operation before retrying.'],
  DURABLE_SERVICE_UNAVAILABLE: [503, 'The mandate request was not confirmed. Check the original operation.'],
} as const;
const errorCodeSchema = z.enum(Object.keys(safeErrors) as [keyof typeof safeErrors, ...(keyof typeof safeErrors)[]]);
const responseSchema = z.strictObject({
  schemaVersion: z.literal(1), environment: z.literal('development'), issuer: z.string().url(), nonce: z.uuid(),
  tokenHash: HashSchema, requestHash: HashSchema, request: requestContextSchema,
  kind: z.enum(['list', 'review', 'operation', 'document-read', 'document', 'propose', 'decide', 'control']),
  responsibilityId: IdSchema.nullable(), targetId: IdSchema.nullable(), key: IdempotencyKeySchema.nullable(), commandHash: HashSchema,
  respondedAt: z.iso.datetime(), outcome: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ok'), data: z.unknown() }),
    z.strictObject({ status: z.literal('error'), code: errorCodeSchema }),
  ]),
});
const privateHeaders = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
async function tokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function affinity(input: MandateRequest, token: string) {
  const action = input.action;
  return { nonce: input.nonce, tokenHash: await tokenDigest(token), requestHash: await commandDigest(input), request: input.request,
    kind: action.kind, responsibilityId: 'responsibilityId' in action ? action.responsibilityId : null,
    targetId: 'documentId' in action ? action.documentId : 'proposalId' in action ? action.proposalId : 'mandateId' in action ? action.mandateId
      : action.kind === 'document' ? action.command.command.documentId : action.kind === 'propose' ? action.command.proposalId : null,
    key: 'key' in action ? action.key : action.kind === 'operation' ? action.query.key : null,
    commandHash: await commandDigest('command' in action ? action.command : action.query) };
}
async function validateRoute(input: MandateRequest): Promise<void> {
  const { action, request } = input, url = new URL(request.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid source URL');
  const base = 'responsibilityId' in action ? `/v1/responsibilities/${action.responsibilityId}` : '';
  const path = action.kind === 'operation' ? '/v1/mandate-operations' : action.kind === 'list' ? `${base}/mandates`
    : action.kind === 'document-read' ? `${base}/mandate-policy-documents/${action.documentId}`
    : action.kind === 'review' ? `${base}/mandates/${action.proposalId}` : action.kind === 'document' ? `${base}/mandate-policy-documents`
    : action.kind === 'propose' ? `${base}/mandate-proposals` : action.kind === 'decide' ? `${base}/mandate-proposals/${action.proposalId}/decision`
    : `${base}/mandates/${action.mandateId}/authority`;
  const read = 'query' in action;
  if (url.pathname !== path || request.method !== (read ? 'GET' : 'POST') || (!read && url.search)) throw new Error('Mandate route mismatch');
  if (read) {
    const entries = [...url.searchParams];
    if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error('Duplicate query');
    const schema = action.kind === 'document-read' ? MandateDocumentQuerySchema : action.kind === 'list' ? MandateCollectionQuerySchema : action.kind === 'review' ? MandateReviewQuerySchema : MandateOperationQuerySchema;
    if (await commandDigest(schema.parse(Object.fromEntries(entries))) !== await commandDigest(action.query)) throw new Error('Mandate query mismatch');
  }
  if ((action.kind === 'document' || action.kind === 'propose' || action.kind === 'control') && action.command.responsibility.id !== action.responsibilityId) throw new Error('Responsibility mismatch');
  if (action.kind === 'decide' && action.command.proposal.id !== action.proposalId) throw new Error('Proposal mismatch');
  if (action.kind === 'control' && action.command.mandate.id !== action.mandateId) throw new Error('Mandate mismatch');
}
async function parseResult(action: MandateAction, value: unknown) {
  if (action.kind === 'document-read') return qualifyMandateDocumentResult(value, action.responsibilityId, action.documentId, action.query, 'development');
  if (action.kind === 'list') {
    const page = MandatePageSchema.parse(value);
    if (page.environment !== 'development' || page.responsibility.environment !== 'development' ||
        page.responsibility.id !== action.responsibilityId || page.responsibilityReference.id !== action.responsibilityId ||
        page.responsibility.organizationId !== page.organizationId || page.site.id !== page.responsibility.siteId ||
        page.items.length > action.query.limit || page.items.some(item => item.responsibility.id !== action.responsibilityId)) throw new Error('Mandate page mismatch');
    return page;
  }
  if (action.kind === 'review') {
    const review = MandateReviewSchema.parse(value), envelope = review.envelope;
    if (envelope.responsibility.environment !== 'development' || envelope.responsibility.id !== action.responsibilityId ||
        envelope.responsibilityReference.id !== action.responsibilityId || envelope.proposal?.id !== action.proposalId ||
        envelope.proposal.version !== action.query.version || envelope.proposal.environment !== 'development' ||
        envelope.proposal.organizationId !== envelope.responsibility.organizationId || envelope.financialState !== null ||
        review.responsibilityVersions.some(record => record.id !== action.responsibilityId || record.environment !== 'development' || record.organizationId !== envelope.responsibility.organizationId)) throw new Error('Mandate review mismatch');
    return review;
  }
  const result = MandateOperationResultSchema.parse(value);
  if (result.operation.environment !== 'development') throw new Error('Mandate environment mismatch');
  if (action.kind === 'operation') {
    if (result.kind !== action.query.kind) throw new Error('Original operation kind mismatch');
  } else {
    const expected = action.kind === 'document' ? { kind: 'mandate.document.create', id: action.command.command.documentId, version: action.command.command.expectedVersion + 1 }
      : action.kind === 'propose' ? { kind: 'mandate.propose', id: action.command.proposalId, version: action.command.expectedProposalVersion + 1 }
      : action.kind === 'decide' ? { kind: action.command.action === 'AUTHORIZE' ? 'mandate.authorize' : 'mandate.reject', id: action.proposalId, version: action.command.expectedDecisionVersion + 1 }
      : { kind: `mandate.${action.command.action.toLowerCase()}`, id: action.mandateId, version: action.command.head.mandateEpoch + 1 };
    if (result.responsibilityId !== action.responsibilityId || result.kind !== expected.kind || result.target.id !== expected.id || result.target.version !== expected.version) throw new Error('Mandate operation target mismatch');
    if ((action.kind === 'decide' || action.kind === 'control') && result.intentHash !== await mandateIntentHash(action.command)) throw new Error('Mandate intent mismatch');
  }
  if (result.operation.error !== null && result.operation.error.code !== 'OUTCOME_UNKNOWN') errorCodeSchema.parse(result.operation.error.code);
  return result;
}
function dispatch(gateway: MandateGateway, token: string, input: MandateRequest) {
  const a = input.action, trace = input.request.correlationId;
  switch (a.kind) {
    case 'document-read': return gateway.readDocument(token, a.responsibilityId, a.documentId, a.query, trace);
    case 'list': return gateway.list(token, a.responsibilityId, a.query, trace);
    case 'review': return gateway.review(token, a.responsibilityId, a.proposalId, a.query, trace);
    case 'operation': return gateway.operation(token, a.query, trace);
    case 'document': return gateway.createDocument(token, a.responsibilityId, a.key, a.command, trace);
    case 'propose': return gateway.propose(token, a.responsibilityId, a.key, a.command, trace);
    case 'decide': return gateway.decide(token, a.responsibilityId, a.proposalId, a.key, a.command, trace);
    case 'control': return gateway.control(token, a.responsibilityId, a.mandateId, a.key, a.command, trace);
  }
}
/** The private factory binds this request nonce to independent token/MFA verification; caller proof is never accepted. */
export async function handlePrivateMandateRequest(request: Request, issuer: string, createGateway: (requestNonce: string) => MandateGateway): Promise<Response> {
  if (request.url !== mandateUrl || request.method !== 'POST') return new Response(null, { status: 404, headers: privateHeaders });
  const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401, headers: privateHeaders });
  let input: MandateRequest;
  try {
    const length = request.headers.get('Content-Length');
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '') ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > mandateRequestBytes))) throw new Error('Invalid intake');
    input = requestSchema.parse(await privateDeadline(5_000, signal => readPrivateJson(request.body, signal, mandateRequestBytes)));
    await validateRoute(input);
  } catch { return Response.json({ error: { code: 'VALIDATION_FAILED' } }, { status: 422, headers: privateHeaders }); }
  const binding = await affinity(input, token);
  const respond = (outcome: z.infer<typeof responseSchema>['outcome'], status: number) => {
    const body = JSON.stringify(responseSchema.parse({ schemaVersion: 1, environment: 'development', issuer, ...binding,
      respondedAt: new Date().toISOString(), outcome }));
    if (new TextEncoder().encode(body).byteLength > mandateResponseBytes) throw new Error('Oversized result');
    return new Response(body, { status, headers: privateHeaders });
  };
  try {
    const data = await parseResult(input.action, await dispatch(createGateway(input.nonce), token, input));
    return respond({ status: 'ok', data }, 200);
  } catch (error) {
    const code = error instanceof DomainError && Object.hasOwn(safeErrors, error.code) &&
      safeErrors[error.code as keyof typeof safeErrors][0] === error.status ? error.code as keyof typeof safeErrors : 'DURABLE_SERVICE_UNAVAILABLE';
    return respond({ status: 'error', code }, safeErrors[code][0]);
  }
}

/** Public adapter has no runtime import of a Clerk client, mandate repository or privileged gateway implementation. */
export function serviceMandateGateway(binding: ServiceBinding, originalRequest: Request, issuer: string): MandateGateway {
  const authorization = originalRequest.headers.get('Authorization') ?? '';
  async function exchange(token: string, action: MandateAction, correlationId: string) {
    if (authorization !== `Bearer ${token}` || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new DomainError('AUTH_REQUIRED', 401, safeErrors.AUTH_REQUIRED[1]);
    const startedAt = Date.now();
    let verifiedFailure: DomainError | undefined;
    try {
      const input = requestSchema.parse({ nonce: crypto.randomUUID(), request: { url: originalRequest.url, method: originalRequest.method, correlationId }, action });
      await validateRoute(input);
      if ('key' in input.action && originalRequest.headers.get('Idempotency-Key') !== input.action.key) throw new Error('Command key mismatch');
      const expected = await affinity(input, token);
      const { response, data } = await serviceJsonRequest(binding, new Request(mandateUrl, { method: 'POST', redirect: 'error',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), mandateResponseBytes);
      const result = responseSchema.parse(data), now = Date.now(), respondedAt = Date.parse(result.respondedAt);
      if (response.headers.get('Cache-Control') !== 'private, no-store' || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '') ||
          result.issuer !== issuer || respondedAt < startedAt - 5_000 || respondedAt > now + 5_000 || now - respondedAt > 20_000 ||
          await commandDigest({ nonce: result.nonce, tokenHash: result.tokenHash, requestHash: result.requestHash, request: result.request,
            kind: result.kind, responsibilityId: result.responsibilityId, targetId: result.targetId, key: result.key, commandHash: result.commandHash }) !== await commandDigest(expected)) throw new Error('Mandate response affinity failed');
      if (result.outcome.status === 'error') {
        const [status, message] = safeErrors[result.outcome.code];
        if (response.status !== status) throw new Error('Mandate error status mismatch');
        verifiedFailure = new DomainError(result.outcome.code, status, message);
        throw verifiedFailure;
      }
      if (response.status !== 200) throw new Error('Mandate success status mismatch');
      return await parseResult(input.action, result.outcome.data);
    } catch (error) {
      if (verifiedFailure && error === verifiedFailure) throw verifiedFailure;
      throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, safeErrors.DURABLE_SERVICE_UNAVAILABLE[1]);
    }
  }
  return {
    readDocument: async (token, responsibilityId, documentId, query, trace) => MandateDocumentReadSchema.parse(await exchange(token, { kind: 'document-read', responsibilityId, documentId, query }, trace)),
    list: async (token, responsibilityId, query, trace) => MandatePageSchema.parse(await exchange(token, { kind: 'list', responsibilityId, query }, trace)),
    review: async (token, responsibilityId, proposalId, query, trace) => MandateReviewSchema.parse(await exchange(token, { kind: 'review', responsibilityId, proposalId, query }, trace)),
    operation: async (token, query, trace) => MandateOperationResultSchema.parse(await exchange(token, { kind: 'operation', query }, trace)),
    createDocument: async (token, responsibilityId, key, command, trace) => MandateOperationResultSchema.parse(await exchange(token, { kind: 'document', responsibilityId, key, command }, trace)),
    propose: async (token, responsibilityId, key, command, trace) => MandateOperationResultSchema.parse(await exchange(token, { kind: 'propose', responsibilityId, key, command }, trace)),
    decide: async (token, responsibilityId, proposalId, key, command, trace) => MandateOperationResultSchema.parse(await exchange(token, { kind: 'decide', responsibilityId, proposalId, key, command }, trace)),
    control: async (token, responsibilityId, mandateId, key, command, trace) => MandateOperationResultSchema.parse(await exchange(token, { kind: 'control', responsibilityId, mandateId, key, command }, trace)),
  };
}
