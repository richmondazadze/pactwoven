import { createClerkClient } from '@clerk/backend';
import { AccessQuerySchema, AccessOperationQuerySchema, GrantAccessCommandSchema, ReviseAccessCommandSchema, RevokeAccessCommandSchema, MemberCandidatePageSchema, MemberCandidateSchema,
  type AccessQuery, type AccessOperationQuery, type GrantAccessCommand, type ReviseAccessCommand, type RevokeAccessCommand, type MemberCandidate, type MemberAccessPage, type MemberCandidatePage, type Operation } from '@pactwoven/contracts';
import type { AccessRepository, VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import type { ClerkIdentityConfig, IdentityVerifier, StepUpIdentityVerifier } from './auth.js';

export interface AccessGateway {
  listMembers(token: string, query: AccessQuery, correlationId: string): Promise<MemberAccessPage>;
  listCandidates(token: string, query: AccessQuery, correlationId: string): Promise<MemberCandidatePage>;
  getOperation(token: string, query: AccessOperationQuery, correlationId: string): Promise<Operation>;
  grant(token: string, key: string, command: GrantAccessCommand, correlationId: string): Promise<Operation>;
  revise(token: string, actorId: string, key: string, command: ReviseAccessCommand, correlationId: string): Promise<Operation>;
  revoke(token: string, actorId: string, key: string, command: RevokeAccessCommand, correlationId: string): Promise<Operation>;
}
export interface MembershipDirectory {
  list(identity: VerifiedIdentity, query: AccessQuery): Promise<MemberCandidatePage>;
  resolve(identity: VerifiedIdentity, externalMembershipId: string, externalSubject: string): Promise<MemberCandidate>;
}
export function createAccessGateway(dependencies: { repository: AccessRepository; verifyIdentity: IdentityVerifier; verifyStepUp: StepUpIdentityVerifier; directory: MembershipDirectory }): AccessGateway {
  const { repository, verifyIdentity, verifyStepUp, directory } = dependencies;
  return {
    async listMembers(token, query) { return repository.listMembers(await verifyIdentity(token), AccessQuerySchema.parse(query)); },
    async getOperation(token, query) { return repository.getOperation(await verifyIdentity(token), AccessOperationQuerySchema.parse(query)); },
    async listCandidates(token, input) {
      const query = AccessQuerySchema.parse(input), identity = await verifyIdentity(token);
      await repository.listMembers(identity, { limit: 1 });
      const page = await directory.list(identity, query);
      await repository.listMembers(await verifyIdentity(token), { limit: 1 });
      return MemberCandidatePageSchema.parse(page);
    },
    async grant(token, key, input, correlationId) {
      const command = GrantAccessCommandSchema.parse(input), identity = await verifyIdentity(token);
      await repository.listMembers(identity, { limit: 1 });
      const target = await directory.resolve(identity, command.payload.externalMembershipId, command.payload.externalSubject);
      return repository.changeAccess(await verifyStepUp(token), key, { kind: 'grant', command, target }, correlationId);
    },
    async revise(token, actorId, key, input, correlationId) {
      const command = ReviseAccessCommandSchema.parse(input), identity = await verifyIdentity(token);
      const member = await repository.getMember(identity, actorId);
      const target = await directory.resolve(identity, member.externalMembershipId, member.externalSubject);
      return repository.changeAccess(await verifyStepUp(token), key, { kind: 'revise', actorId, command, target }, correlationId);
    },
    async revoke(token, actorId, key, input, correlationId) {
      const command = RevokeAccessCommandSchema.parse(input);
      return repository.changeAccess(await verifyStepUp(token), key, { kind: 'revoke', actorId, command, target: null }, correlationId);
    },
  };
}
export function createClerkMembershipDirectory(config: ClerkIdentityConfig): MembershipDirectory {
  const client = createClerkClient({ secretKey: config.secretKey, telemetry: { disabled: true } });
  type Observation = { id: string; role: string; organization: { id: string }; publicUserData?: { userId: string; firstName: string | null; lastName: string | null } | null | undefined };
  function candidate(member: Observation, organizationId: string): MemberCandidate {
    if (member.organization.id !== organizationId || !member.publicUserData) throw new DomainError('FORBIDDEN', 403, 'An accepted organization membership is required.');
    const displayName = [member.publicUserData.firstName, member.publicUserData.lastName].filter(Boolean).join(' ').trim() || member.publicUserData.userId;
    return MemberCandidateSchema.parse({ externalOrganizationId: organizationId, externalMembershipId: member.id, externalSubject: member.publicUserData.userId,
      displayName: displayName.slice(0, 180), externalRole: member.role, observedAt: new Date().toISOString() });
  }
  return {
    async list(identity, query) {
      try {
        const offset = Number(query.cursor ?? '0');
        const result = await client.organizations.getOrganizationMembershipList({ organizationId: identity.externalOrganizationId, limit: query.limit, offset });
        return { items: result.data.map(member => candidate(member, identity.externalOrganizationId)),
          nextCursor: offset + result.data.length < result.totalCount ? String(offset + result.data.length) : null, observedAt: new Date().toISOString() };
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('IDENTITY_UNAVAILABLE', 503, 'Organization members could not be verified.');
      }
    },
    async resolve(identity, externalMembershipId, externalSubject) {
      try {
        const result = await client.organizations.getOrganizationMembershipList({ organizationId: identity.externalOrganizationId, userId: [externalSubject], limit: 2 });
        const member = result.data[0];
        if (result.totalCount !== 1 || result.data.length !== 1 || !member || member.id !== externalMembershipId || member.publicUserData?.userId !== externalSubject) {
          throw new DomainError('FORBIDDEN', 403, 'The selected membership is no longer accepted.');
        }
        return candidate(member, identity.externalOrganizationId);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('IDENTITY_UNAVAILABLE', 503, 'The selected member could not be verified.');
      }
    },
  };
}
