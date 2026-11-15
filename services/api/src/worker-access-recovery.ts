import { z } from 'zod';
import { AccessRecoveryQuerySchema, AccessRecoveryResultSchema, CloseAccessRecoveryIntentSchema, CloseAccessRecoveryResultSchema,
  HashSchema, IdempotencyKeySchema, type AccessRecoveryGateway } from '@pactwoven/contracts';
import { commandDigest, DomainError } from '@pactwoven/domain';
import type { ServiceBinding } from './worker-config.js';
import { privateDeadline, readPrivateJson, serviceJsonRequest } from './worker-service.js';

export const accessRecoveryUrl = 'https://pactwoven-provisioner.internal/internal/access-recovery/dispatch';
export const accessRecoveryRequestBytes = 16 * 1024;
export const accessRecoveryResponseBytes = 64 * 1024;
const requestContextSchema = z.strictObject({ url: z.string().url().max(2048), method: z.enum(['GET', 'POST']),
  correlationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('get'), query: AccessRecoveryQuerySchema }),
  z.strictObject({ kind: z.literal('close'), key: IdempotencyKeySchema, intent: CloseAccessRecoveryIntentSchema }),
]);
const requestSchema = z.strictObject({ nonce: z.uuid(), request: requestContextSchema, action: actionSchema });
type RecoveryRequest = z.infer<typeof requestSchema>;
type RecoveryAction = z.infer<typeof actionSchema>;
const safeErrors = {
  AUTH_REQUIRED: [401, 'Sign in again to continue.'],
  FORBIDDEN: [403, 'Current owner authority and the exact recovery review are required.'],
  STEP_UP_REQUIRED: [403, 'Verify both authentication factors again before closing the request reference.'],
  NOT_FOUND: [404, 'The requested access record was not found.'],
  VERSION_CONFLICT: [409, 'Organization authority changed. Review closure again.'],
  IDEMPOTENCY_CONFLICT: [409, 'This request reference was already used for a different change.'],
  ACCESS_KEY_FENCED: [409, 'This access request reference is closed. Check its original outcome.'],
  VALIDATION_FAILED: [422, 'Check the exact request reference and closure review.'],
  SETUP_REQUIRED: [503, 'Durable request closure is not configured.'],
  IDENTITY_UNAVAILABLE: [503, 'Identity verification is temporarily unavailable.'],
  DURABLE_SERVICE_UNAVAILABLE: [503, 'The request outcome was not confirmed. Check the original reference again.'],
} as const;
const errorCodeSchema = z.enum(Object.keys(safeErrors) as [keyof typeof safeErrors, ...(keyof typeof safeErrors)[]]);
const responseSchema = z.strictObject({
  schemaVersion: z.literal(1), environment: z.literal('development'), issuer: z.string().url(), nonce: z.uuid(),
  tokenHash: HashSchema, requestHash: HashSchema, request: requestContextSchema,
  action: z.enum(['get', 'close']), kind: AccessRecoveryQuerySchema.shape.kind, key: IdempotencyKeySchema, intentHash: HashSchema.nullable(),
  respondedAt: z.iso.datetime(), outcome: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ok'), data: z.unknown() }),
    z.strictObject({ status: z.literal('error'), code: errorCodeSchema }),
  ]),
});
const privateHeaders = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
async function tokenDigest(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function affinity(input: RecoveryRequest, token: string) {
  const action = input.action;
  return { nonce: input.nonce, tokenHash: await tokenDigest(token), requestHash: await commandDigest(input), request: input.request,
    action: action.kind, kind: action.kind === 'get' ? action.query.kind : action.intent.kind,
    key: action.kind === 'get' ? action.query.key : action.key, intentHash: action.kind === 'get' ? null : await commandDigest(action.intent) };
}
async function validateRoute(input: RecoveryRequest) {
  const { action, request } = input, url = new URL(request.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid source URL');
  if (action.kind === 'get') {
    if (url.pathname !== '/v1/member-access/recovery' || request.method !== 'GET') throw new Error('Recovery route mismatch');
    const entries = [...url.searchParams];
    if (new Set(entries.map(([name]) => name)).size !== entries.length ||
        await commandDigest(AccessRecoveryQuerySchema.parse(Object.fromEntries(entries))) !== await commandDigest(action.query)) throw new Error('Recovery query mismatch');
  } else if (url.pathname !== '/v1/member-access/recovery/close' || request.method !== 'POST' || url.search ||
      action.intent.expectedEnvironment !== 'development') throw new Error('Closure route mismatch');
}
function parseResult(action: RecoveryAction, value: unknown, earliest: number, latest: number) {
  const result = action.kind === 'get' ? AccessRecoveryResultSchema.parse(value) : CloseAccessRecoveryResultSchema.parse(value);
  const kind = action.kind === 'get' ? action.query.kind : action.intent.kind, key = action.kind === 'get' ? action.query.key : action.key;
  const observedAt = Date.parse(result.observedAt);
  if (result.environment !== 'development' || result.kind !== kind || result.key !== key || observedAt < earliest - 5000 ||
      observedAt > latest + 5000 || latest - observedAt > 20_000) throw new Error('Recovery result does not match this observation');
  if (action.kind === 'close' && (result.organizationId !== action.intent.expectedOrganizationId ||
      result.reviewer.actorId !== action.intent.expectedActorId || result.reviewer.externalMembershipId !== action.intent.expectedExternalMembershipId)) throw new Error('Closure reviewer mismatch');
  // A newer current epoch is permitted when the original operation or fence already exists.
  if (result.disposition === 'recorded' && result.operation.error !== null && result.operation.error.code !== 'OUTCOME_UNKNOWN') errorCodeSchema.parse(result.operation.error.code);
  return result;
}
function dispatch(gateway: AccessRecoveryGateway, token: string, input: RecoveryRequest) {
  const action = input.action;
  return action.kind === 'get' ? gateway.get(token, action.query, input.request.correlationId)
    : gateway.close(token, action.key, action.intent, input.request.correlationId);
}

/** The factory binds the validated outer nonce to the private verifier; JSON cannot submit evidence. */
export async function handlePrivateAccessRecoveryRequest(request: Request, issuer: string, createGateway: (requestNonce: string) => AccessRecoveryGateway): Promise<Response> {
  if (request.url !== accessRecoveryUrl || request.method !== 'POST') return new Response(null, { status: 404, headers: privateHeaders });
  const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401, headers: privateHeaders });
  const startedAt = Date.now(); let input: RecoveryRequest;
  try {
    const length = request.headers.get('Content-Length');
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '') ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > accessRecoveryRequestBytes))) throw new Error('Invalid intake');
    input = requestSchema.parse(await privateDeadline(5000, signal => readPrivateJson(request.body, signal, accessRecoveryRequestBytes)));
    await validateRoute(input);
  } catch { return Response.json({ error: { code: 'VALIDATION_FAILED' } }, { status: 422, headers: privateHeaders }); }
  const binding = await affinity(input, token);
  const respond = (outcome: z.infer<typeof responseSchema>['outcome'], status: number) => {
    const body = JSON.stringify(responseSchema.parse({ schemaVersion: 1, environment: 'development', issuer, ...binding,
      respondedAt: new Date().toISOString(), outcome }));
    if (new TextEncoder().encode(body).byteLength > accessRecoveryResponseBytes) throw new Error('Oversized result');
    return new Response(body, { status, headers: privateHeaders });
  };
  try {
    const value = await dispatch(createGateway(input.nonce), token, input);
    return respond({ status: 'ok', data: parseResult(input.action, value, startedAt, Date.now()) }, 200);
  } catch (error) {
    const code = error instanceof DomainError && Object.hasOwn(safeErrors, error.code) && safeErrors[error.code as keyof typeof safeErrors][0] === error.status
      ? error.code as keyof typeof safeErrors : 'DURABLE_SERVICE_UNAVAILABLE';
    return respond({ status: 'error', code }, safeErrors[code][0]);
  }
}

