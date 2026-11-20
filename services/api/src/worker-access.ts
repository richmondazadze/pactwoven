import { z } from 'zod';
import { AccessQuerySchema, AccessOperationQuerySchema, GrantAccessCommandSchema, ReviseAccessCommandSchema, RevokeAccessCommandSchema,
  MemberAccessPageSchema, MemberCandidatePageSchema, OperationSchema, IdSchema, IdempotencyKeySchema } from '@pactwoven/contracts';
import { commandDigest, DomainError } from '@pactwoven/domain';
import type { AccessGateway } from './access-service.js';
import type { ServiceBinding } from './worker-config.js';
import { privateDeadline, readPrivateJson, serviceJsonRequest } from './worker-service.js';

export const accessUrl = 'https://pactwoven-provisioner.internal/internal/access/dispatch';
const requestBytes = 64 * 1024;
// A page can contain 100 members with two arrays of 100 bounded site identifiers.
export const accessResponseBytes = 4 * 1024 * 1024;
const requestContextSchema = z.strictObject({ url: z.string().url().max(2048), method: z.enum(['GET', 'POST']),
  correlationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('members'), query: AccessQuerySchema }),
  z.strictObject({ kind: z.literal('candidates'), query: AccessQuerySchema }),
  z.strictObject({ kind: z.literal('operation'), query: AccessOperationQuerySchema }),
  z.strictObject({ kind: z.literal('grant'), key: IdempotencyKeySchema, command: GrantAccessCommandSchema }),
  z.strictObject({ kind: z.literal('revise'), actorId: IdSchema, key: IdempotencyKeySchema, command: ReviseAccessCommandSchema }),
  z.strictObject({ kind: z.literal('revoke'), actorId: IdSchema, key: IdempotencyKeySchema, command: RevokeAccessCommandSchema }),
]);
const requestSchema = z.strictObject({ nonce: z.uuid(), request: requestContextSchema, action: actionSchema });
type AccessRequest = z.infer<typeof requestSchema>;
type AccessAction = z.infer<typeof actionSchema>;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const safeErrors = {
  AUTH_REQUIRED: [401, 'Sign in again to continue.'],
  FORBIDDEN: [403, 'Current owner access and an accepted organization membership are required.'],
  STEP_UP_REQUIRED: [403, 'Verify both authentication factors again before changing access.'],
  NOT_FOUND: [404, 'The requested access record was not found.'],
  VERSION_CONFLICT: [409, 'Access or organization authority changed. Refresh before reviewing again.'],
  IDEMPOTENCY_CONFLICT: [409, 'This request key was already used for a different change.'],
  ACCESS_KEY_FENCED: [409, 'This access request reference is closed. Check its original outcome.'],
  VALIDATION_FAILED: [422, 'Check the member access details.'],
  IDENTITY_UNAVAILABLE: [503, 'Identity verification is temporarily unavailable.'],
  DURABLE_SERVICE_UNAVAILABLE: [503, 'Member access was not confirmed. Check the original operation before trying again.'],
} as const;
const errorCodeSchema = z.enum(Object.keys(safeErrors) as [keyof typeof safeErrors, ...(keyof typeof safeErrors)[]]);
const responseSchema = z.strictObject({
  schemaVersion: z.literal(1), environment: z.literal('development'), issuer: z.string().url(), nonce: z.uuid(),
  tokenHash: hashSchema, requestHash: hashSchema, request: requestContextSchema,
  kind: z.enum(['members', 'candidates', 'operation', 'grant', 'revise', 'revoke']),
  actorId: IdSchema.nullable(), key: IdempotencyKeySchema.nullable(), commandHash: hashSchema,
  respondedAt: z.iso.datetime(),
  outcome: z.discriminatedUnion('status', [
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
async function affinity(input: AccessRequest, token: string) {
  return { nonce: input.nonce, tokenHash: await tokenDigest(token), requestHash: await commandDigest(input),
    request: input.request, kind: input.action.kind,
    actorId: 'actorId' in input.action ? input.action.actorId : null,
    key: 'key' in input.action ? input.action.key : input.action.kind === 'operation' ? input.action.query.key : null,
    commandHash: await commandDigest('command' in input.action ? input.action.command : input.action.query) };
}
async function validateRoute(input: AccessRequest): Promise<void> {
  const { action, request } = input, url = new URL(request.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid source URL');
  const path = action.kind === 'members' ? '/v1/members' : action.kind === 'candidates' ? '/v1/members/candidates'
    : action.kind === 'operation' ? '/v1/member-access/operations' : action.kind === 'grant' ? '/v1/members/grant'
    : `/v1/members/${action.actorId}/${action.kind === 'revise' ? 'revise-access' : 'revoke'}`;
  const read = 'query' in action;
  if (url.pathname !== path || request.method !== (read ? 'GET' : 'POST')) throw new Error('Access route mismatch');
  if (!read && url.search) throw new Error('Unexpected command query');
  if (read) {
    const entries = [...url.searchParams];
    if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error('Duplicate query');
    const query = (action.kind === 'operation' ? AccessOperationQuerySchema : AccessQuerySchema).parse(Object.fromEntries(entries));
    if (await commandDigest(query) !== await commandDigest(action.query)) throw new Error('Access query mismatch');
  }
}
function parseResult(action: AccessAction, value: unknown): unknown {
  if (action.kind === 'members') return MemberAccessPageSchema.parse(value);
  if (action.kind === 'candidates') return MemberCandidatePageSchema.parse(value);
  const operation = OperationSchema.parse(value);
  if (operation.environment !== 'development' || operation.financialState !== null ||
      ('actorId' in action && operation.aggregateId !== action.actorId)) throw new Error('Access operation mismatch');
  if (operation.error !== null && operation.error.code !== 'OUTCOME_UNKNOWN') errorCodeSchema.parse(operation.error.code);
  // Pending/unknown operation truth is deliberately retained without retry.
  return operation;
}
async function dispatch(gateway: AccessGateway, token: string, input: AccessRequest): Promise<unknown> {
  const a = input.action, trace = input.request.correlationId;
  switch (a.kind) {
    case 'members': return gateway.listMembers(token, a.query, trace);
    case 'candidates': return gateway.listCandidates(token, a.query, trace);
    case 'operation': return gateway.getOperation(token, a.query, trace);
    case 'grant': return gateway.grant(token, a.key, a.command, trace);
    case 'revise': return gateway.revise(token, a.actorId, a.key, a.command, trace);
    case 'revoke': return gateway.revoke(token, a.actorId, a.key, a.command, trace);
  }
}

/** Only an original signed token and an exact command/query enter this boundary.
 * The private gateway independently derives identity and fresh MFA evidence. */
export async function handlePrivateAccessRequest(request: Request, issuer: string, gateway: AccessGateway): Promise<Response> {
  if (request.url !== accessUrl || request.method !== 'POST') return new Response(null, { status: 404, headers: privateHeaders });
  const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401, headers: privateHeaders });
  let input: AccessRequest;
  try {
    const length = request.headers.get('Content-Length');
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '') ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > requestBytes))) throw new Error('Invalid intake');
    input = requestSchema.parse(await privateDeadline(5_000, signal => readPrivateJson(request.body, signal, requestBytes)));
    await validateRoute(input);
  } catch { return Response.json({ error: { code: 'VALIDATION_FAILED' } }, { status: 422, headers: privateHeaders }); }
  const binding = await affinity(input, token);
  const respond = (outcome: z.infer<typeof responseSchema>['outcome'], status: number) => {
    const body = JSON.stringify(responseSchema.parse({ schemaVersion: 1, environment: 'development', issuer,
      ...binding, respondedAt: new Date().toISOString(), outcome }));
    if (new TextEncoder().encode(body).byteLength > accessResponseBytes) throw new Error('Oversized result');
    return new Response(body, { status, headers: privateHeaders });
  };
  try {
    const data = parseResult(input.action, await dispatch(gateway, token, input));
    return respond({ status: 'ok', data }, 200);
  } catch (error) {
    const code = error instanceof DomainError && Object.hasOwn(safeErrors, error.code) &&
      safeErrors[error.code as keyof typeof safeErrors][0] === error.status ? error.code as keyof typeof safeErrors
      : 'DURABLE_SERVICE_UNAVAILABLE';
    return respond({ status: 'error', code }, safeErrors[code][0]);
  }
}

