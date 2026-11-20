import { z } from 'zod';
import { ActorContextSchema, IdSchema, InstantSchema, ResponsibilitySchema, type CreateMandateDocumentRequest, type MandateAuthorityIntent,
  type MandateCollectionQuery, type MandateDecisionIntent, type MandateOperationQuery, type MandateOperationResult, type MandatePage,
  type MandateReview, type MandateReviewQuery, type MandateDocumentQuery, type MandateDocumentRead, type MemberCandidate, type ProposeMandateCommand } from '@pactwoven/contracts';
import type { VerifiedIdentity } from './repository.js';
import type { MandateMfaEvidence } from './mandate-evidence.js';

const actorRow = z.strictObject({ actor: ActorContextSchema, status: z.enum(['active', 'suspended', 'revoked']), expiresAt: InstantSchema.nullable(),
  assignedResponsibilityIds: z.array(IdSchema), externalSubject: IdSchema, externalMembershipId: IdSchema.nullable(), grantBasis: z.string() });
export const MandateResolvedContextSchema = z.strictObject({ organizationId: IdSchema, organizationEpoch: z.number().int().nonnegative(),
  organizationStatus: z.enum(['active', 'suspended', 'closed']), now: InstantSchema, reader: actorRow, requesters: z.array(actorRow).max(512),
  currentResponsibility: ResponsibilitySchema.nullable(), sites: z.array(z.strictObject({ id: IdSchema, organizationId: IdSchema,
    environment: z.enum(['simulation', 'development', 'staging', 'production']), name: z.string(), timeZone: z.string(), active: z.boolean() })).max(512) });
export type MandateResolvedContext = z.infer<typeof MandateResolvedContextSchema>;
/** Private verified boundary; parsing this shape is not token authentication. */
export const MandateIdentitySchema = z.strictObject({ subject: IdSchema, externalOrganizationId: IdSchema,
  externalOrganizationName: z.string().min(1).max(180), externalMembershipId: IdSchema, externalRole: z.string().min(1).max(128),
  membershipObservedAt: InstantSchema, sessionId: z.string().min(1).max(256), authenticatedAt: InstantSchema });
export type MandateMutation =
  | { kind: 'document'; request: CreateMandateDocumentRequest }
  | { kind: 'propose'; command: ProposeMandateCommand }
  | { kind: 'decide'; proposalId: string; intent: MandateDecisionIntent }
  | { kind: 'control'; mandateId: string; intent: MandateAuthorityIntent };
export type VerifiedMandateCommand = { identity: VerifiedIdentity; evidence: MandateMfaEvidence | null; requestNonce: string; requesterObservation: MemberCandidate | null };
export type MandateRequesterSelector = { kind: 'proposal'; reference: MandateDecisionIntent['proposal'] } | { kind: 'mandate'; reference: MandateAuthorityIntent['mandate'] };
export type MandateRequesterPin = { externalSubject: string; externalMembershipId: string };
export interface MandateRepository {
  list(identity: VerifiedIdentity, responsibilityId: string, query: MandateCollectionQuery, correlationId: string): Promise<MandatePage>;
  review(identity: VerifiedIdentity, responsibilityId: string, proposalId: string, query: MandateReviewQuery, correlationId: string): Promise<MandateReview>;
  readDocument(identity: VerifiedIdentity, responsibilityId: string, documentId: string, query: MandateDocumentQuery, correlationId: string): Promise<MandateDocumentRead>;
  operation(identity: VerifiedIdentity, query: MandateOperationQuery, correlationId: string): Promise<MandateOperationResult>;
  requester(identity: VerifiedIdentity, responsibilityId: string, selector: MandateRequesterSelector, correlationId: string): Promise<MandateRequesterPin>;
  mutate(verified: VerifiedMandateCommand, responsibilityId: string, key: string, mutation: MandateMutation, correlationId: string): Promise<MandateOperationResult>;
}