/** Public adapter: no repository, private evidence, Clerk client or privileged gateway implementation. */
export function serviceAccessRecoveryGateway(binding: ServiceBinding, originalRequest: Request, issuer: string): AccessRecoveryGateway {
  const authorization = originalRequest.headers.get('Authorization') ?? '';
  async function exchange(token: string, action: RecoveryAction, correlationId: string) {
    if (authorization !== `Bearer ${token}` || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new DomainError('AUTH_REQUIRED', 401, safeErrors.AUTH_REQUIRED[1]);
    const startedAt = Date.now(); let verifiedFailure: DomainError | undefined;
    try {
      const input = requestSchema.parse({ nonce: crypto.randomUUID(), request: { url: originalRequest.url, method: originalRequest.method, correlationId }, action });
      await validateRoute(input);
      if (input.action.kind === 'close' && originalRequest.headers.get('Idempotency-Key') !== input.action.key) throw new Error('Closure key mismatch');
      const expected = await affinity(input, token);
      const { response, data } = await serviceJsonRequest(binding, new Request(accessRecoveryUrl, { method: 'POST', redirect: 'error',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), accessRecoveryResponseBytes);
      const result = responseSchema.parse(data), now = Date.now(), respondedAt = Date.parse(result.respondedAt);
      if (response.headers.get('Cache-Control') !== 'private, no-store' || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '') ||
          result.issuer !== issuer || respondedAt < startedAt - 5000 || respondedAt > now + 5000 || now - respondedAt > 20_000 ||
          await commandDigest({ nonce: result.nonce, tokenHash: result.tokenHash, requestHash: result.requestHash, request: result.request,
            action: result.action, kind: result.kind, key: result.key, intentHash: result.intentHash }) !== await commandDigest(expected)) throw new Error('Recovery response affinity failed');
      if (result.outcome.status === 'error') {
        const [status, message] = safeErrors[result.outcome.code];
        if (response.status !== status) throw new Error('Recovery error status mismatch');
        verifiedFailure = new DomainError(result.outcome.code, status, message); throw verifiedFailure;
      }
      if (response.status !== 200) throw new Error('Recovery success status mismatch');
      const recovered = parseResult(input.action, result.outcome.data, startedAt, now);
      if (Date.parse(recovered.observedAt) > respondedAt + 5000) throw new Error('Recovery observation follows the response');
      return recovered;
    } catch (error) {
      if (verifiedFailure && error === verifiedFailure) throw verifiedFailure;
      throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, safeErrors.DURABLE_SERVICE_UNAVAILABLE[1]);
    }
  }
  return {
    get: async (token, query, trace) => AccessRecoveryResultSchema.parse(await exchange(token, { kind: 'get', query }, trace)),
    close: async (token, key, intent, trace) => CloseAccessRecoveryResultSchema.parse(await exchange(token, { kind: 'close', key, intent }, trace)),
  };
}
