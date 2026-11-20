import { z } from 'zod';
import { CreateMandateDocumentRequestSchema, IdempotencyKeySchema, MandateDocumentReadSchema, MandateOperationResultSchema, MandatePageSchema, MandateReviewSchema, ProposeMandateCommandSchema, HashSchema, type MandateDocumentRead, type MandateOperationResult, type MandatePage, type MandateReview } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from '@pactwoven/contracts/canonical';
import { RequestError } from './api';
import { immutableMandate, MandateCapsuleScopeSchema } from './mandate-capsule';
import { mandateOperationSucceeded } from './mandate-actions';
import { mandateRecoveryScope } from './mandate-recovery';
import { MANDATE_OBSERVATION_LIFETIME_MS, qualifyMandatePage, qualifyMandateReview, type MandateObservation, type MandateReadScope } from './mandates';
import { qualifyMandateDocument } from './mandate-document-reads';
import { AuthoringManifestSchema, AuthoringLocatorSchema, locatorFromAuthoringCapsule, type AuthoringManifest, type AuthoringLocator, type AuthoringDocumentSelection } from './mandate-authoring-recovery';
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const ref = (v: { id: string; version: number; hash: string }) => ({ id: v.id, version: v.version, hash: v.hash });
const originalObservation = z.strictObject({ data: MandatePageSchema, receivedAt: z.number().finite(), receivedMonotonic: z.number().finite().nonnegative() });
const common = { version: z.literal(1), key: IdempotencyKeySchema, scope: MandateCapsuleScopeSchema, manifest: AuthoringManifestSchema, observation: originalObservation, revision: MandateReviewSchema.nullable(), commandHash: HashSchema, integrityHash: HashSchema };
export const MandateAuthoringCapsuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('document'), command: CreateMandateDocumentRequestSchema, previous: MandateDocumentReadSchema.nullable() }),
  z.strictObject({ ...common, kind: z.literal('proposal'), command: ProposeMandateCommandSchema, documents: z.tuple([MandateDocumentReadSchema, MandateDocumentReadSchema]) }),
]);
export type MandateAuthoringCapsule = z.infer<typeof MandateAuthoringCapsuleSchema>;
export function normalizeAuthoringText(value: string) { return value.normalize('NFC').replace(/\r\n?/g, '\n'); }
function invalid(message = 'The exact authoring input, saved material or original preparation changed.'): never { throw new RequestError('MANDATE_AUTHORING_UNVERIFIED', message); }
export async function authoringBasisMatches(manifest: AuthoringManifest, page: MandatePage) {
  const expectedHead = page.head ? { mandateId: page.head.mandateId, mandateVersion: page.head.mandateVersion, mandateEpoch: page.head.mandateEpoch, hash: await commandDigest(page.head) } : null;
  return same(manifest.basis, { responsibility: page.responsibilityReference, organizationEpoch: page.organizationEpoch, previousAcceptedVersion: page.acceptedVersion, expectedHead });
}
export function authoringAvailable(page: MandatePage, scope: MandateReadScope, now: number) {
  const eligible = page.eligibility.find(item => item.action === 'PROPOSE');
  return scope.principalKind === 'human' && scope.roles.some(role => ['owner', 'finance', 'operations'].includes(role)) && scope.siteIds.includes(page.responsibility.siteId) && scope.actionSiteIds.includes(page.responsibility.siteId) &&
    page.organizationId === scope.organizationId && page.environment === scope.environment && page.responsibility.id === scope.responsibilityId && page.organizationEpoch === scope.organizationEpoch && Boolean(page.responsibility.acceptancePolicy.trim()) &&
    eligible?.eligible === true && eligible.requiresStepUp === false && Number.isFinite(now) && now >= Date.parse(page.observedAt) && now < Date.parse(page.observedAt) + MANDATE_OBSERVATION_LIFETIME_MS;
}
export async function createAuthoringManifest(scope: MandateReadScope, observation: MandateObservation<MandatePage>, preparationId: string, ids: AuthoringManifest['ids'], now: number, revision: MandateReview | null = null): Promise<AuthoringManifest> {
  scope = MandateCapsuleScopeSchema.parse(scope); observation = originalObservation.parse(observation); ids = structuredClone(ids); revision = revision ? MandateReviewSchema.parse(revision) : null;
  const page = await qualifyMandatePage(observation.data, scope);
  if (!authoringAvailable(page, scope, now)) throw new RequestError('AUTHORING_REVIEW_REQUIRED', 'Refresh current proposal preparation authority and responsibility first.');
  let mode: AuthoringManifest['mode'] = { kind: 'new' };
  if (revision) {
    const p = revision.envelope.proposal; if (!p) invalid(); await qualifyMandateReview(revision, scope, p.id, p.version);
    if (p.requesterId !== scope.actorId || revision.envelope.decision?.state !== 'OPEN' || Date.parse(p.expiresAt) <= now || p.version >= 2_147_483_647 || p.id !== ids.proposalId || p.mandateId !== ids.mandateId) invalid('Only the original requester can replace this exact open, unexpired proposal.');
    mode = { kind: 'revise', proposal: ref(p) };
  }
  const expectedHead = page.head ? { mandateId: page.head.mandateId, mandateVersion: page.head.mandateVersion, mandateEpoch: page.head.mandateEpoch, hash: await commandDigest(page.head) } : null;
  return immutableMandate(AuthoringManifestSchema.parse({ version: 1, scope: mandateRecoveryScope(scope), responsibilityId: scope.responsibilityId, preparationId, mode, ids, basis: { responsibility: page.responsibilityReference, organizationEpoch: page.organizationEpoch, previousAcceptedVersion: page.acceptedVersion, expectedHead }, documents: { acceptance: null, policy: null }, completed: [], pending: null }));
}
export async function authoringCommandDigest(scope: MandateReadScope, kind: MandateAuthoringCapsule['kind'], command: MandateAuthoringCapsule['command']) {
  const document = kind === 'document', parsed = document ? CreateMandateDocumentRequestSchema.parse(command) : ProposeMandateCommandSchema.parse(command);
  const targetId = 'command' in parsed ? parsed.command.documentId : parsed.proposalId;
  return commandDigest({ schemaVersion: 1, environment: scope.environment, organizationId: scope.organizationId, actorId: scope.actorId, kind: document ? 'mandate.document.create' : 'mandate.propose', route: { responsibilityId: scope.responsibilityId, targetId }, command: parsed });
}
async function validateBasis(scope: MandateReadScope, manifest: AuthoringManifest, observation: MandateObservation<MandatePage>, revision: MandateReview | null, now: number) {
  AuthoringManifestSchema.parse(manifest); const page = await qualifyMandatePage(observation.data, scope);
  if (!same(manifest.scope, mandateRecoveryScope(scope)) || manifest.responsibilityId !== scope.responsibilityId || manifest.pending || manifest.completed.some(item => item.locator.preparationId === manifest.preparationId && item.locator.step === 'proposal') || !await authoringBasisMatches(manifest, page) || !authoringAvailable(page, scope, now)) throw new RequestError('AUTHORING_REVIEW_REQUIRED', 'The current preparation basis changed or expired. Preserve any original pending request.');
  if (manifest.mode.kind === 'revise') {
    const p = revision?.envelope.proposal; if (!revision || !p || !same(ref(p), manifest.mode.proposal)) invalid(); await qualifyMandateReview(revision, scope, p.id, p.version);
    if (p.requesterId !== scope.actorId || p.mandateId !== manifest.ids.mandateId || revision.envelope.decision?.state !== 'OPEN' || Date.parse(p.expiresAt) <= now || p.version >= 2_147_483_647) invalid();
  } else if (revision !== null) invalid();
  return page;
}
export async function createDocumentAuthoringCapsule(scopeInput: MandateReadScope, manifestInput: AuthoringManifest, observationInput: MandateObservation<MandatePage>, purpose: 'ACCEPTANCE_POLICY' | 'MANDATE_POLICY', text: string, key: string, now: number, previousInput: MandateDocumentRead | null = null, revisionInput: MandateReview | null = null): Promise<MandateAuthoringCapsule & { kind: 'document' }> {
  const scope = MandateCapsuleScopeSchema.parse(scopeInput), manifest = AuthoringManifestSchema.parse(manifestInput), observation = originalObservation.parse(observationInput), previous = previousInput ? MandateDocumentReadSchema.parse(previousInput) : null, revision = revisionInput ? MandateReviewSchema.parse(revisionInput) : null;
  const page = await validateBasis(scope, manifest, observation, revision, now), documentId = purpose === 'ACCEPTANCE_POLICY' ? manifest.ids.acceptanceDocumentId : manifest.ids.policyDocumentId;
  if (previous) { await qualifyMandateDocument(previous, scope, ref(previous.document), purpose); if (previous.document.id !== documentId || previous.document.version >= 2_147_483_647 || previous.savedAgainst.responsibility.siteId !== page.responsibility.siteId) invalid(); }
  const selected = purpose === 'ACCEPTANCE_POLICY' ? manifest.documents.acceptance : manifest.documents.policy;
  if (selected && (!previous || !same(selected, selectionFromDocument(previous)))) invalid('Read the exact selected predecessor before creating its next version.');
  const normalized = normalizeAuthoringText(text);
  if (purpose === 'ACCEPTANCE_POLICY' && normalized !== normalizeAuthoringText(page.responsibility.acceptancePolicy)) invalid('Acceptance text must match the exact current responsibility.');
  const command = CreateMandateDocumentRequestSchema.parse({ responsibility: manifest.basis.responsibility, expectedOrganizationEpoch: manifest.basis.organizationEpoch, command: { documentId, expectedVersion: previous?.document.version ?? 0, previousVersion: previous ? ref(previous.document) : null, purpose, text: normalized } });
  const body = { version: 1 as const, kind: 'document' as const, key: IdempotencyKeySchema.parse(key), scope, manifest, observation, revision, previous, command, commandHash: await authoringCommandDigest(scope, 'document', command) };
  return immutableMandate(MandateAuthoringCapsuleSchema.parse({ ...body, integrityHash: await commandDigest(body) })) as MandateAuthoringCapsule & { kind: 'document' };
}
export function selectionFromDocument(value: MandateDocumentRead): AuthoringDocumentSelection { return { reference: ref(value.document), operationId: value.saveOperation.operation.id, savedAt: value.document.createdAt, commandHash: value.saveOperation.commandHash, purpose: value.document.purpose, savedAgainst: value.savedAgainst }; }
export async function createProposalAuthoringCapsule(scopeInput: MandateReadScope, manifestInput: AuthoringManifest, observationInput: MandateObservation<MandatePage>, documentInputs: [MandateDocumentRead, MandateDocumentRead], dates: { policyExpiresAt: string; proposalExpiresAt: string }, key: string, now: number, revisionInput: MandateReview | null = null): Promise<MandateAuthoringCapsule & { kind: 'proposal' }> {
  const scope = MandateCapsuleScopeSchema.parse(scopeInput), manifest = AuthoringManifestSchema.parse(manifestInput), observation = originalObservation.parse(observationInput), revision = revisionInput ? MandateReviewSchema.parse(revisionInput) : null;
  const documents = documentInputs.map(input => MandateDocumentReadSchema.parse(input)) as [MandateDocumentRead, MandateDocumentRead];
  dates = { ...dates };
  const page = await validateBasis(scope, manifest, observation, revision, now);
  for (const [index, purpose] of (['ACCEPTANCE_POLICY', 'MANDATE_POLICY'] as const).entries()) {
    const document = documents[index]!, selected = purpose === 'ACCEPTANCE_POLICY' ? manifest.documents.acceptance : manifest.documents.policy;
    if (!selected || !same(selected, selectionFromDocument(document))) invalid('Read and select both exact saved documents before reviewing the proposal.');
    await qualifyMandateDocument(document, scope, selected.reference, purpose);
    if (document.savedAgainst.responsibility.siteId !== page.responsibility.siteId) invalid();
  }
  if (documents[0].document.text !== normalizeAuthoringText(page.responsibility.acceptancePolicy)) invalid();
  const policyExpiresAt = new Date(dates.policyExpiresAt).toISOString(), expiresAt = new Date(dates.proposalExpiresAt).toISOString();
  if (Date.parse(expiresAt) <= now || Date.parse(policyExpiresAt) <= now || Date.parse(expiresAt) > Date.parse(policyExpiresAt)) invalid('Review deadline must be future and no later than policy expiry.');
  const command = ProposeMandateCommandSchema.parse({ proposalId: manifest.ids.proposalId, expectedProposalVersion: manifest.mode.kind === 'revise' ? manifest.mode.proposal.version : 0, previousProposal: manifest.mode.kind === 'revise' ? manifest.mode.proposal : null, mandateId: manifest.ids.mandateId,
    responsibility: manifest.basis.responsibility, expectedOrganizationEpoch: manifest.basis.organizationEpoch, previousAcceptedVersion: manifest.basis.previousAcceptedVersion, expectedHead: manifest.basis.expectedHead,
    policy: { mode: 'ADVISE', siteIds: [page.responsibility.siteId], supplierRelationshipIds: [], actions: [], budgets: [], acceptancePolicy: ref(documents[0].document), communication: { recipientIds: [], purposes: [], messageKinds: [], maximumMessages: 0, expiresAt: policyExpiresAt }, expiresAt: policyExpiresAt }, policyDocument: ref(documents[1].document), expiresAt });
  const body = { version: 1 as const, kind: 'proposal' as const, key: IdempotencyKeySchema.parse(key), scope, manifest, observation, revision, documents, command, commandHash: await authoringCommandDigest(scope, 'proposal', command) };
  return immutableMandate(MandateAuthoringCapsuleSchema.parse({ ...body, integrityHash: await commandDigest(body) })) as MandateAuthoringCapsule & { kind: 'proposal' };
}
export async function verifyAuthoringCapsule(input: MandateAuthoringCapsule) {
  const value = MandateAuthoringCapsuleSchema.parse(input), { integrityHash, ...body } = value;
  if (!same(input, value) || await commandDigest(body) !== integrityHash) invalid();
  const now = Date.parse(value.observation.data.observedAt);
  const rebuilt = value.kind === 'document' ? await createDocumentAuthoringCapsule(value.scope, value.manifest, value.observation, value.command.command.purpose, value.command.command.text, value.key, now, value.previous, value.revision)
    : await createProposalAuthoringCapsule(value.scope, value.manifest, value.observation, value.documents, { policyExpiresAt: value.command.policy.expiresAt, proposalExpiresAt: value.command.expiresAt }, value.key, now, value.revision);
  if (!same(value, rebuilt)) invalid(); return immutableMandate(value);
}
export function qualifyAuthoringOperation(input: unknown, locatorInput: AuthoringLocator): MandateOperationResult {
  const locator = AuthoringLocatorSchema.parse(locatorInput), result = MandateOperationResultSchema.parse(input);
  if (result.organizationId !== locator.scope.organizationId || result.operation.environment !== locator.scope.environment || result.responsibilityId !== locator.responsibilityId || result.kind !== locator.kind || result.target.kind !== (locator.step === 'proposal' ? 'proposal' : 'document') || result.target.id !== locator.target.id || result.target.version !== locator.target.version || result.commandHash !== locator.commandHash || result.intentHash !== null) invalid();
  return result;
}
export async function qualifyAuthoringProposal(input: unknown, scope: MandateReadScope, locator: AuthoringLocator, resultInput: MandateOperationResult, capsule?: MandateAuthoringCapsule | null) {
  scope = MandateCapsuleScopeSchema.parse(scope); locator = AuthoringLocatorSchema.parse(locator);
  if (!same(locator.scope, mandateRecoveryScope(scope)) || locator.responsibilityId !== scope.responsibilityId) invalid();
  const result = qualifyAuthoringOperation(resultInput, locator); if (locator.step !== 'proposal' || !mandateOperationSucceeded(result)) invalid();
  const review = await qualifyMandateReview(input, scope, locator.target.id, locator.target.version), p = review.envelope.proposal!, d = review.envelope.decision!;
  if (p.hash !== result.target.hash || p.requesterId !== locator.scope.actorId || p.createdAt !== result.observedAt || !same(p.responsibility, locator.basis.responsibility) || p.organizationEpoch !== locator.basis.organizationEpoch) invalid();
  const command = ProposeMandateCommandSchema.parse({ proposalId: p.id, expectedProposalVersion: p.version - 1, previousProposal: p.previousProposal, mandateId: p.mandateId, responsibility: p.responsibility, expectedOrganizationEpoch: p.organizationEpoch, previousAcceptedVersion: p.previousAcceptedVersion, expectedHead: p.expectedHead, policy: p.policy, policyDocument: p.policyDocument, expiresAt: p.expiresAt });
  if (await authoringCommandDigest({ ...scope, actorId: p.requesterId }, 'proposal', command) !== locator.commandHash || (capsule && (capsule.kind !== 'proposal' || !same(locatorFromAuthoringCapsule(capsule), locator) || !same(capsule.command, command))) || (d.state === 'OPEN' && (d.operationId !== result.operation.id || d.createdAt !== p.createdAt))) invalid();
  return immutableMandate(review);
}

