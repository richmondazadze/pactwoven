import { z } from 'zod';
import { HashSchema, IdempotencyKeySchema } from '@pactwoven/contracts';
import { commandDigest, DomainError, immutable } from '@pactwoven/domain';
import { SupplierRelationshipHttpRequestSchema, SupplierRelationshipHttpResponseSchema, supplierRelationshipHttpRoutes,
  type SupplierRelationshipHttpGateway, type SupplierRelationshipHttpRequest } from '../../../packages/contracts/src/supplier-relationship-http.js';
import { readSupplierRelationshipJson, validateSupplierRelationshipHttpResponse } from './supplier-relationship-routes.js';
import { serviceJsonRequest } from './worker-service.js';
import type { ServiceBinding } from './worker-config.js';

export const supplierPrivateUrl = 'https://supplier.internal/v1/relationship';
const maximumBytes = 1024 * 1024;
const privateHeaders = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const inputSchema = z.strictObject({
  nonce: z.uuid(), source: z.strictObject({ url: z.string().min(1).max(4096), method: z.literal('POST'), key: IdempotencyKeySchema.nullable() }),
  request: SupplierRelationshipHttpRequestSchema,
});
type PrivateInput = z.infer<typeof inputSchema>;
const safeErrors = {
  AUTH_REQUIRED: [401, 'Sign in again to continue.'], FORBIDDEN: [403, 'Current organization membership is required.'],
  STEP_UP_REQUIRED: [403, 'Fresh verification of both factors is required.'],
  SETUP_REQUIRED: [503, 'Supplier operations are not configured.'],
  IDENTITY_UNAVAILABLE: [503, 'Identity verification is temporarily unavailable.'],
  SUPPLIER_INPUT_INVALID: [422, 'Use the exact supported supplier operation parameters.'],
  SUPPLIER_ACCESS_DENIED: [403, 'Current exact supplier access is required.'],
  SUPPLIER_VERIFICATION_REFUSED: [403, 'Current exact supplier authentication is required.'],
  SUPPLIER_VERIFICATION_UNAVAILABLE: [503, 'Supplier authentication is temporarily unavailable.'],
  SUPPLIER_APPROVER_REFUSED: [403, 'Exact current original approver membership is required.'],
  SUPPLIER_APPROVER_UNAVAILABLE: [503, 'Original approver membership verification is temporarily unavailable.'],
  SUPPLIER_OBSERVATION_EXPIRED: [409, 'Supplier verification expired. Obtain fresh verification for the original request.'],
  SUPPLIER_AUTHORITY_IMMUTABLE: [409, 'Supplier authority records cannot be replaced or removed.'],
  SUPPLIER_OUTCOME_UNKNOWN: [503, 'The supplier result is unconfirmed. Preserve the exact original request and use explicit recovery.'],
} as const;
type SafeErrorCode = keyof typeof safeErrors;
const codeSchema = z.enum(Object.keys(safeErrors) as [SafeErrorCode, ...SafeErrorCode[]]);
const responseSchema = z.strictObject({
  schemaVersion: z.literal(1), environment: z.literal('development'), issuer: z.url(),
  nonce: z.uuid(), tokenHash: HashSchema, requestHash: HashSchema, respondedAt: z.iso.datetime(),
  outcome: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ok'), data: SupplierRelationshipHttpResponseSchema }),
    z.strictObject({ status: z.literal('error'), code: codeSchema }),
  ]),
});
const unknown = () => new DomainError('SUPPLIER_OUTCOME_UNKNOWN', 503, safeErrors.SUPPLIER_OUTCOME_UNKNOWN[1]);
async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function validateRoute(input: PrivateInput) {
  const { source, request } = input, url = new URL(source.url), path = supplierRelationshipHttpRoutes[request.kind];
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw unknown();
  if (source.url !== url.origin + path || source.method !== 'POST' ||
      source.key !== ('mutation' in request ? request.mutation.idempotencyKey : null)) throw unknown();
  const pair = request.kind === 'policy-command' ? request.mutation.command.pair : request.kind === 'policy-read' ? request.query.policy.pair :
    request.kind === 'relationship-command' ? request.mutation.command.scope : request.kind === 'relationship-status' ? request.query.scope : request.query.identity.scope;
  if (pair.environment !== 'development') throw unknown();
}
async function affinity(input: PrivateInput, token: string) {
  return { nonce: input.nonce, tokenHash: await tokenHash(token), requestHash: await commandDigest(input) };
}

