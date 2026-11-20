import { z } from 'zod';
import { CreateMandateDocumentRequestSchema, IdempotencyKeySchema, IdSchema, MandateAuthorityIntentSchema,
  MandateCollectionQuerySchema, MandateDecisionIntentSchema, MandateDocumentQuerySchema, MandateOperationQuerySchema, MandateReviewQuerySchema,
  MemberCandidateSchema, ProposeMandateCommandSchema, type MandateGateway } from '@pactwoven/contracts';
import { MandateIdentitySchema, type MandateRepository, type VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import type { MembershipDirectory } from './access-service.js';
import type { IdentityVerifier, MandateStepUpIdentityVerifier } from './auth.js';
import { qualifyMandateDocumentResult } from './mandate-document-result.js';

export type MandateGatewayDependencies = { repository: MandateRepository; verifyIdentity: IdentityVerifier;
  verifyMandateStepUp: MandateStepUpIdentityVerifier; directory: Pick<MembershipDirectory, 'resolve'>; requestNonce?: string };

function sameIdentity(before: VerifiedIdentity, after: VerifiedIdentity) {
  if (before.subject !== after.subject || before.externalOrganizationId !== after.externalOrganizationId ||
      before.externalMembershipId !== after.externalMembershipId || before.sessionId !== after.sessionId || before.externalRole !== after.externalRole) {
    throw new DomainError('AUTH_REQUIRED', 401, 'The verified mandate session changed. Sign in and review again.');
  }
}
/** Public JSON never supplies identity, evidence or nonce. Private transport may bind its already verified nonce. */
export function createMandateGateway(dependencies: MandateGatewayDependencies): MandateGateway {
  const { repository, verifyIdentity, verifyMandateStepUp, directory } = dependencies;
  const boundNonce = dependencies.requestNonce === undefined ? undefined : z.uuid().parse(dependencies.requestNonce);
  const nonce = () => boundNonce ?? crypto.randomUUID();
  const verify = async (token: string) => MandateIdentitySchema.parse(await verifyIdentity(token));
  const route = (id: string) => IdSchema.parse(id);
  return {
    async readDocument(token, responsibility, document, input, trace) {
      const responsibilityId = route(responsibility), documentId = route(document), query = MandateDocumentQuerySchema.parse(input);
      const result = await repository.readDocument(await verify(token), responsibilityId, documentId, query, trace);
      return qualifyMandateDocumentResult(result, responsibilityId, documentId, query);
    },
    async list(token, responsibility, input, trace) {
      const responsibilityId = route(responsibility), query = MandateCollectionQuerySchema.parse(input);
      return repository.list(await verify(token), responsibilityId, query, trace);
    },
    async review(token, responsibility, proposal, input, trace) {
      const responsibilityId = route(responsibility), proposalId = route(proposal), query = MandateReviewQuerySchema.parse(input);
      return repository.review(await verify(token), responsibilityId, proposalId, query, trace);
    },
    async operation(token, input, trace) {
      const query = MandateOperationQuerySchema.parse(input);
      return repository.operation(await verify(token), query, trace);
    },
    async createDocument(token, responsibility, inputKey, input, trace) {
      const responsibilityId = route(responsibility), key = IdempotencyKeySchema.parse(inputKey), request = CreateMandateDocumentRequestSchema.parse(input), requestNonce = nonce();
      if (request.responsibility.id !== responsibilityId) throw new DomainError('VALIDATION_FAILED', 422, 'The document responsibility must match its route.');
      return repository.mutate({ identity: await verify(token), evidence: null, requestNonce, requesterObservation: null }, responsibilityId, key, { kind: 'document', request }, trace);
    },
    async propose(token, responsibility, inputKey, input, trace) {
      const responsibilityId = route(responsibility), key = IdempotencyKeySchema.parse(inputKey), command = ProposeMandateCommandSchema.parse(input), requestNonce = nonce();
      if (command.responsibility.id !== responsibilityId) throw new DomainError('VALIDATION_FAILED', 422, 'The proposal responsibility must match its route.');
      return repository.mutate({ identity: await verify(token), evidence: null, requestNonce, requesterObservation: null }, responsibilityId, key, { kind: 'propose', command }, trace);
    },
    async decide(token, responsibility, proposal, inputKey, input, trace) {
      const responsibilityId = route(responsibility), proposalId = route(proposal), key = IdempotencyKeySchema.parse(inputKey), intent = MandateDecisionIntentSchema.parse(input), requestNonce = nonce();
      if (intent.proposal.id !== proposalId) throw new DomainError('VALIDATION_FAILED', 422, 'The exact proposal must match its decision route.');
      const identity = await verify(token);
      const pin = await repository.requester(identity, responsibilityId, { kind: 'proposal', reference: intent.proposal }, trace);
      const requesterObservation = MemberCandidateSchema.parse(await directory.resolve(identity, pin.externalMembershipId, pin.externalSubject));
      if (requesterObservation.externalOrganizationId !== identity.externalOrganizationId || requesterObservation.externalSubject !== pin.externalSubject || requesterObservation.externalMembershipId !== pin.externalMembershipId) {
        throw new DomainError('REQUESTER_CHANGED', 409, 'The original requester membership changed.');
      }
      if (intent.action === 'AUTHORIZE') {
        const verified = await verifyMandateStepUp(token, { nonce: requestNonce, key, intent });
        const currentIdentity = MandateIdentitySchema.parse(verified.identity); sameIdentity(identity, currentIdentity);
        return repository.mutate({ identity: currentIdentity, evidence: verified.evidence, requestNonce, requesterObservation }, responsibilityId, key, { kind: 'decide', proposalId, intent }, trace);
      }
      const currentIdentity = await verify(token); sameIdentity(identity, currentIdentity);
      return repository.mutate({ identity: currentIdentity, evidence: null, requestNonce, requesterObservation }, responsibilityId, key, { kind: 'decide', proposalId, intent }, trace);
    },
    async control(token, responsibility, mandate, inputKey, input, trace) {
      const responsibilityId = route(responsibility), mandateId = route(mandate), key = IdempotencyKeySchema.parse(inputKey), intent = MandateAuthorityIntentSchema.parse(input), requestNonce = nonce();
      if (intent.mandate.id !== mandateId || intent.responsibility.id !== responsibilityId) throw new DomainError('VALIDATION_FAILED', 422, 'The exact mandate and responsibility must match their route.');
      const identity = await verify(token);
      if (intent.action !== 'RESUME') return repository.mutate({ identity, evidence: null, requestNonce, requesterObservation: null }, responsibilityId, key, { kind: 'control', mandateId, intent }, trace);
      const pin = await repository.requester(identity, responsibilityId, { kind: 'mandate', reference: intent.mandate }, trace);
      const requesterObservation = MemberCandidateSchema.parse(await directory.resolve(identity, pin.externalMembershipId, pin.externalSubject));
      if (requesterObservation.externalOrganizationId !== identity.externalOrganizationId || requesterObservation.externalSubject !== pin.externalSubject || requesterObservation.externalMembershipId !== pin.externalMembershipId) {
        throw new DomainError('REQUESTER_CHANGED', 409, 'The original requester membership changed.');
      }
      const verified = await verifyMandateStepUp(token, { nonce: requestNonce, key, intent });
      const currentIdentity = MandateIdentitySchema.parse(verified.identity); sameIdentity(identity, currentIdentity);
      return repository.mutate({ identity: currentIdentity, evidence: verified.evidence, requestNonce, requesterObservation }, responsibilityId, key, { kind: 'control', mandateId, intent }, trace);
    },
  };
}
