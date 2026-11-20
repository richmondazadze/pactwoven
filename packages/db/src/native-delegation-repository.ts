import { Pool } from 'pg';
import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdSchema, InstantSchema, type ActorContext, type Environment } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { NativeAdvisoryGrantSchema, NativeAdvisoryHandoffSchema, NativeAdvisoryResultSchema, NativeDelegationArtifactReferenceSchema,
  NativeDelegationReferenceSchema, NativeServiceIdentitySchema, RevokeNativeDelegationSchema,
  type NativeAdvisoryGrant, type NativeAdvisoryHandoff, type NativeAdvisoryResult, type NativeServiceIdentity,
  type NativeDelegationArtifactReference, type RevokeNativeDelegation } from '../../contracts/src/native-delegation';

const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const NativeDelegationTargetSchema = z.strictObject({ organizationId: IdSchema, taskId: IdSchema, generation: Revision });
export const NativeDelegationClaimSelectorSchema = NativeDelegationTargetSchema.extend({ handoffId: IdSchema.nullable(), leaseToken: z.uuid() });
export type NativeDelegationTarget = z.infer<typeof NativeDelegationTargetSchema>;
export type NativeDelegationClaimSelector = z.infer<typeof NativeDelegationClaimSelectorSchema>;
const IssuanceSchema = z.strictObject({ rootTaskId: IdSchema, service: NativeServiceIdentitySchema, sessionVerifiedAt: InstantSchema, sessionExpiresAt: InstantSchema });
export type NativeDelegationStoredIssuance = z.infer<typeof IssuanceSchema>;
const PublicationSchema = z.strictObject({ result: NativeAdvisoryResultSchema,
  artifacts: z.array(z.strictObject({ reference: NativeDelegationArtifactReferenceSchema, body: z.record(z.string(), z.unknown()) })).max(32),
  inputArtifacts: z.array(NativeDelegationArtifactReferenceSchema).max(32),
  memoryUsage: z.array(z.strictObject({ usageId: z.uuid(), selectionDigest: z.string().regex(/^[a-f0-9]{64}$/) })).max(128),
});
export type NativeDelegationPublication = { result: NativeAdvisoryResult; artifacts: Array<{ reference: NativeDelegationArtifactReference; body: Record<string, unknown> }>;
  inputArtifacts: NativeDelegationArtifactReference[]; memoryUsage: Array<{ usageId: string; selectionDigest: string }> };
const Receipt = z.strictObject({ kind: z.enum(['accepted', 'duplicate']), execution: z.enum(['advisory_only', 'none']), digest: z.string().regex(/^[a-f0-9]{64}$/) });
const ResultReceipt = Receipt.omit({ digest: true }).extend({ publicationDigest: z.string().regex(/^[a-f0-9]{64}$/), domainCompletion: z.literal(false) });
const IssueResult = z.strictObject({ kind: z.enum(['issued', 'duplicate']), grant: NativeAdvisoryGrantSchema, rootTaskId: IdSchema, authority: NativeDelegationReferenceSchema });
const Claim = z.strictObject({ selector: NativeDelegationClaimSelectorSchema, validUntil: InstantSchema, identity: NativeServiceIdentitySchema,
  authority: NativeDelegationReferenceSchema, attempt: z.number().int().min(1).max(4), handoff: NativeAdvisoryHandoffSchema.nullable() });
const AuthorityResult = z.union([z.strictObject({ state: z.literal('stale') }), z.strictObject({ state: z.enum(['allowed', 'denied', 'unavailable']), observedAt: InstantSchema, validUntil: InstantSchema.nullable() })]);
const Prepared = z.union([z.strictObject({ kind: z.literal('pending'), retryAfterMilliseconds: z.literal(1000) }),
  z.strictObject({ kind: z.literal('settled'), result: AuthorityResult }),
  z.strictObject({ kind: z.literal('prepared'), target: NativeDelegationTargetSchema, nonce: z.uuid(), preparedAt: InstantSchema, deadlineAt: InstantSchema, providerIssuer: z.url(),
    context: z.strictObject({ subject: z.string(), externalOrganizationId: z.string(), externalMembershipId: z.string(), requiredRole: z.literal('org:admin').nullable() }) })]);
