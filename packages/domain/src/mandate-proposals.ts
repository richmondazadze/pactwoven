import {
  ActorContextSchema, MandateDecisionSchema, MandateHeadSchema, MandatePolicySchema, MandateProposalVersionSchema,
  MandateVersionSchema, PolicyDocumentVersionSchema, CreatePolicyDocumentCommandSchema, ProposeMandateCommandSchema,
  ResponsibilitySchema, type ActorContext, type CreatePolicyDocumentCommand, type Environment, type MandateDecision,
  type MandateHead, type MandateHeadReference, type MandatePolicy, type MandateProposalVersion, type MandateResponsibilityReference,
  type MandateVersion, type PolicyDocumentVersion, type ProposeMandateCommand, type Responsibility,
} from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';
import { validateMandatePolicy } from './authority.js';
import { DomainError } from './errors.js';
import { immutable, instant, nextVersion } from './financial-primitives.js';

type Reference = { id: string; version: number; hash: string };
/** All records here must be freshly resolved from authoritative storage, under the write transaction's locks. */
export type MandateCurrentContext = {
  organizationId: string; environment: Environment; organizationEpoch: number; now: string;
  responsibility: Responsibility;
  site: { id: string; organizationId: string; environment: Environment; active: boolean };
  acceptedVersion: MandateVersion | null; head: MandateHead | null; documents: PolicyDocumentVersion[];
};