/** Only public request locators cross this boundary. Private evidence, database
 * handles and current actor/approver facts are created inside this Worker. */
export async function handlePrivateSupplierRequest(request: Request, issuer: string, createGateway: () => SupplierRelationshipHttpGateway): Promise<Response> {
  if (request.url !== supplierPrivateUrl || request.method !== 'POST') return new Response(null, { status: 404, headers: privateHeaders });
  const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401, headers: privateHeaders });
  let input: PrivateInput;
  try {
    input = immutable(inputSchema.parse(await readSupplierRelationshipJson(request, maximumBytes)));
    validateRoute(input);
  } catch { return Response.json({ error: { code: 'SUPPLIER_INPUT_INVALID' } }, { status: 422, headers: privateHeaders }); }
  const binding = await affinity(input, token);
  const respond = (outcome: z.infer<typeof responseSchema>['outcome'], status: number) => {
    const body = JSON.stringify(responseSchema.parse({ schemaVersion: 1, environment: 'development', issuer,
      ...binding, respondedAt: new Date().toISOString(), outcome }));
    if (new TextEncoder().encode(body).byteLength > maximumBytes) throw unknown();
    return new Response(body, { status, headers: privateHeaders });
  };
  try {
    const data = await validateSupplierRelationshipHttpResponse(input.request, await createGateway().submit(token, input.request));
    return respond({ status: 'ok', data }, 200);
  } catch (error) {
    const code = error instanceof DomainError && Object.hasOwn(safeErrors, error.code) &&
      safeErrors[error.code as SafeErrorCode][0] === error.status ? error.code as SafeErrorCode : 'SUPPLIER_OUTCOME_UNKNOWN';
    return respond({ status: 'error', code }, safeErrors[code][0]);
  }
}

/** Public adapter holds only a service binding. It never creates private
 * repositories, Clerk clients, evidence or transferable authentication handles. */
export function serviceSupplierRelationshipGateway(binding: ServiceBinding, originalRequest: Request, issuer: string): SupplierRelationshipHttpGateway {
  const authorization = originalRequest.headers.get('Authorization') ?? '';
  const source = Object.freeze({ url: originalRequest.url, method: originalRequest.method, key: originalRequest.headers.get('Idempotency-Key') });
  return Object.freeze({
    async submit(token: string, raw: SupplierRelationshipHttpRequest) {
      if (authorization !== `Bearer ${token}` || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) {
        throw new DomainError('AUTH_REQUIRED', 401, safeErrors.AUTH_REQUIRED[1]);
      }
      const startedAt = Date.now();
      let verifiedFailure: DomainError | undefined;
      try {
        const input = immutable(inputSchema.parse({ nonce: crypto.randomUUID(), source, request: raw }));
        validateRoute(input);
        const expected = await affinity(input, token), body = JSON.stringify(input);
        if (new TextEncoder().encode(body).byteLength > maximumBytes) throw unknown();
        const { response, data } = await serviceJsonRequest(binding, new Request(supplierPrivateUrl, { method: 'POST', redirect: 'manual',
          headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body }), maximumBytes);
        const result = responseSchema.parse(data), now = Date.now(), respondedAt = Date.parse(result.respondedAt);
        if (response.headers.get('Cache-Control') !== 'private, no-store' || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '') ||
            result.issuer !== issuer || result.nonce !== expected.nonce || result.tokenHash !== expected.tokenHash || result.requestHash !== expected.requestHash ||
            respondedAt < startedAt - 5_000 || respondedAt > now + 5_000 || now - respondedAt > 20_000) throw unknown();
        if (result.outcome.status === 'error') {
          const [status, message] = safeErrors[result.outcome.code];
          if (response.status !== status) throw unknown();
          verifiedFailure = new DomainError(result.outcome.code, status, message); throw verifiedFailure;
        }
        if (response.status !== 200) throw unknown();
        return await validateSupplierRelationshipHttpResponse(input.request, result.outcome.data);
      } catch (error) {
        if (verifiedFailure && error === verifiedFailure) throw verifiedFailure;
        throw unknown();
      }
    },
  });
}
