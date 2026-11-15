import { z } from 'zod';
import { ActorContextSchema, IdSchema, InstantSchema, MandateAuthorityIntentSchema, MandateDecisionSchema, MandateHeadSchema,
  MandatePageSchema, MandateReviewSchema, MandateVersionSchema, ResponsibilitySchema, SiteSchema, type ActorContext, type Environment,
  type MandateAuthorityIntent, type MandateDecision, type MandateEffectiveAuthority, type MandateEligibility,
  type MandateHead, type MandateHeadReference, type MandatePage, type MandateProposalVersion, type MandateReview, type MandateVersion,
  type PolicyDocumentVersion, type Responsibility } from '@pactwoven/contracts';
import { mandateDecisionEligibility, mandateIntentHash, type VerifiedMandateEvidence } from './mandate-authorization.js';
import { assertMandateActor, equalMandateValue, mandateHeadReference, mandateReference, mandateResponsibilityReference,
  mandateVersionReference, normalizePolicyText, validateConnectedMandatePolicy, validateMandateDecision,
  validateMandateProposalVersion, validatePolicyDocumentVersion, type MandateCurrentContext } from './mandate-proposals.js';
import { commandDigest } from './canonical.js';
import { DomainError } from './errors.js';
import { immutable, instant } from './financial-primitives.js';

type Reference = { id: string; version: number; hash: string };
export type MandateReadActor = { actor: ActorContext; status: 'active' | 'suspended' | 'revoked'; expiresAt: string | null; assignedResponsibilityIds: string[] };
export type MandateReadSite = { organizationId: string; environment: Environment; id: string; name: string; timeZone: string; active: boolean };
export type AttachedMandateDocument = { organizationId: string; environment: Environment; responsibilityId: string; siteId: string; document: PolicyDocumentVersion };
export type MandateHeadHistory = {
  head: MandateHead; previousHead: MandateHeadReference | null;
  action: 'AUTHORIZE' | 'PAUSE' | 'REVOKE' | 'RESUME' | 'EXPIRE'; actorId: string | null; occurredAt: string; operationId: string;
  intent: MandateAuthorityIntent | null; evidence: VerifiedMandateEvidence | null;
};
/** Repository-only resolved records. The projector validates provenance; it does not authenticate supplied JSON or provider proofs. */
export type MandateReadSource = {
  organizationId: string; environment: Environment; organizationEpoch: number; organizationStatus: 'active' | 'suspended' | 'closed'; now: string;
  reader: MandateReadActor; requesters: MandateReadActor[]; currentResponsibility: Responsibility;
  responsibilityVersions: Responsibility[]; sites: MandateReadSite[]; documents: AttachedMandateDocument[];
  proposals: MandateProposalVersion[]; decisions: MandateDecision[]; acceptedVersions: MandateVersion[];
  head: MandateHead | null; headHistory: MandateHeadHistory[]; selectedProposal: Reference | null;
};

const evidenceSchema = z.strictObject({ id: IdSchema, purpose: z.enum(['mandate_authorization', 'mandate_control']),
  intentHash: z.string().regex(/^[a-f0-9]{64}$/), actorId: IdSchema, sessionId: z.string().min(1).max(256), verifiedAt: InstantSchema, expiresAt: InstantSchema });
