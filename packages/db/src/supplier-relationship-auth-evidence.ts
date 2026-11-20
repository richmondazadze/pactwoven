import { z } from 'zod';
import { EnvironmentSchema, HashSchema, IdSchema, InstantSchema } from '@pactwoven/contracts';
import { canonicalJson, commandDigest, immutable } from '@pactwoven/domain';
import {
  SupplierExternalObservationSchema, SupplierPrivatePrincipalBindingSchema, SupplierPrivateRequestSchema,
  SupplierApproverObservationsSchema, snapshotSupplierPersistenceRequest,
} from './supplier-relationship-persistence-schema.js';

// Private verifier seam only. This file is not a public package export. Neither
// parsing, equality with private expected facts nor a digest proves Clerk origin.
// The real verifier must authenticate/extract original provider evidence; SQL must
// bind its actual login and recheck the latest paired-principal lineage under lock.
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const externalId = z.string().min(1).max(256);
const actorSchema = z.strictObject({
  environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema, principalKind: z.literal('human'),
  membershipId: IdSchema, membershipVersion: version, organizationVersion: version, organizationEpoch: epoch,
  subject: externalId, externalOrganizationId: externalId, externalMembershipId: externalId, sessionId: externalId,
});
const fvaSchema = z.strictObject({
  kind: z.literal('CLERK_FVA'), tokenHash: HashSchema, tokenIssuedAt: InstantSchema,
  firstFactorAgeMinutes: z.number().int().min(0).max(1_000_000),
  secondFactorAgeMinutes: z.number().int().min(0).max(1_000_000),
  firstFactorAt: InstantSchema, secondFactorAt: InstantSchema, verifiedAt: InstantSchema,
}).refine(value => {
  const issued = Date.parse(value.tokenIssuedAt);
  const first = issued - (value.firstFactorAgeMinutes + 1) * 60_000;
  const second = issued - (value.secondFactorAgeMinutes + 1) * 60_000;
  return Date.parse(value.firstFactorAt) === first && Date.parse(value.secondFactorAt) === second &&
    Date.parse(value.verifiedAt) === Math.min(first, second);
}, 'Factor times must retain conservative original Clerk FVA/token-issue bounds; observation time cannot refresh them.');
const common = {
  schemaVersion: z.literal(1), id: z.uuid(), actor: actorSchema,
  binding: SupplierPrivatePrincipalBindingSchema,
  observedBy: z.strictObject({ oid: z.number().int().min(1).max(4_294_967_295), name: z.string().min(1).max(63).regex(/^[a-z_][a-z0-9_]*$/) }),
  request: SupplierPrivateRequestSchema, requestDigest: HashSchema, mutationDigest: HashSchema.nullable(),
  observation: SupplierExternalObservationSchema, observedAt: InstantSchema, expiresAt: InstantSchema,
  approvers: SupplierApproverObservationsSchema.optional(),
};
export const SupplierAuthenticationEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('identity') }),
  z.strictObject({ ...common, kind: z.literal('factors'), source: fvaSchema }),
]).superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  const command = value.request.kind === 'policy-command' || value.request.kind === 'relationship-command';
  if ((value.kind === 'factors') !== command) invalid('Mutations require factor evidence; read/recovery purposes require identity evidence.');
  if ((value.mutationDigest !== null) !== command) invalid('Only mutations have a producing command digest.');
  if (value.actor.environment !== value.binding.environment || value.actor.organizationId !== value.binding.effectiveOrganizationId ||
    value.observedBy.oid !== value.binding.verifier.oid || value.observedBy.name !== value.binding.verifier.name) invalid('Evidence must retain its exact private verifier and designated authorizer binding.');
  const observation = value.observation;
  if (value.actor.subject !== observation.subject || value.actor.externalOrganizationId !== observation.externalOrganizationId ||
    value.actor.externalMembershipId !== observation.externalMembershipId || value.actor.sessionId !== observation.sessionId) invalid('Local actor stamp and original external identity disagree.');
  if (value.observedAt !== observation.observedAt || value.expiresAt !== observation.expiresAt ||
    Date.parse(value.observedAt) < Date.parse(value.binding.validFrom) || Date.parse(value.expiresAt) > Date.parse(value.binding.expiresAt)) invalid('The evidence must preserve original observation times within its private binding.');
  if (value.kind === 'factors' && (value.source.tokenHash !== observation.tokenHash || value.source.tokenIssuedAt !== observation.tokenIssuedAt)) invalid('Factors must originate from the exact same observed token.');
  const scope = value.request.kind === 'relationship-command' ? value.request.mutation.command.scope :
    value.request.kind === 'relationship-status' ? value.request.query.scope :
      value.request.kind === 'relationship-recover' ? value.request.query.identity.scope : null;
  for (const entry of value.approvers ?? []) {
    if (scope === null || canonicalJson(entry.head.scope) !== canonicalJson(scope) || entry.observation.issuer !== observation.issuer ||
      Date.parse(entry.observation.observedAt) > Date.parse(value.observedAt) || Date.parse(entry.observation.expiresAt) < Date.parse(value.expiresAt)) invalid('Approver observations must retain exact request scope and original bundle validity.');
    if (value.request.kind === 'relationship-command' && (entry.head.revision !== value.request.mutation.command.expectedVersion ||
      canonicalJson(entry.head.proposal) !== canonicalJson(value.request.mutation.command.targetProposal))) invalid('Approver observations must bind the exact preflight command head.');
  }
});
export type SupplierAuthenticationEvidence = z.infer<typeof SupplierAuthenticationEvidenceSchema>;