/** NFC and line endings only. Spaces, indentation and terminal newlines remain meaningful. */
export function normalizePolicyText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n');
}
function withoutHash<T extends { hash: string }>(value: T): Omit<T, 'hash'> {
  const { hash: _hash, ...record } = value;
  return record;
}
export function mandateReference(value: { id: string; version: number; hash: string }): Reference {
  return immutable({ id: value.id, version: value.version, hash: value.hash });
}
export async function mandateVersionReference(value: MandateVersion): Promise<Reference> {
  const parsed = MandateVersionSchema.parse(value);
  return immutable({ id: parsed.id, version: parsed.version, hash: await commandDigest(parsed) });
}
export async function mandateHeadReference(value: MandateHead): Promise<MandateHeadReference> {
  const parsed = MandateHeadSchema.parse(value);
  return immutable({ mandateId: parsed.mandateId, mandateVersion: parsed.mandateVersion, mandateEpoch: parsed.mandateEpoch, hash: await commandDigest(parsed) });
}
export async function mandateResponsibilityReference(value: Responsibility): Promise<MandateResponsibilityReference> {
  const parsed = ResponsibilitySchema.parse(value);
  return immutable({ id: parsed.id, version: parsed.version, siteId: parsed.siteId, hash: await commandDigest(parsed) });
}
export function equalMandateValue(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

export async function validatePolicyDocumentVersion(input: PolicyDocumentVersion): Promise<PolicyDocumentVersion> {
  const document = PolicyDocumentVersionSchema.parse(input);
  if (document.text !== normalizePolicyText(document.text) || document.contentHash !== await commandDigest(document.text) ||
      document.hash !== await commandDigest(withoutHash(document)) ||
      (document.version === 1 ? document.previousVersion !== null : !document.previousVersion ||
        document.previousVersion.id !== document.id || document.previousVersion.version !== document.version - 1)) {
    throw new DomainError('POLICY_DOCUMENT_INVALID', 409, 'Exact normalized policy text and its immutable version are required.');
  }
  return immutable(document);
}
export async function createPolicyDocumentVersion(context: { actor: ActorContext; now: string }, commandInput: CreatePolicyDocumentCommand,
  previousInput: PolicyDocumentVersion | null): Promise<PolicyDocumentVersion> {
  const command = CreatePolicyDocumentCommandSchema.parse(commandInput);
  const actor = ActorContextSchema.parse(context.actor);
  if (actor.principalKind !== 'human' || !actor.roles.some(role => ['owner', 'finance', 'operations'].includes(role)) || instant(actor.authenticatedAt) > instant(context.now)) {
    throw new DomainError('FORBIDDEN', 403, 'A current human buyer may author policy documents.');
  }
  const previous = previousInput ? await validatePolicyDocumentVersion(previousInput) : null;
  if (command.expectedVersion !== (previous?.version ?? 0) || !equalMandateValue(command.previousVersion, previous ? mandateReference(previous) : null) ||
      (previous && (previous.id !== command.documentId || previous.organizationId !== actor.organizationId || previous.environment !== actor.environment ||
        previous.purpose !== command.purpose || instant(previous.createdAt) > instant(context.now)))) {
    throw new DomainError('VERSION_CONFLICT', 409, 'The exact preceding policy document is required.');
  }
  const text = normalizePolicyText(command.text);
  const record = { schemaVersion: 1 as const, id: command.documentId, version: nextVersion(command.expectedVersion),
    organizationId: actor.organizationId, environment: actor.environment, purpose: command.purpose,
    normalization: 'NFC_LF_V1' as const, text, contentHash: await commandDigest(text),
    previousVersion: previous ? mandateReference(previous) : null, createdAt: context.now, createdBy: actor.actorId };
  return immutable(PolicyDocumentVersionSchema.parse({ ...record, hash: await commandDigest(record) }));
}

export function assertMandateActor(actorInput: ActorContext, context: MandateCurrentContext, roles: readonly string[]): ActorContext {
  const actor = ActorContextSchema.parse(actorInput);
  if (actor.principalKind !== 'human' || actor.organizationId !== context.organizationId || actor.environment !== context.environment ||
      !actor.roles.some(role => roles.includes(role)) || !actor.siteIds.includes(context.responsibility.siteId) ||
      !actor.actionSiteIds.includes(context.responsibility.siteId) || instant(actor.authenticatedAt) > instant(context.now)) {
    throw new DomainError('FORBIDDEN', 403, 'A current qualified human with an explicit action-site grant is required.');
  }
  return actor;
}

/** A historical accepted version may have an older epoch or expiry; its current head must still match that immutable version. */
export async function validateMandateCurrentContext(context: MandateCurrentContext): Promise<void> {
  const responsibility = ResponsibilitySchema.parse(context.responsibility);
  instant(context.now);
  if (!Number.isSafeInteger(context.organizationEpoch) || context.organizationEpoch < 0 ||
      responsibility.organizationId !== context.organizationId || responsibility.environment !== context.environment ||
      context.site.organizationId !== context.organizationId || context.site.environment !== context.environment ||
      context.site.id !== responsibility.siteId || context.site.active !== true) {
    throw new DomainError('SITE_UNAVAILABLE', 409, 'The responsibility and active site must resolve in the current organization and environment.');
  }
  if ((context.acceptedVersion === null) !== (context.head === null)) {
    throw new DomainError('AUTHORITY_CHANGED', 409, 'Accepted authority and its current head must resolve together.');
  }
  if (context.acceptedVersion && context.head) {
    const accepted = MandateVersionSchema.parse(context.acceptedVersion);
    const head = MandateHeadSchema.parse(context.head);
    if (accepted.id !== head.mandateId || accepted.version !== head.mandateVersion || accepted.responsibilityId !== responsibility.id ||
        head.responsibilityId !== responsibility.id || accepted.organizationId !== context.organizationId || head.organizationId !== context.organizationId ||
        accepted.environment !== context.environment || head.environment !== context.environment || accepted.organizationEpoch !== head.organizationEpoch ||
        accepted.organizationEpoch > context.organizationEpoch || accepted.mandateEpoch > head.mandateEpoch ||
        accepted.policyHash !== head.policyHash || accepted.policyHash !== await commandDigest(accepted.policy) ||
        instant(accepted.createdAt) > instant(context.now) || instant(head.expiresAt) > instant(accepted.policy.expiresAt)) {
      throw new DomainError('AUTHORITY_CHANGED', 409, 'The exact last accepted version and current authority head are required.');
    }
  }
}

export function validateConnectedMandatePolicy(input: MandatePolicy, siteId: string, now: string): MandatePolicy {
  const parsed = MandatePolicySchema.parse(input);
  if (parsed.mode !== 'ADVISE' || parsed.siteIds.length !== 1 || parsed.siteIds[0] !== siteId || parsed.actions.length || parsed.budgets.length ||
      parsed.supplierRelationshipIds.length || parsed.communication.maximumMessages !== 0 || parsed.communication.recipientIds.length ||
      parsed.communication.purposes.length || parsed.communication.messageKinds.length) {
    throw new DomainError('MANDATE_POLICY_UNSUPPORTED', 422, 'Connected mandates support advice for this responsibility site, with no financial, supplier or outbound communication effects.');
  }
  return validateMandatePolicy({ ...parsed, expiresAt: new Date(instant(parsed.expiresAt)).toISOString(),
    communication: { ...parsed.communication, expiresAt: new Date(instant(parsed.communication.expiresAt)).toISOString() } }, now);
}
async function resolveDocument(reference: Reference, purpose: PolicyDocumentVersion['purpose'], context: MandateCurrentContext): Promise<PolicyDocumentVersion> {
  const matches = context.documents.filter(document => document.id === reference.id && document.version === reference.version);
  if (matches.length !== 1) throw new DomainError('POLICY_DOCUMENT_UNAVAILABLE', 409, 'Each full policy document must resolve to one authoritative version.');
  const document = await validatePolicyDocumentVersion(matches[0]!);
  if (!equalMandateValue(reference, mandateReference(document)) || document.purpose !== purpose ||
      document.organizationId !== context.organizationId || document.environment !== context.environment || instant(document.createdAt) > instant(context.now)) {
    throw new DomainError('POLICY_DOCUMENT_UNAVAILABLE', 409, 'The policy document purpose, tenant, version and hash must match exactly.');
  }
  return document;
}
export async function resolveMandatePolicyDocuments(proposal: MandateProposalVersion, context: MandateCurrentContext): Promise<PolicyDocumentVersion[]> {
  const acceptance = await resolveDocument(proposal.policy.acceptancePolicy, 'ACCEPTANCE_POLICY', context);
  const policy = await resolveDocument(proposal.policyDocument, 'MANDATE_POLICY', context);
  if (acceptance.text !== normalizePolicyText(context.responsibility.acceptancePolicy)) {
    throw new DomainError('POLICY_DOCUMENT_CHANGED', 409, 'The complete acceptance document must match this responsibility version.');
  }
  return immutable([acceptance, policy]);
}
export async function validateMandateProposalVersion(input: MandateProposalVersion): Promise<MandateProposalVersion> {
  const proposal = MandateProposalVersionSchema.parse(input);
  if (proposal.hash !== await commandDigest(withoutHash(proposal)) || proposal.policyHash !== await commandDigest(proposal.policy) ||
      (proposal.version === 1 ? proposal.previousProposal !== null : !proposal.previousProposal ||
        proposal.previousProposal.id !== proposal.id || proposal.previousProposal.version !== proposal.version - 1) ||
      (proposal.previousAcceptedVersion === null) !== (proposal.expectedHead === null) ||
      (proposal.previousAcceptedVersion && (proposal.previousAcceptedVersion.id !== proposal.mandateId ||
        proposal.expectedHead!.mandateId !== proposal.mandateId || proposal.previousAcceptedVersion.version !== proposal.expectedHead!.mandateVersion)) ||
      instant(proposal.createdAt) >= instant(proposal.expiresAt) || instant(proposal.expiresAt) > instant(proposal.policy.expiresAt)) {
    throw new DomainError('PROPOSAL_INVALID', 409, 'The complete immutable mandate proposal and its version bindings are required.');
  }
  return immutable(proposal);
}
export async function assertMandateProposalCurrent(input: MandateProposalVersion, context: MandateCurrentContext): Promise<MandateProposalVersion> {
  const proposal = await validateMandateProposalVersion(input);
  await validateMandateCurrentContext(context);
  if (proposal.organizationId !== context.organizationId || proposal.environment !== context.environment || proposal.organizationEpoch !== context.organizationEpoch) {
    throw new DomainError('ORGANIZATION_CHANGED', 409, 'The organization authority changed after this proposal.');
  }
  if (!equalMandateValue(proposal.responsibility, await mandateResponsibilityReference(context.responsibility))) {
    throw new DomainError('RESPONSIBILITY_CHANGED', 409, 'The exact current responsibility version and site are required.');
  }
  if (!equalMandateValue(proposal.previousAcceptedVersion, context.acceptedVersion ? await mandateVersionReference(context.acceptedVersion) : null) ||
      !equalMandateValue(proposal.expectedHead, context.head ? await mandateHeadReference(context.head) : null) ||
      (context.head && proposal.mandateId !== context.head.mandateId)) {
    throw new DomainError('AUTHORITY_CHANGED', 409, 'The accepted predecessor or current authority head changed after this proposal.');
  }
  if (instant(proposal.createdAt) > instant(context.now) || instant(proposal.expiresAt) <= instant(context.now)) {
    throw new DomainError('PROPOSAL_EXPIRED', 409, 'This proposal is outside its decision window.');
  }
  const policy = validateConnectedMandatePolicy(proposal.policy, context.responsibility.siteId, context.now);
  if (!equalMandateValue(policy, proposal.policy)) throw new DomainError('PROPOSAL_INVALID', 409, 'Policy instants must use the normalized representation.');
  await resolveMandatePolicyDocuments(proposal, context);
  return proposal;
}
export function validateMandateDecision(input: MandateDecision, proposal: MandateProposalVersion): MandateDecision {
  const decision = MandateDecisionSchema.parse(input);
  if (!equalMandateValue(decision.proposal, mandateReference(proposal)) || decision.createdAt !== proposal.createdAt) {
    throw new DomainError('DECISION_CHANGED', 409, 'The decision must belong to the exact immutable proposal.');
  }
  return immutable(decision);
}
export function assertMandateDecisionOpen(decision: MandateDecision): void {
  if (decision.state !== 'OPEN') throw new DomainError('DECISION_TERMINAL', 409, 'This proposal already has a terminal decision; recover its original operation.');
}

/** Pure transaction plan: persist the proposal, OPEN decision and any superseded prior decision atomically. */
export async function createMandateProposal(context: MandateCurrentContext & {
  actor: ActorContext; operationId: string; previousProposal: MandateProposalVersion | null; previousDecision: MandateDecision | null;
}, input: ProposeMandateCommand): Promise<{ proposal: MandateProposalVersion; decision: MandateDecision; supersededDecision: MandateDecision | null }> {
  const command = ProposeMandateCommandSchema.parse(input);
  await validateMandateCurrentContext(context);
  const actor = assertMandateActor(context.actor, context, ['owner', 'finance', 'operations']);
  const previous = context.previousProposal ? await validateMandateProposalVersion(context.previousProposal) : null;
  if (command.expectedProposalVersion !== (previous?.version ?? 0) || !equalMandateValue(command.previousProposal, previous ? mandateReference(previous) : null) ||
      (previous === null) !== (context.previousDecision === null) || (previous && (previous.id !== command.proposalId ||
        previous.organizationId !== context.organizationId || previous.environment !== context.environment || previous.requesterId !== actor.actorId ||
        previous.mandateId !== command.mandateId || previous.responsibility.id !== context.responsibility.id))) {
    throw new DomainError('VERSION_CONFLICT', 409, 'The exact current proposal version and its requester are required for a replacement.');
  }
  let priorDecision: MandateDecision | null = null;
  if (previous && context.previousDecision) {
    priorDecision = validateMandateDecision(context.previousDecision, previous);
    assertMandateDecisionOpen(priorDecision);
    if (instant(previous.expiresAt) <= instant(context.now) || instant(previous.createdAt) > instant(context.now)) {
      throw new DomainError('PROPOSAL_EXPIRED', 409, 'An expired proposal cannot be edited into a fresh decision; create a new proposal.');
    }
  }
  const policy = validateConnectedMandatePolicy(command.policy, context.responsibility.siteId, context.now);
  const record = { schemaVersion: 1 as const, id: command.proposalId, version: nextVersion(command.expectedProposalVersion),
    previousProposal: previous ? mandateReference(previous) : null, organizationId: context.organizationId, environment: context.environment,
    organizationEpoch: command.expectedOrganizationEpoch, mandateId: command.mandateId, responsibility: command.responsibility,
    requesterId: actor.actorId, previousAcceptedVersion: command.previousAcceptedVersion, expectedHead: command.expectedHead,
    policy, policyHash: await commandDigest(policy), policyDocument: command.policyDocument, createdAt: context.now,
    expiresAt: new Date(instant(command.expiresAt)).toISOString() };
  const proposal = await assertMandateProposalCurrent({ ...record, hash: await commandDigest(record) }, context);
  const decision = immutable(MandateDecisionSchema.parse({ proposal: mandateReference(proposal), version: 1, state: 'OPEN', createdAt: context.now,
    decidedAt: null, actorId: null, intentHash: null, reason: null, replacement: null, authorization: null, operationId: context.operationId }));
  const supersededDecision = priorDecision ? immutable(MandateDecisionSchema.parse({ ...priorDecision, version: 2, state: 'SUPERSEDED',
    decidedAt: context.now, actorId: actor.actorId, replacement: mandateReference(proposal), operationId: context.operationId })) : null;
  return immutable({ proposal, decision, supersededDecision });
}

/** Expiry closes only the proposal decision. It never changes money, coverage, execution or an accepted authority head. */
export async function expireMandateProposal(input: MandateProposalVersion, decisionInput: MandateDecision, context: { now: string; operationId: string }): Promise<MandateDecision> {
  const proposal = await validateMandateProposalVersion(input);
  const decision = validateMandateDecision(decisionInput, proposal);
  assertMandateDecisionOpen(decision);
  if (instant(context.now) < instant(proposal.expiresAt)) throw new DomainError('PROPOSAL_CURRENT', 409, 'This proposal has not expired.');
  return immutable(MandateDecisionSchema.parse({ ...decision, version: 2, state: 'EXPIRED', decidedAt: context.now, operationId: context.operationId }));
}