/** No runtime import of the Clerk-backed gateway is permitted in this adapter. */
export function serviceAccessGateway(binding: ServiceBinding, originalRequest: Request, issuer: string): AccessGateway {
  const authorization = originalRequest.headers.get('Authorization') ?? '';
  async function exchange(token: string, action: AccessAction, correlationId: string): Promise<unknown> {
    if (authorization !== `Bearer ${token}` || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) {
      throw new DomainError('AUTH_REQUIRED', 401, safeErrors.AUTH_REQUIRED[1]);
    }
    const startedAt = Date.now();
    let verifiedFailure: DomainError | undefined;
    try {
      const input = requestSchema.parse({ nonce: crypto.randomUUID(), request: { url: originalRequest.url,
        method: originalRequest.method, correlationId }, action });
      await validateRoute(input);
      if ('key' in action && originalRequest.headers.get('Idempotency-Key') !== action.key) throw new Error('Command key mismatch');
      const expected = await affinity(input, token);
      const { response, data } = await serviceJsonRequest(binding, new Request(accessUrl, { method: 'POST', redirect: 'manual',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), accessResponseBytes);
      const result = responseSchema.parse(data), now = Date.now(), respondedAt = Date.parse(result.respondedAt);
      if (response.headers.get('Cache-Control') !== 'private, no-store' ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '') || result.issuer !== issuer ||
          respondedAt < startedAt - 5_000 || respondedAt > now + 5_000 || now - respondedAt > 20_000 ||
          await commandDigest({ nonce: result.nonce, tokenHash: result.tokenHash, requestHash: result.requestHash,
            request: result.request, kind: result.kind, actorId: result.actorId, key: result.key, commandHash: result.commandHash }) !== await commandDigest(expected)) {
        throw new Error('Access response affinity failed');
      }
      if (result.outcome.status === 'error') {
        const [status, message] = safeErrors[result.outcome.code];
        if (response.status !== status) throw new Error('Access error status mismatch');
        verifiedFailure = new DomainError(result.outcome.code, status, message);
        throw verifiedFailure;
      }
      if (response.status !== 200) throw new Error('Access success status mismatch');
      return parseResult(action, result.outcome.data);
    } catch (error) {
      if (verifiedFailure && error === verifiedFailure) throw verifiedFailure;
      throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, safeErrors.DURABLE_SERVICE_UNAVAILABLE[1]);
    }
  }
  return {
    listMembers: async (token, query, trace) => MemberAccessPageSchema.parse(await exchange(token, { kind: 'members', query }, trace)),
    listCandidates: async (token, query, trace) => MemberCandidatePageSchema.parse(await exchange(token, { kind: 'candidates', query }, trace)),
    getOperation: async (token, query, trace) => OperationSchema.parse(await exchange(token, { kind: 'operation', query }, trace)),
    grant: async (token, key, command, trace) => OperationSchema.parse(await exchange(token, { kind: 'grant', key, command }, trace)),
    revise: async (token, actorId, key, command, trace) => OperationSchema.parse(await exchange(token, { kind: 'revise', actorId, key, command }, trace)),
    revoke: async (token, actorId, key, command, trace) => OperationSchema.parse(await exchange(token, { kind: 'revoke', actorId, key, command }, trace)),
  };
}