const Verdict = z.strictObject({ state: z.enum(['allowed', 'denied', 'unavailable']), reason: z.string().regex(/^[a-z_]{1,64}$/), observationStartedAt: InstantSchema, observationCompletedAt: InstantSchema });
export type NativeDelegationStoredVerdict = z.infer<typeof Verdict>;
export type NativeDelegationStoredPrepareResult = z.infer<typeof Prepared>;
export type NativeDelegationStoredAuthorityResult = z.infer<typeof AuthorityResult>;
export type NativeDelegationStoredClaim = z.infer<typeof Claim>;

function failure(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'ND001') throw new DomainError('FORBIDDEN', 403, 'Current delegation authority is required.');
  if (['NM001','NM005','NM006','NM008','NM009'].includes(String(code))) throw new DomainError('EVIDENCE_STALE', 409, 'The original memory evidence is no longer eligible.');
  if (code === 'NM004') throw new DomainError('VALIDATION_FAILED', 422, 'The memory publication reference is invalid.');
  if (code === 'ND004') throw new DomainError('VALIDATION_FAILED', 422, 'The delegated task record is invalid.');
  if (code === 'ND009' || code === '23505') throw new DomainError('DELEGATION_CONFLICT', 409, 'The retained delegation or assignment changed.');
  // A transport failure can follow a committed write. Callers recover through
  // exact retained identities; this response never means rollback or no effect.
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'The delegated operation outcome has not been confirmed.');
}
class DelegationRepository {
  constructor(protected readonly pool: Pool, protected readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  protected actor(input: ActorContext) {
    const actor = ActorContextSchema.parse(input);
    if (actor.environment !== this.environment) throw new DomainError('FORBIDDEN', 403, 'This actor belongs to another environment.');
    return actor;
  }
  protected async query<T>(sql: string, params: unknown[], schema: z.ZodType<T>): Promise<T> {
    try {
      const result = await this.pool.query<{ response: unknown }>(sql, params);
      if (result.rows.length !== 1) throw new Error('Missing retained response');
      return schema.parse(result.rows[0]?.response);
    } catch (error) { return failure(error); }
  }
}
/** Actor/session observations and grant consent must come from the trusted API,
 * never JSON forwarded directly from a browser or model. */
export class PostgresNativeDelegationRepository extends DelegationRepository {
  issue(actor: ActorContext, legacyRootId: string, grant: NativeAdvisoryGrant, issuance: NativeDelegationStoredIssuance) {
    return this.query('SELECT pactwoven.native_delegation_issue($1::jsonb,$2,$3::jsonb,$4::jsonb) AS response',
      [JSON.stringify(this.actor(actor)), IdSchema.parse(legacyRootId), JSON.stringify(NativeAdvisoryGrantSchema.parse(grant)), JSON.stringify(IssuanceSchema.parse(issuance))], IssueResult);
  }
  read(actor: ActorContext, grantId: string) {
    return this.query('SELECT pactwoven.native_delegation_read($1::jsonb,$2) AS response', [JSON.stringify(this.actor(actor)), IdSchema.parse(grantId)],
      z.strictObject({ grant: NativeAdvisoryGrantSchema, rootTaskId: IdSchema, childrenCreated: z.number().int().min(0).max(32), activeChildren: z.number().int().min(0).max(3),
        tasks: z.array(z.strictObject({ taskId: IdSchema, state: z.enum(['ready', 'running', 'paused', 'cancelled', 'settled']), generation: Revision,
          depth: z.number().int().min(0).max(3), service: NativeServiceIdentitySchema, handoffId: IdSchema.nullable() })) }));
  }
  revoke(actor: ActorContext, input: RevokeNativeDelegation) {
    return this.query('SELECT pactwoven.native_delegation_revoke($1::jsonb,$2::jsonb) AS response',
      [JSON.stringify(this.actor(actor)), JSON.stringify(RevokeNativeDelegationSchema.parse(input))], NativeAdvisoryGrantSchema);
  }
  async prepare(target: NativeDelegationTarget, issuer: string): Promise<NativeDelegationStoredPrepareResult> {
    const expected = NativeDelegationTargetSchema.parse(target);
    const response = await this.query('SELECT pactwoven.native_delegation_authority_prepare($1,$2::jsonb,$3) AS response',
      [this.environment, JSON.stringify(expected), z.url().parse(issuer)], Prepared);
    if (response.kind === 'prepared' && (response.providerIssuer !== issuer || response.target.organizationId !== expected.organizationId ||
      response.target.taskId !== expected.taskId || response.target.generation !== expected.generation)) failure(new Error('Misbound authority preparation'));
    return response;
  }
  finish(nonce: string, verdict: NativeDelegationStoredVerdict) {
    return this.query('SELECT pactwoven.native_delegation_authority_finish($1,$2::uuid,$3::jsonb) AS response',
      [this.environment, z.uuid().parse(nonce), JSON.stringify(Verdict.parse(verdict))], AuthorityResult);
  }
}
export class PostgresNativeDelegationWorkerRepository extends DelegationRepository {
  claim(target: NativeDelegationTarget, milliseconds = 15_000) {
    return this.query('SELECT pactwoven.native_delegation_claim($1,$2::jsonb,$3) AS response',
      [this.environment, JSON.stringify(NativeDelegationTargetSchema.parse(target)), z.number().int().min(1000).max(30000).parse(milliseconds)], Claim);
  }
  renew(selector: NativeDelegationClaimSelector, milliseconds = 15_000) {
    return this.query('SELECT pactwoven.native_delegation_renew($1,$2::jsonb,$3) AS response',
      [this.environment, JSON.stringify(NativeDelegationClaimSelectorSchema.parse(selector)), z.number().int().min(1000).max(30000).parse(milliseconds)], z.strictObject({ validUntil: InstantSchema }));
  }
  handoff(parent: NativeDelegationClaimSelector, handoff: NativeAdvisoryHandoff) {
    return this.query('SELECT pactwoven.native_delegation_handoff($1,$2::jsonb,$3::jsonb) AS response',
      [this.environment, JSON.stringify(NativeDelegationClaimSelectorSchema.parse(parent)), JSON.stringify(NativeAdvisoryHandoffSchema.parse(handoff))], Receipt);
  }
  retry(parent: NativeDelegationClaimSelector, handoff: NativeAdvisoryHandoff) {
    return this.query('SELECT pactwoven.native_delegation_retry($1,$2::jsonb,$3::jsonb) AS response',
      [this.environment, JSON.stringify(NativeDelegationClaimSelectorSchema.parse(parent)), JSON.stringify(NativeAdvisoryHandoffSchema.parse(handoff))], Receipt);
  }
  result(selector: NativeDelegationClaimSelector, publication: NativeDelegationPublication) {
    return this.query('SELECT pactwoven.native_delegation_result_commit($1,$2::jsonb,$3::jsonb) AS response',
      [this.environment, JSON.stringify(NativeDelegationClaimSelectorSchema.parse(selector)), JSON.stringify(PublicationSchema.parse(publication))], ResultReceipt);
  }
}
export class PostgresNativeDelegationDispatchRepository extends DelegationRepository {
  claim(limit = 10) {
    return this.query('SELECT pactwoven.native_delegation_outbox_claim($1,$2) AS response', [this.environment, z.number().int().min(1).max(20).parse(limit)],
      z.array(z.strictObject({ target: NativeDelegationTargetSchema, token: z.uuid() })).max(20));
  }
  acknowledge(target: NativeDelegationTarget, token: string) {
    return this.query('SELECT pactwoven.native_delegation_outbox_ack($1,$2::jsonb,$3::uuid) AS response',
      [this.environment, JSON.stringify(NativeDelegationTargetSchema.parse(target)), z.uuid().parse(token)], z.boolean());
  }
}