export function parseAuthoringUtc(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) invalid('Enter a complete date and time in UTC.');
  const seconds = value.length === 16 ? `${value}:00` : value;
  const date = new Date(`${seconds}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== seconds) invalid('Enter a valid calendar date and time in UTC.');
  return date.toISOString();
}
export function authoringRevisionAvailable(review: MandateReview, scope: MandateReadScope, now: number) {
  const e = review.envelope, p = e.proposal, eligibility = e.eligibility.find(item => item.action === 'PROPOSE');
  return Boolean(p && p.requesterId === scope.actorId && e.decision?.state === 'OPEN' && p.version < 2_147_483_647 && Date.parse(p.expiresAt) > now &&
    e.organizationEpoch === scope.organizationEpoch && e.responsibility.organizationId === scope.organizationId && e.responsibility.environment === scope.environment && e.responsibility.id === scope.responsibilityId &&
    scope.principalKind === 'human' && scope.roles.some(role => ['owner', 'finance', 'operations'].includes(role)) && scope.siteIds.includes(e.responsibility.siteId) && scope.actionSiteIds.includes(e.responsibility.siteId) &&
    eligibility?.eligible && !eligibility.requiresStepUp && now >= Date.parse(e.observedAt) && now < Date.parse(e.observedAt) + MANDATE_OBSERVATION_LIFETIME_MS);
}