const key = (record: { id: string; version: number }) => `${record.id}:${record.version}`;
const fail = (): never => { throw new DomainError('MANDATE_READ_INVALID', 409, 'Mandate history or policy provenance could not be verified.'); };
function need(condition: unknown): asserts condition { if (!condition) fail(); }
function unique<T>(items: T[], identity: (item: T) => string): Map<string, T> {
  need(items.length <= 512);
  const result = new Map<string, T>();
  for (const item of items) { const id = identity(item); need(!result.has(id)); result.set(id, item); }
  return result;
}
function currentReadActor(record: MandateReadActor, source: MandateReadSource): ActorContext | null {
  const actor = ActorContextSchema.parse(record.actor);
  if (record.expiresAt !== null) InstantSchema.parse(record.expiresAt);
  need(record.status === 'active' || record.status === 'revoked' || record.status === 'suspended');
  need(actor.organizationId === source.organizationId && actor.environment === source.environment);
  return record.status === 'active' && (record.expiresAt === null || instant(record.expiresAt) > instant(source.now)) &&
    instant(actor.authenticatedAt) <= instant(source.now) ? actor : null;
}
function historicalEvidence(record: MandateHeadHistory, purpose: VerifiedMandateEvidence['purpose'], intentHash: string): VerifiedMandateEvidence {
  const proof = evidenceSchema.parse(record.evidence);
  need(proof.actorId === record.actorId && proof.purpose === purpose && proof.intentHash === intentHash &&
    instant(proof.verifiedAt) <= instant(record.occurredAt) && instant(proof.expiresAt) > instant(record.occurredAt) &&
    instant(record.occurredAt) - instant(proof.verifiedAt) < 300_000);
  return proof;
}

/** Full historical records are validated privately; only exact selected/accepted documents and snapshots are returned. */
export async function projectMandateRead(source: MandateReadSource): Promise<MandateReview> {
  try { return await project(immutable(structuredClone(source))); }
  catch (error) { if (error instanceof DomainError && error.code === 'FORBIDDEN') throw error; return fail(); }
}

