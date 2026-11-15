import { z } from 'zod';
import { AccessRecoveryQuerySchema, AccessRecoveryResultSchema, CloseAccessRecoveryIntentSchema,
  CloseAccessRecoveryResultSchema, EnvironmentSchema, IdempotencyKeySchema, type AccessRecoveryGateway,
  type AccessRecoveryQuery, type AccessRecoveryResult, type Environment } from '@pactwoven/contracts';
import { AccessRecoveryAuthorityScopeSchema, AccessRecoveryIdentitySchema, AccessRecoveryMfaEvidenceSchema,
  AccessRecoveryVerificationRequestSchema, type AccessRecoveryRepository, type VerifiedIdentity } from '@pactwoven/db';
import { canonicalJson, commandDigest, DomainError } from '@pactwoven/domain';
import type { AccessRecoveryStepUpIdentityVerifier, IdentityVerifier } from './auth.js';

export type AccessRecoveryGatewayDependencies = {
  environment: Environment; repository: AccessRecoveryRepository; verifyIdentity: IdentityVerifier;
  verifyRecoveryStepUp: AccessRecoveryStepUpIdentityVerifier; requestNonce?: string;
};
function unavailable(): never {
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'The original access request could not be verified. Check its result again.');
}
function sameIdentity(before: VerifiedIdentity, after: VerifiedIdentity) {
  if (before.subject !== after.subject || before.externalOrganizationId !== after.externalOrganizationId ||
      before.externalMembershipId !== after.externalMembershipId || before.sessionId !== after.sessionId || before.externalRole !== after.externalRole) {
    throw new DomainError('AUTH_REQUIRED', 401, 'The recovery session changed. Sign in and review again.');
  }
}
function qualify(input: unknown, environment: Environment, identity: VerifiedIdentity, query: AccessRecoveryQuery): AccessRecoveryResult {
  const parsed = AccessRecoveryResultSchema.safeParse(input);
  if (!parsed.success) unavailable();
  const result = parsed.data;
  if (result.environment !== environment || result.externalOrganizationId !== identity.externalOrganizationId ||
      result.reviewer.externalMembershipId !== identity.externalMembershipId || result.kind !== query.kind || result.key !== query.key) unavailable();
  return result;
}

/** Current-owner recovery has its own purpose and never recovers or executes a lost original command. */
export function createAccessRecoveryGateway(dependencies: AccessRecoveryGatewayDependencies): AccessRecoveryGateway {
  const environment = EnvironmentSchema.parse(dependencies.environment);
  const boundNonce = dependencies.requestNonce === undefined ? undefined : z.uuid().parse(dependencies.requestNonce);
  const { repository, verifyIdentity, verifyRecoveryStepUp } = dependencies;
  const verify = async (token: string) => AccessRecoveryIdentitySchema.parse(await verifyIdentity(token));
  return {
    async get(token, input, trace) {
      const query = AccessRecoveryQuerySchema.parse(input), identity = await verify(token);
      return qualify(await repository.get(identity, query, trace), environment, identity, query);
    },
    async close(token, inputKey, input, trace) {
      const key = IdempotencyKeySchema.parse(inputKey), intent = CloseAccessRecoveryIntentSchema.parse(input);
      const query = AccessRecoveryQuerySchema.parse({ kind: intent.kind, key }), identity = await verify(token);
      const original = qualify(await repository.get(identity, query, trace), environment, identity, query);
      const scope = AccessRecoveryAuthorityScopeSchema.parse({ environment: original.environment,
        organizationId: original.organizationId, actorId: original.reviewer.actorId,
        externalOrganizationId: original.externalOrganizationId, externalMembershipId: original.reviewer.externalMembershipId });
      if (intent.expectedEnvironment !== scope.environment || intent.expectedOrganizationId !== scope.organizationId ||
          intent.expectedActorId !== scope.actorId || intent.expectedExternalMembershipId !== scope.externalMembershipId) {
        throw new DomainError('FORBIDDEN', 403, 'Refresh the current owner review before closing this request key.');
      }
      // Existing records still require fresh close verification. Epoch equality belongs only to new fence creation.
      const requestNonce = boundNonce ?? crypto.randomUUID();
      const request = AccessRecoveryVerificationRequestSchema.parse({ nonce: requestNonce, key, intent, scope });
      const intentHash = await commandDigest(intent);
      const requestHash = await commandDigest({ schemaVersion: 1, purpose: 'member_access_recovery_close', request });
      const verified = await verifyRecoveryStepUp(token, request);
      const currentIdentity = AccessRecoveryIdentitySchema.parse(verified.identity); sameIdentity(identity, currentIdentity);
      const proof = AccessRecoveryMfaEvidenceSchema.safeParse(verified.evidence);
      if (!proof.success) throw new DomainError('STEP_UP_REQUIRED', 403, 'Fresh recovery-specific verification is required.');
      const evidence = proof.data;
      if (evidence.subject !== currentIdentity.subject || evidence.externalOrganizationId !== currentIdentity.externalOrganizationId ||
          evidence.externalMembershipId !== currentIdentity.externalMembershipId || evidence.sessionId !== currentIdentity.sessionId ||
          evidence.key !== key || evidence.kind !== intent.kind || evidence.requestNonce !== requestNonce ||
          canonicalJson(evidence.scope) !== canonicalJson(scope) || evidence.intentHash !== intentHash || evidence.requestHash !== requestHash) {
        throw new DomainError('STEP_UP_REQUIRED', 403, 'Verification must match this exact recovery close review.');
      }
      const raw = await repository.close({ identity: currentIdentity, evidence }, key, intent, trace);
      const parsed = CloseAccessRecoveryResultSchema.safeParse(raw);
      if (!parsed.success) unavailable();
      const result = qualify(parsed.data, environment, currentIdentity, query);
      if (result.organizationId !== scope.organizationId || result.reviewer.actorId !== scope.actorId || result.disposition === 'not_recorded') unavailable();
      return result;
    },
  };
}