/** PRIVATE structural inspection. Expected actor/binding must be separately loaded
 * from authenticated current private state, never accepted from a public request.
 * Every input is snapshotted before the first asynchronous digest. */
export async function snapshotSupplierAuthenticationEvidence(
  input: unknown, expectedRequestInput: unknown, expectedActorInput: unknown, expectedBindingInput: unknown, now: string,
) {
  const evidence = immutable(SupplierAuthenticationEvidenceSchema.parse(input));
  const expectedRequest = immutable(SupplierPrivateRequestSchema.parse(expectedRequestInput));
  const actor = immutable(actorSchema.parse(expectedActorInput));
  const binding = immutable(SupplierPrivatePrincipalBindingSchema.parse(expectedBindingInput));
  const at = Date.parse(InstantSchema.parse(now));
  if (canonicalJson(evidence.actor) !== canonicalJson(actor) || canonicalJson(evidence.binding) !== canonicalJson(binding) ||
    binding.status !== 'ACTIVE' || Date.parse(binding.validFrom) > at || at >= Date.parse(binding.expiresAt)) throw new Error('Evidence does not match the exact current private actor/binding.');
  if (canonicalJson(evidence.request) !== canonicalJson(expectedRequest)) throw new Error('Evidence belongs to another exact supplier purpose/request.');
  const observation = evidence.observation;
  if (Date.parse(evidence.observedAt) > at || at - Date.parse(evidence.observedAt) > 20_000 || at >= Date.parse(evidence.expiresAt) ||
    Date.parse(observation.membershipObservedAt) > at || at - Date.parse(observation.membershipObservedAt) > 20_000) throw new Error('Original supplier observation is no longer current.');
  if (evidence.kind === 'factors' && [evidence.source.firstFactorAt, evidence.source.secondFactorAt].some(value =>
    Date.parse(value) > at || at - Date.parse(value) > 300_000)) throw new Error('Both original factors must be within five minutes.');
  for (const entry of evidence.approvers ?? []) {
    if (Date.parse(entry.observation.observedAt) > at || at - Date.parse(entry.observation.observedAt) > 20_000 ||
      at >= Date.parse(entry.observation.expiresAt) || Date.parse(entry.approval.approvedAt) > at) throw new Error('Original approver membership observation is no longer current.');
  }
  const request = await snapshotSupplierPersistenceRequest(expectedRequest, {
    environment: actor.environment, organizationId: actor.organizationId, actorId: actor.actorId,
  });
  if (evidence.requestDigest !== request.requestDigest || evidence.mutationDigest !== request.mutationDigest) throw new Error('Supplier evidence digest does not bind this exact original request.');
  return immutable({
    kind: 'STRUCTURAL_EVIDENCE_SNAPSHOT' as const, authentication: 'NOT_ESTABLISHED' as const,
    providerVerification: 'NOT_ESTABLISHED' as const, persistence: 'NOT_ESTABLISHED' as const,
    evidence, digest: await commandDigest({ namespace: 'pactwoven/supplier-private-auth-evidence/v1', evidence }),
  });
}
