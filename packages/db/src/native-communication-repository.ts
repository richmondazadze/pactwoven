import type { Pool } from 'pg';
import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdSchema, InstantSchema, type ActorContext, type Environment } from '../../contracts/src/core';
import { NativeChannelConsentApprovalSchema, NativeChannelConsentRequestSchema, NativeChannelConsentSchema,
  NativeIncomingMessageSchema, NativeIncomingVerificationSchema, NativeInboxReceiptSchema, NativeReplyWaitSchema,
  NativeSameRootWakeIntentSchema, type NativeChannelConsentApproval, type NativeChannelConsentRequest,
  type NativeIncomingMessage, type NativeIncomingVerification } from '../../contracts/src/native-communication';
import { nativeIncomingIdentityDigest } from '../../domain/src/native-communication';
import { commandDigest } from '../../contracts/src/canonical';
import { DomainError } from '../../domain/src/errors';

const Digest = z.string().regex(/^[a-f0-9]{64}$/), ProofId = z.uuid();
export const NativeCommunicationProviderSelectorSchema = z.strictObject({ connectionId: IdSchema, providerReference: z.string().min(1).max(512) });
type ProviderSelector = z.infer<typeof NativeCommunicationProviderSelectorSchema>;
/** Server-owned Google fetch and sender/content verifier. Never implement by signing caller JSON.
 * The returned message is independently fetched; provenanceId identifies this retained provider read.
 * The source and its dedicated producer pool are deployment dependencies, not HTTP inputs. */
export interface NativeCommunicationProviderSource {
  fetchVerified(selector: Readonly<ProviderSelector>, signal: AbortSignal): Promise<{
    provenanceId: string; message: NativeIncomingMessage; verification: NativeIncomingVerification;
  }>;
}
/** Resolves an exact approved review through current authenticated session evidence.
 * A review ID alone is not approval. The implementation must consume the protected review record. */
