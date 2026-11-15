import { z } from 'zod';
import type { MandateDocumentQuery, MandateDocumentRead } from './mandate-documents-http';
import { EnvironmentSchema, IdSchema, IdempotencyKeySchema, InstantSchema, OperationSchema, ResponsibilitySchema, SiteSchema } from './core';
import { HashSchema, MandateHeadSchema, VersionReferenceSchema } from './financial';
import { CreatePolicyDocumentCommandSchema, MandateEligibilitySchema, MandateReadEnvelopeSchema, MandateResponsibilityReferenceSchema,
  type MandateAuthorityIntent, type MandateDecisionIntent, type ProposeMandateCommand } from './mandates';

const version = z.number().int().positive().max(2_147_483_647);
const epoch = z.number().int().nonnegative().max(2_147_483_647);
const queryInteger = z.union([z.number().int(), z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number)]);
export const MandateCollectionQuerySchema = z.strictObject({ limit: queryInteger.pipe(z.number().int().min(1).max(25)).default(25), cursor: z.string().min(1).max(2048).optional() });
export type MandateCollectionQuery = z.infer<typeof MandateCollectionQuerySchema>;
export const MandateReviewQuerySchema = z.strictObject({ version: queryInteger.pipe(version) });
export type MandateReviewQuery = z.infer<typeof MandateReviewQuerySchema>;
export const CreateMandateDocumentRequestSchema = z.strictObject({
  responsibility: MandateResponsibilityReferenceSchema, expectedOrganizationEpoch: epoch, command: CreatePolicyDocumentCommandSchema,
});
export type CreateMandateDocumentRequest = z.infer<typeof CreateMandateDocumentRequestSchema>;
export const MandateOperationKindSchema = z.enum(['mandate.document.create', 'mandate.propose', 'mandate.authorize', 'mandate.reject', 'mandate.pause', 'mandate.revoke', 'mandate.resume']);
export type MandateOperationKind = z.infer<typeof MandateOperationKindSchema>;
export const MandateOperationQuerySchema = z.strictObject({ kind: MandateOperationKindSchema, key: IdempotencyKeySchema });
export type MandateOperationQuery = z.infer<typeof MandateOperationQuerySchema>;
export const MandateOperationResultSchema = z.strictObject({
  schemaVersion: z.literal(1), organizationId: IdSchema, operation: OperationSchema, kind: MandateOperationKindSchema,
  responsibilityId: IdSchema, target: z.strictObject({ kind: z.enum(['document', 'proposal', 'decision', 'authority']), id: IdSchema, version, hash: HashSchema }),
  commandHash: HashSchema, intentHash: HashSchema.nullable(), observedAt: InstantSchema,
}).refine(value => {
  const expected = value.kind === 'mandate.document.create' ? 'document' : value.kind === 'mandate.propose' ? 'proposal'
    : ['mandate.authorize', 'mandate.reject'].includes(value.kind) ? 'decision' : 'authority';
  return value.target.kind === expected && value.operation.aggregateId === value.target.id && value.operation.aggregateVersion === value.target.version &&
    value.operation.financialState === null && (['document', 'proposal'].includes(expected) ? value.intentHash === null : value.intentHash !== null);
}, 'Mandate operation identity, kind and independent financial state must agree');
export type MandateOperationResult = z.infer<typeof MandateOperationResultSchema>;
export const MandateEffectiveAuthoritySchema = z.strictObject({
  state: z.enum(['NONE', 'ACTIVE', 'PAUSED', 'REVOKED', 'EXPIRED', 'STALE']), blockers: z.array(z.string().min(1).max(100)).max(20),
}).refine(value => value.state === 'ACTIVE' ? value.blockers.length === 0 : value.blockers.length > 0, 'Effective authority requires current unblocked authority');
export type MandateEffectiveAuthority = z.infer<typeof MandateEffectiveAuthoritySchema>;
export const MandateEffectiveDecisionStateSchema = z.enum(['OPEN', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'STALE']);
export const MandateReviewSchema = z.strictObject({
  schemaVersion: z.literal(1), envelope: MandateReadEnvelopeSchema,
  responsibilityVersions: z.array(ResponsibilitySchema).min(1).max(3), effectiveAuthority: MandateEffectiveAuthoritySchema,
  effectiveDecisionState: MandateEffectiveDecisionStateSchema.nullable(),
}).refine(value => new Set(value.responsibilityVersions.map(record => `${record.id}:${record.version}`)).size === value.responsibilityVersions.length &&
  (value.envelope.proposal === null) === (value.effectiveDecisionState === null), 'Historical responsibility identities and selected decision state must agree');
export type MandateReview = z.infer<typeof MandateReviewSchema>;
export const MandateSummarySchema = z.strictObject({
  proposal: VersionReferenceSchema, mandateId: IdSchema, responsibility: MandateResponsibilityReferenceSchema,
  requesterId: IdSchema, decisionState: z.enum(['OPEN', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED']),
  effectiveDecisionState: MandateEffectiveDecisionStateSchema, createdAt: InstantSchema, expiresAt: InstantSchema,
});
export type MandateSummary = z.infer<typeof MandateSummarySchema>;
export const MandatePageSchema = z.strictObject({
  schemaVersion: z.literal(1), organizationId: IdSchema, environment: EnvironmentSchema, organizationEpoch: epoch,
  responsibility: ResponsibilitySchema, responsibilityReference: MandateResponsibilityReferenceSchema, site: SiteSchema,
  items: z.array(MandateSummarySchema).max(25), nextCursor: z.string().min(1).max(2048).nullable(),
  acceptedVersion: VersionReferenceSchema.nullable(), head: MandateHeadSchema.nullable(),
  effectiveAuthority: MandateEffectiveAuthoritySchema, eligibility: z.array(MandateEligibilitySchema).max(6), observedAt: InstantSchema,
}).refine(value => (value.acceptedVersion === null) === (value.head === null), 'Accepted authority and its current head resolve together');
export type MandatePage = z.infer<typeof MandatePageSchema>;

/** Transport boundary only. Original tokens stay in Authorization; public JSON never supplies identity or MFA. */
export interface MandateGateway {
  readDocument(token: string, responsibilityId: string, documentId: string, query: MandateDocumentQuery, correlationId: string): Promise<MandateDocumentRead>;
  list(token: string, responsibilityId: string, query: MandateCollectionQuery, correlationId: string): Promise<MandatePage>;
  review(token: string, responsibilityId: string, proposalId: string, query: MandateReviewQuery, correlationId: string): Promise<MandateReview>;
  operation(token: string, query: MandateOperationQuery, correlationId: string): Promise<MandateOperationResult>;
  createDocument(token: string, responsibilityId: string, key: string, request: CreateMandateDocumentRequest, correlationId: string): Promise<MandateOperationResult>;
  propose(token: string, responsibilityId: string, key: string, command: ProposeMandateCommand, correlationId: string): Promise<MandateOperationResult>;
  decide(token: string, responsibilityId: string, proposalId: string, key: string, intent: MandateDecisionIntent, correlationId: string): Promise<MandateOperationResult>;
  control(token: string, responsibilityId: string, mandateId: string, key: string, intent: MandateAuthorityIntent, correlationId: string): Promise<MandateOperationResult>;
}