async function project(source: MandateReadSource): Promise<MandateReview> {
  InstantSchema.parse(source.now);
  need(Number.isSafeInteger(source.organizationEpoch) && source.organizationEpoch >= 0);
  const current = ResponsibilitySchema.parse(source.currentResponsibility);
  need(current.organizationId === source.organizationId && current.environment === source.environment);
  const reader = currentReadActor(source.reader, source);
  const readerRoles = ['owner', 'finance', 'operations', 'auditor'];
  if (source.organizationStatus !== 'active' || !reader || reader.principalKind !== 'human' || !reader.siteIds.includes(current.siteId) ||
      !(reader.roles.some(role => readerRoles.includes(role)) || (reader.roles.includes('receiver') && source.reader.assignedResponsibilityIds.includes(current.id)))) {
    throw new DomainError('FORBIDDEN', 403, 'Current responsibility and site read access is required.');
  }
  const sites = unique(source.sites, site => site.id);
  for (const site of sites.values()) {
    SiteSchema.parse({ id: site.id, name: site.name, timeZone: site.timeZone });
    need(site.organizationId === source.organizationId && site.environment === source.environment && typeof site.active === 'boolean');
  }
  const currentSite = sites.get(current.siteId); need(currentSite);
  const responsibilities = unique(source.responsibilityVersions.map(record => ResponsibilitySchema.parse(record)), key);
  const currentSnapshot = responsibilities.get(key(current)); need(currentSnapshot && equalMandateValue(currentSnapshot, current));
  for (const record of responsibilities.values()) {
    need(record.id === current.id && record.organizationId === source.organizationId && record.environment === source.environment && sites.has(record.siteId) &&
      record.version <= current.version && instant(record.createdAt) <= instant(record.updatedAt) && instant(record.updatedAt) <= instant(source.now));
    need([...responsibilities.values()].every(prior => prior.version >= record.version || instant(prior.updatedAt) <= instant(record.updatedAt)));
  }
  const resolveResponsibility = async (reference: MandateProposalVersion['responsibility']) => {
    const record = responsibilities.get(key(reference)); need(record && equalMandateValue(reference, await mandateResponsibilityReference(record)));
    return record;
  };
  const wasCurrentResponsibility = (record: Responsibility, at: string) => ![...responsibilities.values()]
    .some(candidate => candidate.version > record.version && instant(candidate.updatedAt) < instant(at));
  const documents = unique(source.documents, row => key(row.document));
  for (const [id, row] of documents) {
    const document = await validatePolicyDocumentVersion(row.document);
    need(row.organizationId === source.organizationId && row.environment === source.environment && row.responsibilityId === current.id && sites.has(row.siteId) &&
      document.organizationId === source.organizationId && document.environment === source.environment && instant(document.createdAt) <= instant(source.now));
    documents.set(id, { ...row, document });
  }
  for (const row of documents.values()) {
    const priorRef = row.document.previousVersion;
    if (priorRef) {
      const prior = documents.get(key(priorRef));
      need(prior && equalMandateValue(priorRef, mandateReference(prior.document)) && prior.document.purpose === row.document.purpose &&
        prior.siteId === row.siteId && prior.responsibilityId === row.responsibilityId && instant(prior.document.createdAt) <= instant(row.document.createdAt));
    }
  }
  const proposals = unique(await Promise.all(source.proposals.map(validateMandateProposalVersion)), key);
  const accepted = unique(source.acceptedVersions.map(record => MandateVersionSchema.parse(record)), key);
  const heads = unique(source.headHistory, record => `${record.head.mandateId}:${record.head.mandateEpoch}`);
  const usedDocuments = new Set<string>();
  const useDocument = (reference: Reference): AttachedMandateDocument => {
    const row = documents.get(key(reference)); need(row && equalMandateValue(reference, mandateReference(row.document)));
    let cursor: AttachedMandateDocument | undefined = row;
    while (cursor && !usedDocuments.has(key(cursor.document))) {
      usedDocuments.add(key(cursor.document)); cursor = cursor.document.previousVersion ? documents.get(key(cursor.document.previousVersion)) : undefined;
    }
    return row;
  };
  const resolveHead = async (reference: MandateHeadReference) => {
    const record = heads.get(`${reference.mandateId}:${reference.mandateEpoch}`);
    need(record && equalMandateValue(reference, await mandateHeadReference(record.head))); return record;
  };
  for (const proposal of proposals.values()) {
    const responsibility = await resolveResponsibility(proposal.responsibility);
    need(proposal.organizationId === source.organizationId && proposal.environment === source.environment && proposal.organizationEpoch <= source.organizationEpoch &&
      instant(proposal.createdAt) >= instant(responsibility.updatedAt) && instant(proposal.createdAt) <= instant(source.now) && wasCurrentResponsibility(responsibility, proposal.createdAt));
    need(![...heads.values()].some(record => record.head.mandateEpoch > (proposal.expectedHead?.mandateEpoch ?? 0) &&
      instant(record.occurredAt) < instant(proposal.createdAt)));
    need(equalMandateValue(proposal.policy, validateConnectedMandatePolicy(proposal.policy, responsibility.siteId, proposal.createdAt)));
    const acceptance = useDocument(proposal.policy.acceptancePolicy), policy = useDocument(proposal.policyDocument);
    need(acceptance.document.purpose === 'ACCEPTANCE_POLICY' && policy.document.purpose === 'MANDATE_POLICY' &&
      acceptance.siteId === responsibility.siteId && policy.siteId === responsibility.siteId &&
      acceptance.document.text === normalizePolicyText(responsibility.acceptancePolicy) &&
      instant(acceptance.document.createdAt) <= instant(proposal.createdAt) && instant(policy.document.createdAt) <= instant(proposal.createdAt));
    if (proposal.previousProposal) {
      const prior = proposals.get(key(proposal.previousProposal));
      need(prior && equalMandateValue(proposal.previousProposal, mandateReference(prior)) && prior.requesterId === proposal.requesterId &&
        prior.mandateId === proposal.mandateId && prior.responsibility.id === proposal.responsibility.id && instant(prior.createdAt) <= instant(proposal.createdAt));
    }
    if (proposal.previousAcceptedVersion) {
      const prior = accepted.get(key(proposal.previousAcceptedVersion));
      need(prior && equalMandateValue(proposal.previousAcceptedVersion, await mandateVersionReference(prior)));
      const boundHead = await resolveHead(proposal.expectedHead!);
      need(boundHead.head.mandateId === prior.id && boundHead.head.mandateVersion === prior.version &&
        boundHead.head.organizationEpoch <= proposal.organizationEpoch && instant(boundHead.occurredAt) <= instant(proposal.createdAt));
    }
  }
  need(usedDocuments.size === documents.size);
  const decisionRows = unique(source.decisions.map(record => MandateDecisionSchema.parse(record)), record => `${key(record.proposal)}:${record.version}`);
  const latestDecision = new Map<string, MandateDecision>();
  for (const proposal of proposals.values()) {
    const open = decisionRows.get(`${key(proposal)}:1`); need(open && open.state === 'OPEN');
    validateMandateDecision(open, proposal);
    const terminal = decisionRows.get(`${key(proposal)}:2`);
    const decision = terminal ? validateMandateDecision(terminal, proposal) : open;
    latestDecision.set(key(proposal), decision);
    if (terminal) {
      need(terminal.decidedAt && instant(terminal.decidedAt) <= instant(source.now));
      if (terminal.state === 'EXPIRED') need(instant(terminal.decidedAt) >= instant(proposal.expiresAt));
      else need(instant(terminal.decidedAt) < instant(proposal.expiresAt));
      if (terminal.state === 'SUPERSEDED') {
        const replacement = proposals.get(key(terminal.replacement!));
        need(replacement && equalMandateValue(terminal.replacement, mandateReference(replacement)) &&
          equalMandateValue(replacement.previousProposal, mandateReference(proposal)) && replacement.createdAt === terminal.decidedAt && terminal.actorId === proposal.requesterId);
      }
      if (terminal.state === 'APPROVED' || terminal.state === 'REJECTED') {
        need(terminal.actorId !== proposal.requesterId && terminal.intentHash === await mandateIntentHash({ schemaVersion: 1,
          action: terminal.state === 'APPROVED' ? 'AUTHORIZE' : 'REJECT', proposal: mandateReference(proposal), expectedDecisionVersion: 1,
          expectedOrganizationEpoch: proposal.organizationEpoch, expectedHead: proposal.expectedHead, reason: terminal.reason }));
      }
    }
    if (proposal.previousProposal) {
      const prior = decisionRows.get(`${key(proposal.previousProposal)}:2`);
      need(prior?.state === 'SUPERSEDED' && equalMandateValue(prior.replacement, mandateReference(proposal)));
    }
  }
  for (const decision of decisionRows.values()) need(proposals.has(key(decision.proposal)));
  const acceptedDecision = new Map<string, { proposal: MandateProposalVersion; decision: MandateDecision }>();
  for (const proposal of proposals.values()) {
    const decision = latestDecision.get(key(proposal))!;
    if (decision.state !== 'APPROVED') continue;
    const receipt = decision.authorization!;
    const record = accepted.get(key(receipt.acceptedVersion)); need(record && !acceptedDecision.has(key(record)));
    need(wasCurrentResponsibility(await resolveResponsibility(proposal.responsibility), record.createdAt));
    need(equalMandateValue(receipt.acceptedVersion, await mandateVersionReference(record)) && record.id === proposal.mandateId &&
      record.organizationId === proposal.organizationId && record.environment === proposal.environment && record.organizationEpoch === proposal.organizationEpoch &&
      record.responsibilityId === proposal.responsibility.id && record.createdBy === proposal.requesterId && record.createdAt === decision.decidedAt &&
      record.policyHash === proposal.policyHash && equalMandateValue(record.policy, proposal.policy) &&
      record.version === (proposal.previousAcceptedVersion?.version ?? 0) + 1 && record.previousVersionHash === (proposal.previousAcceptedVersion?.hash ?? null) &&
      record.mandateEpoch === (proposal.expectedHead?.mandateEpoch ?? 0) + 1 && receipt.requesterId === proposal.requesterId);
    const initial = await resolveHead(receipt.acceptedHead);
    need(initial.action === 'AUTHORIZE' && initial.actorId === receipt.approverId && initial.operationId === decision.operationId && initial.occurredAt === record.createdAt &&
      initial.head.state === 'ACTIVE' && initial.head.mandateEpoch === record.mandateEpoch && initial.head.expiresAt === record.policy.expiresAt);
    const proof = historicalEvidence(initial, 'mandate_authorization', receipt.intentHash);
    need(proof.id === receipt.stepUpEvidenceId && proof.verifiedAt === receipt.stepUpVerifiedAt &&
      new Date(Math.min(instant(proof.expiresAt), instant(proof.verifiedAt) + 300_000)).toISOString() === receipt.stepUpExpiresAt);
    acceptedDecision.set(key(record), { proposal, decision });
  }
  for (const record of accepted.values()) {
    need(acceptedDecision.has(key(record)) && record.organizationId === source.organizationId && record.environment === source.environment &&
      record.responsibilityId === current.id && record.policyHash === await commandDigest(record.policy));
    if (record.version > 1) {
      const prior = accepted.get(`${record.id}:${record.version - 1}`);
      need(prior && record.previousVersionHash === (await mandateVersionReference(prior)).hash && prior.mandateEpoch < record.mandateEpoch &&
        prior.organizationEpoch <= record.organizationEpoch && instant(prior.createdAt) <= instant(record.createdAt));
    } else need(record.previousVersionHash === null);
  }
  for (const record of heads.values()) {
    const head = MandateHeadSchema.parse(record.head);
    InstantSchema.parse(record.occurredAt); IdSchema.parse(record.operationId);
    if (record.actorId !== null) IdSchema.parse(record.actorId);
    const mandate = accepted.get(`${head.mandateId}:${head.mandateVersion}`); need(mandate);
    need(head.organizationId === source.organizationId && head.environment === source.environment && head.responsibilityId === current.id &&
      head.organizationEpoch === mandate.organizationEpoch && head.policyHash === mandate.policyHash && instant(record.occurredAt) <= instant(source.now) &&
      instant(record.occurredAt) >= instant(mandate.createdAt) && head.mandateEpoch >= mandate.mandateEpoch && head.expiresAt === mandate.policy.expiresAt);
    const previous = record.previousHead ? await resolveHead(record.previousHead) : null;
    need(previous ? previous.head.mandateId === head.mandateId && previous.head.mandateEpoch + 1 === head.mandateEpoch &&
      instant(previous.occurredAt) <= instant(record.occurredAt) : head.mandateEpoch === 1);
    if (record.action === 'AUTHORIZE') {
      const bound = acceptedDecision.get(key(mandate))!;
      need(record.intent === null && equalMandateValue(record.previousHead, bound.proposal.expectedHead) && head.mandateEpoch === mandate.mandateEpoch &&
        head.mandateVersion === (previous?.head.mandateVersion ?? 0) + 1 && record.operationId === bound.decision.operationId);
      continue;
    }
    need(previous && head.mandateVersion === previous.head.mandateVersion && !['REVOKED', 'EXPIRED'].includes(previous.head.state));
    const state = record.action === 'PAUSE' ? 'PAUSED' : record.action === 'REVOKE' ? 'REVOKED' : record.action === 'RESUME' ? 'ACTIVE' : 'EXPIRED';
    need(equalMandateValue(head, { ...previous.head, state, mandateEpoch: previous.head.mandateEpoch + 1 }));
    if (record.action === 'EXPIRE') {
      need(record.intent === null && record.evidence === null && record.actorId === null && instant(record.occurredAt) >= instant(previous.head.expiresAt));
      continue;
    }
    const intent = MandateAuthorityIntentSchema.parse(record.intent);
    const responsibility = await resolveResponsibility(intent.responsibility);
    need(record.actorId !== null && intent.action === record.action && intent.expectedOrganizationEpoch >= head.organizationEpoch &&
      intent.expectedOrganizationEpoch <= source.organizationEpoch && instant(record.occurredAt) >= instant(responsibility.updatedAt) &&
      wasCurrentResponsibility(responsibility, record.occurredAt) &&
      equalMandateValue(intent.head, record.previousHead) && equalMandateValue(intent.mandate, await mandateVersionReference(mandate)) &&
      instant(record.occurredAt) < instant(previous.head.expiresAt));
    if (record.action === 'PAUSE') need(previous.head.state === 'ACTIVE');
    if (record.action === 'RESUME') {
      const bound = acceptedDecision.get(key(mandate))!;
      need(previous.head.state === 'PAUSED' && record.actorId !== bound.proposal.requesterId && intent.expectedOrganizationEpoch === mandate.organizationEpoch &&
        equalMandateValue(intent.responsibility, bound.proposal.responsibility));
      historicalEvidence(record, 'mandate_control', await mandateIntentHash(intent));
    } else need(record.evidence === null);
  }
  let currentAccepted: MandateVersion | null = null;
  let currentAcceptedProposal: MandateProposalVersion | null = null;
  let currentAcceptedDecision: MandateDecision | null = null;
  if (source.head) {
    const resolvedHead = await resolveHead(await mandateHeadReference(source.head));
    need([...heads.values()].every(record => record.head.mandateId === source.head!.mandateId && record.head.mandateEpoch <= source.head!.mandateEpoch));
    currentAccepted = accepted.get(`${source.head.mandateId}:${source.head.mandateVersion}`)!; need(currentAccepted);
    const bound = acceptedDecision.get(key(currentAccepted))!;
    currentAcceptedProposal = bound.proposal; currentAcceptedDecision = bound.decision;
    need(equalMandateValue(resolvedHead.head, source.head) && [...accepted.values()].every(record => record.id === currentAccepted!.id && record.version <= currentAccepted!.version));
  } else need(heads.size === 0 && accepted.size === 0);
  const selected = source.selectedProposal ? proposals.get(key(source.selectedProposal)) : null;
  if (source.selectedProposal) need(selected && equalMandateValue(source.selectedProposal, mandateReference(selected)));
  const selectedDecision = selected ? latestDecision.get(key(selected))! : null;
  const referenced = new Map<string, Responsibility>([[key(current), current]]);
  const outputDocuments = new Map<string, PolicyDocumentVersion>();
  for (const proposal of [selected, currentAcceptedProposal]) {
    if (!proposal) continue;
    const snapshot = await resolveResponsibility(proposal.responsibility);
    if (!reader.siteIds.includes(snapshot.siteId)) throw new DomainError('FORBIDDEN', 403, 'Current read access to each historical policy site is required.');
    referenced.set(key(snapshot), snapshot);
    for (const reference of [proposal.policy.acceptancePolicy, proposal.policyDocument]) {
      const row = documents.get(key(reference))!; outputDocuments.set(key(row.document), row.document);
    }
  }
  const context: MandateCurrentContext = { organizationId: source.organizationId, environment: source.environment, organizationEpoch: source.organizationEpoch,
    now: source.now, responsibility: current, site: currentSite, acceptedVersion: currentAccepted, head: source.head,
    documents: [...documents.values()].map(row => row.document) };
  const requesterRows = unique(source.requesters, row => row.actor.actorId);
  for (const row of requesterRows.values()) currentReadActor(row, source);
  const requester = (id: string) => { const row = requesterRows.get(id); return row ? currentReadActor(row, source) : null; };
  const eligible = (action: MandateEligibility['action'], blockers: string[]): MandateEligibility => ({ action, eligible: blockers.length === 0,
    requiresStepUp: action === 'AUTHORIZE' || action === 'RESUME', blockers: [...new Set(blockers)] });
  const actorBlockers = (roles: string[]) => {
    try { assertMandateActor(reader, context, roles); return currentSite.active ? [] : ['SITE_UNAVAILABLE']; }
    catch (error) { if (error instanceof DomainError) return [error.code]; throw error; }
  };
  const proposeBlockers = actorBlockers(['owner', 'finance', 'operations']);
  if (!current.acceptancePolicy.trim()) proposeBlockers.push('ACCEPTANCE_POLICY_REQUIRED');
  const eligibility: MandateEligibility[] = [eligible('PROPOSE', proposeBlockers)];
  if (selected && selectedDecision) {
    const author = requester(selected.requesterId);
    if (author) eligibility.push(...await mandateDecisionEligibility(selected, selectedDecision, { ...context, actor: reader, requester: author }));
    else eligibility.push(eligible('AUTHORIZE', ['REQUESTER_INELIGIBLE']), eligible('REJECT', ['REQUESTER_INELIGIBLE']));
  } else eligibility.push(eligible('AUTHORIZE', ['NO_PROPOSAL']), eligible('REJECT', ['NO_PROPOSAL']));
  const authority = effectiveAuthority(source, currentAcceptedProposal, currentSite);
  for (const action of ['PAUSE', 'REVOKE', 'RESUME'] as const) {
    const blockers = actorBlockers(['owner', 'finance']);
    if (!source.head) blockers.push('NO_AUTHORITY');
    else if (['REVOKED', 'EXPIRED'].includes(source.head.state) || instant(source.head.expiresAt) <= instant(source.now)) blockers.push('AUTHORITY_TERMINAL');
    else if ((action === 'PAUSE' && source.head.state !== 'ACTIVE') || (action === 'RESUME' && source.head.state !== 'PAUSED')) blockers.push('AUTHORITY_CHANGED');
    if (action === 'RESUME' && currentAcceptedProposal) {
      const author = requester(currentAcceptedProposal.requesterId);
      if (!author) blockers.push('REQUESTER_INELIGIBLE');
      else { try { assertMandateActor(author, context, ['owner', 'finance', 'operations']); } catch (error) { if (error instanceof DomainError) blockers.push('REQUESTER_INELIGIBLE'); else throw error; } }
      if (reader.actorId === currentAcceptedProposal.requesterId) blockers.push('INDEPENDENT_APPROVER_REQUIRED');
      if (source.organizationEpoch !== currentAcceptedProposal.organizationEpoch || !equalMandateValue(await mandateResponsibilityReference(current), currentAcceptedProposal.responsibility)) blockers.push('AUTHORITY_CHANGED');
    }
    eligibility.push(eligible(action, blockers));
  }
  const decisionState = selected && selectedDecision ? await effectiveDecision(source, selected, selectedDecision) : null;
  return immutable(MandateReviewSchema.parse({ schemaVersion: 1, effectiveAuthority: authority, effectiveDecisionState: decisionState,
    responsibilityVersions: [...referenced.values()], envelope: { schemaVersion: 1, observedAt: source.now, organizationEpoch: source.organizationEpoch,
      responsibility: current, responsibilityReference: await mandateResponsibilityReference(current), site: { id: currentSite.id, name: currentSite.name, timeZone: currentSite.timeZone },
      proposal: selected ?? null, decision: selectedDecision, acceptedVersion: currentAccepted, head: source.head,
      acceptedProposal: currentAcceptedProposal, acceptedDecision: currentAcceptedDecision, financialState: null, policyDocuments: [...outputDocuments.values()],
      eligibility, supportedPolicy: { mode: 'ADVISE', financialActions: [], monetaryBudgets: false, supplierReferences: false, outboundCommunication: false }, operation: null } }));
}

