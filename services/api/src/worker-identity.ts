import { z } from 'zod';
import type { VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import type { IdentityVerifier } from './auth.js';
import type { ServiceBinding } from './worker-config.js';
import { privateDeadline, readPrivateJson, serviceJsonRequest } from './worker-service.js';

export const identityUrl = 'https://pactwoven-provisioner.internal/internal/identity/verify';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const VerifiedWorkerIdentitySchema = z.strictObject({
  subject: id, externalOrganizationId: id, externalOrganizationName: z.string().trim().min(1).max(180),
  externalMembershipId: id, externalRole: z.string().min(1).max(128), membershipObservedAt: z.iso.datetime(),
  sessionId: z.string().min(1).max(256), authenticatedAt: z.iso.datetime(),
}) satisfies z.ZodType<VerifiedIdentity>;
const requestSchema = z.strictObject({ nonce: z.uuid() });
const responseSchema = z.strictObject({ schemaVersion: z.literal(1), environment: z.literal('development'),
  issuer: z.string().url(), nonce: z.uuid(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/), verifiedAt: z.iso.datetime(),
  identity: VerifiedWorkerIdentitySchema });

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function errorResponse(code: 'AUTH_REQUIRED' | 'FORBIDDEN' | 'IDENTITY_UNAVAILABLE' | 'VALIDATION_FAILED', status: number) {
  return Response.json({ error: { code } }, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** Caller inputs can supply only a nonce and a signed token. All identity fields
 * are obtained by the private verifier after bounded body intake. */
export async function verifyPrivateIdentityRequest(request: Request, issuer: string, verify: IdentityVerifier): Promise<Response> {
  const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) return errorResponse('AUTH_REQUIRED', 401);
  const length = request.headers.get('Content-Length');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '') ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024))) return errorResponse('VALIDATION_FAILED', 422);
  let nonce: string;
  try {
    ({ nonce } = requestSchema.parse(await privateDeadline(5_000, signal => readPrivateJson(request.body, signal, 1024))));
  } catch { return errorResponse('VALIDATION_FAILED', 422); }
  try {
    const hash = await tokenHash(token);
    const identity = VerifiedWorkerIdentitySchema.parse(await verify(token));
    const response = responseSchema.parse({ schemaVersion: 1, environment: 'development', issuer, nonce, tokenHash: hash,
      verifiedAt: new Date().toISOString(), identity });
    return Response.json(response, { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'AUTH_REQUIRED' || error.code === 'FORBIDDEN')) return errorResponse(error.code, error.status);
    return errorResponse('IDENTITY_UNAVAILABLE', 503);
  }
}

/** The public Worker has no Clerk administrative key. A response must match the
 * original token, this request's nonce, expected issuer and a fresh observation. */
export function serviceIdentityVerifier(binding: ServiceBinding, originalAuthorization: string, issuer: string): IdentityVerifier {
  return async token => {
    if (originalAuthorization !== `Bearer ${token}`) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.');
    const startedAt = Date.now();
    let verifiedFailure: DomainError | undefined;
    try {
      const nonce = crypto.randomUUID();
      const hash = await tokenHash(token);
      const { response, data } = await serviceJsonRequest(binding, new Request(identityUrl, {
        method: 'POST', redirect: 'manual', headers: { Authorization: originalAuthorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      }), 8 * 1024);
      if (response.status !== 200) {
        const error = z.strictObject({ error: z.strictObject({ code: z.enum(['AUTH_REQUIRED', 'FORBIDDEN', 'IDENTITY_UNAVAILABLE', 'VALIDATION_FAILED']) }) }).safeParse(data);
        if (error.success && error.data.error.code === 'AUTH_REQUIRED' && response.status === 401) verifiedFailure = new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.');
        if (error.success && error.data.error.code === 'FORBIDDEN' && response.status === 403) verifiedFailure = new DomainError('FORBIDDEN', 403, 'Your selected organization membership is not active.');
        if (verifiedFailure) throw verifiedFailure;
        throw new Error('Private identity was not confirmed');
      }
      const result = responseSchema.parse(data);
      const verifiedAt = Date.parse(result.verifiedAt), membershipAt = Date.parse(result.identity.membershipObservedAt);
      if (result.nonce !== nonce || result.tokenHash !== hash || result.issuer !== issuer ||
          verifiedAt < startedAt - 5_000 || verifiedAt > Date.now() + 5_000 || Date.now() - verifiedAt > 20_000 ||
          membershipAt > verifiedAt || verifiedAt - membershipAt > 20_000 || Date.parse(result.identity.authenticatedAt) > verifiedAt) {
        throw new Error('Private identity response does not match this request');
      }
      return result.identity;
    } catch (error) {
      if (verifiedFailure && error === verifiedFailure) throw verifiedFailure;
      throw new DomainError('IDENTITY_UNAVAILABLE', 503, 'Identity verification is temporarily unavailable.');
    }
  };
}
