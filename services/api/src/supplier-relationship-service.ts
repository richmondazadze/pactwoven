import type { Pool } from 'pg';
import { z } from 'zod';
import { SupplierRelationshipMutationSchema, SupplierScopePolicyMutationSchema } from '@pactwoven/contracts';
import { DomainError, canonicalJson, immutable } from '@pactwoven/domain';
import { SupplierRelationshipHttpResponseSchema } from '../../../packages/contracts/src/supplier-relationship-http.js';
import { PostgresSupplierObserverRepository } from '../../../packages/db/src/supplier-observer-repository.js';
import {
  SupplierObserverConfigurationSchema, SupplierObserverActorSchema, assertSupplierObserverCurrent,
  snapshotSupplierIdentityObserver, snapshotSupplierFactorObserver,
  type SupplierObserverConfiguration, type SupplierObserverSnapshot, type SupplierObserverActor,
} from '../../../packages/db/src/supplier-observer-schema.js';
import { SupplierAuthenticationEvidenceSchema } from '../../../packages/db/src/supplier-relationship-auth-evidence.js';
import {
  SupplierPrivateRequestSchema, SupplierRelationshipStatusQuerySchema, SupplierRelationshipRecoveryQuerySchema,
  SupplierScopePolicyReadQuerySchema, snapshotSupplierPersistenceRequest, type SupplierPrivateRequest,
} from '../../../packages/db/src/supplier-relationship-persistence-schema.js';
// These two repositories must share this canonical module instance. Never transport or reconstruct its handle.
import { PostgresSupplierAuthenticationRepository, PostgresSupplierRelationshipRepository } from '../../../packages/db/src/supplier-relationship-repository.js';
import type { ClerkIdentityConfig } from './auth.js';
import { captureSupplierBearer, captureSupplierClerkConfiguration, createSupplierRelationshipVerifier } from './supplier-relationship-verifier.js';
import { assertSupplierApproversCurrent, createSupplierRelationshipApproverObserver,
  type SupplierOriginalApproverObservations } from './supplier-relationship-approver-observer.js';

const requestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('policy-command'), mutation: SupplierScopePolicyMutationSchema }),
  z.strictObject({ kind: z.literal('relationship-command'), mutation: SupplierRelationshipMutationSchema }),
  z.strictObject({ kind: z.literal('policy-read'), query: SupplierScopePolicyReadQuerySchema }),
  z.strictObject({ kind: z.literal('relationship-status'), query: SupplierRelationshipStatusQuerySchema }),
  z.strictObject({ kind: z.literal('relationship-recover'), query: SupplierRelationshipRecoveryQuerySchema }),
]);
export type SupplierRelationshipServiceRequest = z.infer<typeof requestSchema>;
// Return only the shared allowlist; raw SQL records, plans and private evidence
// never become HTTP responses. Routes separately correlate the original request.
const responseSchema = SupplierRelationshipHttpResponseSchema;
export type SupplierRelationshipServiceResponse = z.infer<typeof responseSchema>;
export type SupplierRelationshipServiceConfiguration = {
  clerk: ClerkIdentityConfig; observer: SupplierObserverConfiguration;
  verifierPool: Pool; authorizerPool: Pool; clock?: () => string;
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const denied = () => new DomainError('SUPPLIER_ACCESS_DENIED', 403, 'Current exact supplier access is required.');
const expired = () => new DomainError('SUPPLIER_OBSERVATION_EXPIRED', 409, 'Supplier verification expired. Obtain fresh verification for the original request.');
const unknown = () => new DomainError('SUPPLIER_OUTCOME_UNKNOWN', 503,
  'The supplier result is unconfirmed. Preserve the exact original request and use explicit recovery.');
const errorMessages = {
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
function safeError(error: unknown): DomainError {
  if (error instanceof DomainError && Object.hasOwn(errorMessages, error.code)) {
    const [status, message] = errorMessages[error.code as keyof typeof errorMessages];
    return new DomainError(error.code, status, message);
  }
  if (error instanceof DomainError && error.code === 'SUPPLIER_OBSERVER_REFUSED') return expired();
  if (error instanceof DomainError && error.code === 'SUPPLIER_OBSERVER_UNAVAILABLE') {
    return new DomainError('SUPPLIER_VERIFICATION_UNAVAILABLE', 503, 'Supplier authentication is temporarily unavailable.');
  }
  return unknown();
}
function snapshotRequest(input: unknown): SupplierPrivateRequest {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('SUPPLIER_INPUT_INVALID', 422, errorMessages.SUPPLIER_INPUT_INVALID[1]);
  const request = immutable(parsed.data);
  const purpose = request.kind === 'policy-command' ? 'supplier_scope_policy_' + request.mutation.command.payload.action :
    request.kind === 'relationship-command' ? 'supplier_relationship_' + request.mutation.command.payload.action :
    request.kind === 'policy-read' ? 'supplier_scope_policy_read' :
    request.kind === 'relationship-status' ? 'supplier_relationship_status' : 'supplier_relationship_recover';
  return immutable(SupplierPrivateRequestSchema.parse({ ...request, purpose }));
}

/** Same-process private composition. It does not provision principals, expose a
 * public route, establish supplier commercial authority or retry any operation. */
export function createSupplierRelationshipService(input: SupplierRelationshipServiceConfiguration) {
  const configuration = immutable(SupplierObserverConfigurationSchema.parse(input.observer));
  const clerk = captureSupplierClerkConfiguration(input.clerk, configuration.issuer), clock = input.clock ?? (() => new Date().toISOString());
  const verifierPool = input.verifierPool, authorizerPool = input.authorizerPool;
  if (verifierPool === authorizerPool) throw new DomainError('SETUP_REQUIRED', 503, errorMessages.SETUP_REQUIRED[1]);
  const verifier = createSupplierRelationshipVerifier(clerk, configuration, clock);
  const approver = createSupplierRelationshipApproverObserver(clerk, configuration, clock);
  const observer = new PostgresSupplierObserverRepository(verifierPool, configuration, clock);
  const recorder = new PostgresSupplierAuthenticationRepository(verifierPool, configuration.binding, clock);
  const repository = new PostgresSupplierRelationshipRepository(authorizerPool, configuration.binding, clock);
  const identity = verifier.identity.bind(verifier), factors = verifier.factors.bind(verifier), observeApprovers = approver.observe.bind(approver);
  const resolveIdentity = observer.resolveIdentity.bind(observer), resolveFactors = observer.resolveFactors.bind(observer);
  const append = recorder.append.bind(recorder), authorize = repository.execute.bind(repository);

  async function execute(request: SupplierPrivateRequest, token: string, approvers: SupplierOriginalApproverObservations = [], expectedActor?: SupplierObserverActor) {
    const mutation = request.kind === 'policy-command' || request.kind === 'relationship-command';
    assertSupplierApproversCurrent(approvers, configuration, clock());
    let original: SupplierObserverSnapshot;
    let resolved: Awaited<ReturnType<typeof resolveIdentity>> | Awaited<ReturnType<typeof resolveFactors>>;
    if (mutation) {
      const verified = await factors(token);
      original = snapshotSupplierFactorObserver(verified, configuration, clock());
      assertSupplierApproversCurrent(approvers, configuration, clock());
      resolved = await resolveFactors(verified);
    } else {
      const verified = await identity(token);
      original = snapshotSupplierIdentityObserver(verified, configuration, clock());
      assertSupplierApproversCurrent(approvers, configuration, clock());
      resolved = await resolveIdentity(verified);
    }
    assertSupplierObserverCurrent(original, configuration, clock());
    assertSupplierApproversCurrent(approvers, configuration, clock());
    const actor = immutable(SupplierObserverActorSchema.parse(resolved.actor));
    if (!same(resolved.binding, configuration.binding) || !same(resolved.observation, original.observation) || resolved.kind !== original.kind ||
      (original.kind === 'factors' && (resolved.kind !== 'factors' || !same(resolved.source, original.source))) ||
      actor.environment !== configuration.environment || actor.organizationId !== configuration.binding.effectiveOrganizationId ||
      actor.subject !== original.observation.subject || actor.externalOrganizationId !== original.observation.externalOrganizationId ||
      actor.externalMembershipId !== original.observation.externalMembershipId || actor.sessionId !== original.observation.sessionId ||
      (expectedActor !== undefined && !same(expectedActor, actor))) throw denied();
    if (request.kind === 'relationship-recover' && (request.query.identity.actorId !== actor.actorId ||
      request.query.identity.organizationId !== actor.organizationId)) throw denied();

    const expiresAt = new Date(Math.min(Date.parse(original.observation.expiresAt),
      ...approvers.map(entry => Date.parse(entry.observation.expiresAt)))).toISOString();
    const snapshot = immutable({ ...original, observation: { ...original.observation, expiresAt } });
    const fresh = () => {
      assertSupplierObserverCurrent(snapshot, configuration, clock());
      assertSupplierApproversCurrent(approvers, configuration, clock());
    };
    fresh();
    // The strict digest locator intentionally excludes private actor/member fields.
    const descriptor = await snapshotSupplierPersistenceRequest(request, {
      environment: actor.environment, organizationId: actor.organizationId, actorId: actor.actorId,
    });
    fresh();
    const evidence = immutable(SupplierAuthenticationEvidenceSchema.parse({
      schemaVersion: 1, id: crypto.randomUUID(), kind: snapshot.kind,
      ...(snapshot.kind === 'factors' ? { source: snapshot.source } : {}),
      actor, binding: configuration.binding, observedBy: configuration.binding.verifier,
      request, requestDigest: descriptor.requestDigest, mutationDigest: descriptor.mutationDigest,
      observation: snapshot.observation, observedAt: snapshot.observation.observedAt, expiresAt,
      ...(approvers.length ? { approvers } : {}),
    }));
    fresh();
    const handle = await append(evidence, request, actor);
    fresh();
    // One attempt with the very same handle. Recording/commit failure cannot reach this call.
    const result = await authorize(handle, request);
    let observationCurrent = true;
    try { fresh(); } catch { observationCurrent = false; }
    if (!mutation && !observationCurrent) throw expired();
    // Acknowledged mutation receipts are historical truth. Expiry during the
    // commit acknowledgement cannot erase them or turn them into live authority.
    return { result, actor };
  }

  return Object.freeze({
    async submit(bearer: string, input: unknown): Promise<SupplierRelationshipServiceResponse> {
      try {
        const token = captureSupplierBearer(bearer), request = snapshotRequest(input);
        let approvers: SupplierOriginalApproverObservations = [], expectedActor: SupplierObserverActor | undefined;
        if (request.kind === 'relationship-status' || (request.kind === 'relationship-command' && request.mutation.command.payload.action === 'approve')) {
          const scope = request.kind === 'relationship-status' ? request.query.scope : request.mutation.command.scope;
          const preflight = await execute(immutable(SupplierPrivateRequestSchema.parse({
            kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: { scope },
          })), token);
          if (preflight.result.kind !== 'relationship-observation-plan') throw unknown();
          expectedActor = preflight.actor;
          const plan = preflight.result.plan;
          const matchesCommand = request.kind === 'relationship-status' || (plan.head !== null &&
            plan.head.revision === request.mutation.command.expectedVersion && same(plan.head.proposal, request.mutation.command.targetProposal));
          if (matchesCommand) approvers = await observeApprovers(plan);
          // A different head cannot relabel original approvals or rewrite the
          // command. Empty facts retain SQL's exact-original-replay opportunity;
          // a genuinely new approval still fails its authoritative fences.
        }
        const { result } = await execute(request, token, approvers, expectedActor);
        let response: unknown;
        switch (result.kind) {
          case 'relationship-status': response = { kind: result.kind, projection: result.projection }; break;
          case 'policy-read': response = { kind: result.kind, policy: {
            reference: { pair: result.record.policy.pair, version: result.record.policy.version, hash: result.record.policyHash },
            predecessor: result.record.policy.predecessor, status: result.record.policy.status,
            buyerSiteIds: result.record.policy.buyerSiteIds, categories: result.record.policy.categories,
            issuedAt: result.record.policy.issuedAt, validFrom: result.record.policy.validFrom, expiresAt: result.record.policy.expiresAt,
          } }; break;
          case 'policy-command': response = { kind: result.kind, outcome: result.outcome, receipt: {
            identity: result.receipt.identity, commandDigest: result.receipt.commandDigest, recordedAt: result.receipt.recordedAt,
            result: { pair: result.receipt.result.policy.pair, version: result.receipt.result.policy.version, hash: result.receipt.result.policyHash },
          }, current: { pair: result.current.policy.pair, version: result.current.policy.version, hash: result.current.policyHash } }; break;
          case 'relationship-command': response = { kind: result.kind, outcome: result.outcome,
            receipt: result.receipt.receipt, currentHead: result.currentHead }; break;
          case 'relationship-recover': response = { kind: result.kind, original: result.original === null ? null : {
            mutation: result.original.mutation, receipt: result.original.receipt.receipt, currentHead: result.original.currentHead,
          } }; break;
          case 'relationship-observation-plan': throw unknown();
        }
        return immutable(responseSchema.parse(response));
      } catch (error) { throw safeError(error); }
    },
  });
}