async function effectiveDecision(source: MandateReadSource, proposal: MandateProposalVersion, decision: MandateDecision): Promise<NonNullable<MandateReview['effectiveDecisionState']>> {
  if (decision.state !== 'OPEN') return decision.state;
  if (instant(proposal.expiresAt) <= instant(source.now)) return 'EXPIRED';
  if (proposal.organizationEpoch !== source.organizationEpoch || !equalMandateValue(proposal.responsibility, await mandateResponsibilityReference(source.currentResponsibility)) ||
      !equalMandateValue(proposal.expectedHead, source.head ? await mandateHeadReference(source.head) : null) ||
      !source.sites.find(site => site.id === source.currentResponsibility.siteId)?.active) return 'STALE';
  return 'OPEN';
}

/** Selection/cursor are repository output, not a substitute for authorization; every selected summary derives from validated history. */
export async function projectMandatePage(source: MandateReadSource, selection: { proposals: Reference[]; nextCursor: string | null }): Promise<MandatePage> {
  try {
    const snapshot = immutable(structuredClone(source)), selected = immutable(structuredClone(selection));
    need(selected.proposals.length <= 25 && new Set(selected.proposals.map(item => item.id)).size === selected.proposals.length);
    const review = await project({ ...snapshot, selectedProposal: null });
    const items = [];
    for (const reference of selected.proposals) {
      const proposal = snapshot.proposals.find(record => equalMandateValue(mandateReference(record), reference)); need(proposal);
      need(snapshot.proposals.every(record => record.id !== proposal.id || record.version <= proposal.version));
      const decision = snapshot.decisions.filter(record => equalMandateValue(record.proposal, reference)).sort((a, b) => b.version - a.version)[0]; need(decision);
      if (!snapshot.reader.actor.siteIds.includes(proposal.responsibility.siteId)) throw new DomainError('FORBIDDEN', 403, 'Current read access to each proposal site is required.');
      items.push({ proposal: reference, mandateId: proposal.mandateId, responsibility: proposal.responsibility, requesterId: proposal.requesterId,
        decisionState: decision.state, effectiveDecisionState: await effectiveDecision(snapshot, proposal, decision), createdAt: proposal.createdAt, expiresAt: proposal.expiresAt });
    }
    return immutable(MandatePageSchema.parse({ schemaVersion: 1, organizationId: snapshot.organizationId, environment: snapshot.environment,
      organizationEpoch: snapshot.organizationEpoch, responsibility: review.envelope.responsibility, responsibilityReference: review.envelope.responsibilityReference,
      site: review.envelope.site, items, nextCursor: selected.nextCursor,
      acceptedVersion: review.envelope.acceptedVersion ? await mandateVersionReference(review.envelope.acceptedVersion) : null,
      head: review.envelope.head, effectiveAuthority: review.effectiveAuthority,
      eligibility: review.envelope.eligibility.filter(item => ['PROPOSE', 'PAUSE', 'REVOKE', 'RESUME'].includes(item.action)), observedAt: snapshot.now }));
  } catch (error) { if (error instanceof DomainError && error.code === 'FORBIDDEN') throw error; return fail(); }
}