export interface NativeCommunicationReviewSource {
  resolveApproved(reviewId: string, signal: AbortSignal): Promise<{
    request: NativeChannelConsentRequest; approval: NativeChannelConsentApproval;
  }>;
}
const Lease = z.strictObject({ intent: NativeSameRootWakeIntentSchema, token: z.uuid(), attempt: z.number().int().min(1).max(10), expiresAt: InstantSchema });
export type NativeCommunicationWakeLease = z.infer<typeof Lease>;
const Delivery = z.strictObject({ id: Digest, status: z.enum(['delivered', 'suppressed', 'lease_lost']) });
function failure(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const known = {
    NC001: ['FORBIDDEN', 403, 'Current communication access is required.'],
    NC002: ['CHANNEL_EXPIRED', 409, 'The original read consent or task expired.'],
    NC003: ['COMMUNICATION_IDENTITY_CONFLICT', 409, 'The original communication identity has different retained content.'],
    NC004: ['VALIDATION_FAILED', 422, 'The communication request is invalid.'],
    NC005: ['COMMUNICATION_CONFLICT', 409, 'The retained wait changed.'],
    NC008: ['COMMUNICATION_STALE', 409, 'Refresh the verified communication observation.'],
    NC010: ['COMMUNICATION_INTEGRATION_REQUIRED', 503, 'The protected communication integration is not ready.'],
  } as const;
  if (Object.hasOwn(known, code)) { const [name, status, message] = known[code as keyof typeof known]; throw new DomainError(name, status, message); }
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Communication storage was not confirmed. Recover the original identity before retrying.');
}
class Repository {
  constructor(protected readonly pool: Pool, protected readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  protected actor(value: ActorContext): ActorContext {
    const actor = ActorContextSchema.parse(value);
    if (actor.environment !== this.environment || actor.principalKind !== 'human') throw new DomainError('FORBIDDEN', 403, 'Current human access is required.');
    return actor;
  }
  protected async call<T>(name: string, values: unknown[], schema: z.ZodType<T>): Promise<T> {
    // name is always an internal literal; no request may select a SQL function.
    try {
      const placeholders = values.map((_, index) => `$${index + 1}`).join(',');
      const result = await this.pool.query<{ response: unknown }>(`SELECT pactwoven.${name}(${placeholders}) AS response`, values);
      if (result.rows.length !== 1) throw Error('Missing communication result');
      return schema.parse(result.rows[0]?.response);
    } catch (error) { return failure(error); }
  }
}
/** Dedicated provider login: it cannot admit a message, mint consent or deliver a wake. */
export class PostgresNativeCommunicationProviderRepository extends Repository {
  constructor(pool: Pool, environment: Environment, private readonly source: NativeCommunicationProviderSource) { super(pool, environment); }
  async retain(selectorInput: ProviderSelector, signal: AbortSignal): Promise<string> {
    const selector = Object.freeze(NativeCommunicationProviderSelectorSchema.parse(selectorInput));
    const value = await this.source.fetchVerified(selector, signal); signal.throwIfAborted();
    const message = NativeIncomingMessageSchema.parse(value.message), verification = NativeIncomingVerificationSchema.parse(value.verification);
    if (message.scope.environment !== this.environment || message.connectionId !== selector.connectionId ||
      verification.messageDigest !== await commandDigest({ namespace: 'pactwoven/incoming-message/v1', message }) ||
      verification.identityDigest !== await nativeIncomingIdentityDigest(message) || verification.connectionId !== message.connectionId ||
      verification.connectionVersion !== message.connectionVersion || verification.accountSubject !== message.accountSubject) {
      throw new DomainError('FORBIDDEN', 403, 'The provider observation could not be verified.');
    }
    return this.call('native_communication_retain_observation', [this.environment, IdSchema.parse(value.provenanceId), JSON.stringify(message), JSON.stringify(verification)], ProofId);
  }
}
/** Dedicated review-proof login, separate from provider and admission credentials. */
export class PostgresNativeCommunicationReviewRepository extends Repository {
  constructor(pool: Pool, environment: Environment, private readonly source: NativeCommunicationReviewSource) { super(pool, environment); }
  async retain(reviewId: string, signal: AbortSignal): Promise<string> {
    const value = await this.source.resolveApproved(IdSchema.parse(reviewId), signal); signal.throwIfAborted();
    const request = NativeChannelConsentRequestSchema.parse(value.request), approval = NativeChannelConsentApprovalSchema.parse(value.approval);
    if (request.scope.environment !== this.environment) throw new DomainError('FORBIDDEN', 403, 'This review belongs to another environment.');
    return this.call('native_communication_retain_review', [this.environment, reviewId, JSON.stringify(request), JSON.stringify(approval)], ProofId);
  }
}
export class PostgresNativeCommunicationRepository extends Repository {
  async issue(actor: ActorContext, proofId: string) {
    const current = this.actor(actor);
    const consent = await this.call('native_communication_issue', [this.environment, JSON.stringify(current), ProofId.parse(proofId)], NativeChannelConsentSchema);
    if (consent.request.actorId !== current.actorId || consent.request.scope.organizationId !== current.organizationId || consent.request.scope.environment !== this.environment) failure(null);
    return consent;
  }
  async arm(actor: ActorContext, consentId: string, waitId: string, expiresAt: string) {
    const current = this.actor(actor);
    const wait = await this.call('native_communication_arm', [this.environment, JSON.stringify(current), IdSchema.parse(consentId), IdSchema.parse(waitId), InstantSchema.parse(expiresAt)], NativeReplyWaitSchema);
    if (wait.id !== waitId || wait.consentId !== consentId || wait.scope.environment !== this.environment || wait.scope.organizationId !== current.organizationId) failure(null);
    return wait;
  }
  async revoke(actor: ActorContext, consentId: string, expectedVersion: number) {
    return this.call('native_communication_revoke', [this.environment, JSON.stringify(this.actor(actor)), IdSchema.parse(consentId), z.number().int().min(1).parse(expectedVersion)], z.union([z.number(),z.string().regex(/^[0-9]+$/)]).transform(Number).pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)));
  }
  async admit(observationId: string, waitId: string) {
    const result = await this.call('native_communication_admit', [this.environment, ProofId.parse(observationId), IdSchema.parse(waitId)], NativeInboxReceiptSchema);
    if (result.scope.environment !== this.environment || result.waitId !== waitId) failure(null);
    return result;
  }
  async recover(actor: ActorContext, identityDigest: string) {
    const current = this.actor(actor);
    const result = await this.call('native_communication_recover', [this.environment, JSON.stringify(current), Digest.parse(identityDigest)], NativeInboxReceiptSchema.nullable());
    if (result && (result.scope.environment !== this.environment || result.scope.organizationId !== current.organizationId || result.identityDigest !== identityDigest)) failure(null);
    return result;
  }
}
export class PostgresNativeCommunicationOutboxRepository extends Repository {
  async claim(limit = 10, leaseMs = 15_000): Promise<NativeCommunicationWakeLease[]> {
    const count = z.number().int().min(1).max(20).parse(limit);
    const result = await this.call('native_communication_claim', [this.environment, count, z.number().int().min(1000).max(30_000).parse(leaseMs)], z.array(Lease).max(20));
    if (result.length > count || result.some(item => item.intent.scope.environment !== this.environment) || new Set(result.map(item => item.intent.id)).size !== result.length) failure(null);
    return result;
  }
  /** The SQL bridge queues only the original existing root and marks delivery in the same transaction.
   * This is never an acknowledgement flag for an external send or model-generated continuation. */
  async deliver(input: NativeCommunicationWakeLease) {
    const lease = Lease.parse(input);
    if (lease.intent.scope.environment !== this.environment) throw new DomainError('FORBIDDEN', 403, 'This wake belongs to another environment.');
    const result = await this.call('native_communication_deliver', [this.environment, lease.intent.id, lease.token], Delivery);
    if (result.id !== lease.intent.id) failure(null);
    return result;
  }
}
