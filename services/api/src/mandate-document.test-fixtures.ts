import type { ActorContext, MandateDocumentRead, Responsibility } from '@pactwoven/contracts';
import { createPolicyDocumentVersion, mandateResponsibilityReference } from '@pactwoven/domain';

export async function documentReadFixture(): Promise<MandateDocumentRead> {
  const savedAt = '2026-11-15T08:00:00.000Z';
  const actor: ActorContext = { actorId: 'requester_a', principalKind: 'human', organizationId: 'org_a', environment: 'development',
    roles: ['operations'], siteIds: ['site_a'], actionSiteIds: ['site_a'], sessionId: 'fixture_session', authenticatedAt: savedAt, correlationId: 'trace' };
  const savedResponsibility: Responsibility = { id: 'responsibility_a', organizationId: 'org_a', environment: 'development', ownerId: actor.actorId,
    title: 'Prepare an event', description: '', siteId: 'site_a', version: 1, window: { startsAt: savedAt, endsAt: '2026-11-16T08:00:00.000Z', timeZone: 'America/Chicago' },
    requirements: [], acceptancePolicy: 'Require signed evidence.', executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN', createdAt: savedAt, updatedAt: savedAt };
  const document = await createPolicyDocumentVersion({ actor, now: savedAt }, {
    documentId: 'policy_a', expectedVersion: 0, previousVersion: null, purpose: 'MANDATE_POLICY', text: 'Advice only.\n  Preserve these spaces.\n',
  }, null);
  return { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: savedResponsibility.id,
    observedAt: new Date().toISOString(), document, savedResponsibility,
    savedAgainst: { responsibility: await mandateResponsibilityReference(savedResponsibility), organizationEpoch: 2 },
    saveOperation: { schemaVersion: 1, organizationId: 'org_a', responsibilityId: savedResponsibility.id, kind: 'mandate.document.create',
      operation: { id: 'document_save_a', environment: 'development', status: 'succeeded', aggregateId: document.id, aggregateVersion: document.version,
        financialState: null, evidenceRefs: [], nextCheckAt: null, error: null },
      target: { kind: 'document', id: document.id, version: document.version, hash: document.hash }, commandHash: 'a'.repeat(64), intentHash: null, observedAt: savedAt } };
}