function effectiveAuthority(source: MandateReadSource, acceptedProposal: MandateProposalVersion | null, site: MandateReadSite): MandateEffectiveAuthority {
  const head = source.head;
  if (!head) return { state: 'NONE', blockers: ['NO_AUTHORITY'] };
  if (head.state === 'REVOKED') return { state: 'REVOKED', blockers: ['AUTHORITY_REVOKED'] };
  if (head.state === 'EXPIRED' || instant(head.expiresAt) <= instant(source.now)) return { state: 'EXPIRED', blockers: ['AUTHORITY_EXPIRED'] };
  const blockers: string[] = [];
  if (head.organizationEpoch !== source.organizationEpoch) blockers.push('ORGANIZATION_CHANGED');
  if (!acceptedProposal || acceptedProposal.responsibility.id !== source.currentResponsibility.id ||
      acceptedProposal.responsibility.version !== source.currentResponsibility.version || acceptedProposal.responsibility.siteId !== source.currentResponsibility.siteId) blockers.push('RESPONSIBILITY_CHANGED');
  if (!site.active) blockers.push('SITE_UNAVAILABLE');
  if (blockers.length) return { state: 'STALE', blockers };
  return head.state === 'PAUSED' ? { state: 'PAUSED', blockers: ['AUTHORITY_PAUSED'] } : { state: 'ACTIVE', blockers: [] };
}
