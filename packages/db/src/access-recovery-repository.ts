import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessRecoveryQuerySchema, AccessRecoveryResultSchema, CloseAccessRecoveryIntentSchema, CloseAccessRecoveryResultSchema,
  EnvironmentSchema, IdempotencyKeySchema, type AccessRecoveryQuery, type AccessRecoveryResult, type CloseAccessRecoveryIntent,
  type CloseAccessRecoveryResult, type Environment } from '@pactwoven/contracts';
import { commandDigest, DomainError } from '@pactwoven/domain';
import type { VerifiedIdentity } from './repository.js';
import { AccessRecoveryIdentitySchema, AccessRecoveryMfaEvidenceSchema, AccessRecoveryVerificationRequestSchema,
  type AccessRecoveryRepository, type VerifiedAccessRecoveryStepUpIdentity } from './access-recovery-schema.js';
import { assertAccessRecoveryReady } from './access-recovery-isolation.js';

const traceSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const unavailable = () => new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'The request outcome was not confirmed. Check the original reference again.');
function databaseError(error: unknown): never {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const mapped = {
    PA001: ['FORBIDDEN', 403, 'Current owner authority and the exact review scope are required.'],
    PA002: ['VERSION_CONFLICT', 409, 'Organization authority changed. Review closure again.'],
    PA003: ['IDEMPOTENCY_CONFLICT', 409, 'This request reference was already used for a different change.'],
    PA004: ['VALIDATION_FAILED', 422, 'Check the exact request reference and closure review.'],
    PA005: ['STEP_UP_REQUIRED', 403, 'Verify both authentication factors again before closing the request reference.'],
    PA006: ['ACCESS_KEY_FENCED', 409, 'This access request reference is closed. Check its original outcome.'],
  } as const;
  if (typeof code === 'string' && Object.hasOwn(mapped, code)) {
    const [name, status, message] = mapped[code as keyof typeof mapped]; throw new DomainError(name, status, message);
  }
  throw unavailable();
}
function validateAffinity(result: AccessRecoveryResult, identity: VerifiedIdentity, environment: Environment, query: AccessRecoveryQuery) {
  if (result.environment !== environment || result.externalOrganizationId !== identity.externalOrganizationId ||
      result.reviewer.externalMembershipId !== identity.externalMembershipId || result.kind !== query.kind || result.key !== query.key ||
      Date.parse(result.observedAt) > Date.now() + 1000 || Date.parse(result.observedAt) < Date.parse(identity.membershipObservedAt)) throw unavailable();
}

/** Function-only trusted private access boundary. The provider verifier is the evidence issuer. */
export class PostgresAccessRecoveryRepository implements AccessRecoveryRepository {
  private readonly environment: Environment;
  constructor(private readonly pool: Pool, environment: Environment) { this.environment = EnvironmentSchema.parse(environment); }

  async get(input: VerifiedIdentity, inputQuery: AccessRecoveryQuery, correlationId: string): Promise<AccessRecoveryResult> {
    const identity = AccessRecoveryIdentitySchema.parse(input), query = AccessRecoveryQuerySchema.parse(inputQuery); traceSchema.parse(correlationId);
    await assertAccessRecoveryReady(this.pool);
    try {
      const response = await this.pool.query<{ response: unknown }>('SELECT pactwoven.read_access_recovery($1,$2::jsonb,$3,$4) AS response',
        [this.environment, JSON.stringify(identity), query.kind, query.key]);
      const result = AccessRecoveryResultSchema.parse(response.rows[0]?.response); validateAffinity(result, identity, this.environment, query); return result;
    } catch (error) { return databaseError(error); }
  }

  async close(input: VerifiedAccessRecoveryStepUpIdentity, inputKey: string, inputIntent: CloseAccessRecoveryIntent, correlationId: string): Promise<CloseAccessRecoveryResult> {
    const intent = CloseAccessRecoveryIntentSchema.parse(inputIntent), key = IdempotencyKeySchema.parse(inputKey), identity = AccessRecoveryIdentitySchema.parse(input.identity);
    traceSchema.parse(correlationId);
    const parsed = AccessRecoveryMfaEvidenceSchema.safeParse(input.evidence);
    if (!parsed.success) throw new DomainError('STEP_UP_REQUIRED', 403, 'Exact genuine closure verification is required.');
    const evidence = parsed.data, scope = evidence.scope;
    if (intent.expectedEnvironment !== this.environment || scope.environment !== this.environment || intent.expectedOrganizationId !== scope.organizationId ||
        intent.expectedActorId !== scope.actorId || intent.expectedExternalMembershipId !== scope.externalMembershipId ||
        scope.externalOrganizationId !== identity.externalOrganizationId || scope.externalMembershipId !== identity.externalMembershipId) {
      throw new DomainError('FORBIDDEN', 403, 'The closure review must match current owner authority.');
    }
    const request = AccessRecoveryVerificationRequestSchema.parse({ nonce: evidence.requestNonce, key, intent, scope }), now = Date.now();
    if (evidence.key !== key || evidence.kind !== intent.kind || evidence.subject !== identity.subject || evidence.sessionId !== identity.sessionId ||
        evidence.externalOrganizationId !== identity.externalOrganizationId || evidence.externalMembershipId !== identity.externalMembershipId ||
        evidence.intentHash !== await commandDigest(intent) || evidence.requestHash !== await commandDigest({ schemaVersion: 1, purpose: evidence.purpose, request }) ||
        Date.parse(evidence.observedAt) > now || Date.parse(evidence.observedAt) < now - 20_000 || Date.parse(evidence.expiresAt) <= now) {
      throw new DomainError('STEP_UP_REQUIRED', 403, 'Fresh verification must match this exact closure request.');
    }
    await assertAccessRecoveryReady(this.pool);
    try {
      const response = await this.pool.query<{ response: unknown }>('SELECT pactwoven.close_access_recovery($1,$2::jsonb,$3::jsonb,$4,$5::jsonb,$6) AS response',
        [this.environment, JSON.stringify(identity), JSON.stringify(evidence), key, JSON.stringify(intent), correlationId]);
      const result = CloseAccessRecoveryResultSchema.parse(response.rows[0]?.response);
      validateAffinity(result, identity, this.environment, { kind: intent.kind, key });
      if (result.organizationId !== scope.organizationId || result.reviewer.actorId !== scope.actorId) throw unavailable();
      return result;
    } catch (error) { return databaseError(error); }
  }
}
