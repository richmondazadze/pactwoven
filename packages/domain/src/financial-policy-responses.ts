import { z } from 'zod';
import { EnvironmentSchema, IdSchema, HashSchema, FinancialPolicyVersionSchema, FinancialPolicyUuidSchema,
  FinancialPolicyRecordSchema, FinancialPolicyRefSchema, FinancialPolicyReadSchema, FinancialPolicyCommandSchema,
  FinancialPolicyResultSchema, FinancialPolicyDecisionIntentSchema, FinancialPolicyHttpRequestSchema,
  FinancialPolicyHttpRecordSchema, FinancialPolicyHttpPolicyViewSchema, FinancialPolicyHttpBudgetObservationSchema,
  FinancialPolicyHttpReceiptSchema, type FinancialPolicyActor, type FinancialPolicyRecord,
  type FinancialPolicyCommand, type FinancialPolicyResult, type FinancialPolicyHttpRecord,
  type FinancialPolicyHttpPolicyView, type FinancialPolicyHttpReceipt } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';
import { immutable } from './financial-primitives.js';
import { financialPolicyRecordRef, financialPolicyTextHash, financialPolicyCommandHash,
  validateFinancialGovernanceBundle } from './financial-policies.js';
import { financialPolicyHttpRequestFromStoredCommand, financialPolicyHttpRequestHash } from './financial-policy-http.js';
import { DomainError } from './errors.js';

const selectorSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema,
  responsibilityId: IdSchema.nullable(), id: IdSchema, version: FinancialPolicyVersionSchema.nullable() });
const originalSchema = z.strictObject({ scope: z.strictObject({ environment: EnvironmentSchema,
  organizationId: IdSchema, actorId: IdSchema }), request: FinancialPolicyHttpRequestSchema, publicRequestHash: HashSchema });
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const unknown = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'The original financial-policy material could not be verified.');
const actor = (a: FinancialPolicyActor) => ({ actorId: a.actorId, membershipVersion: a.membershipVersion });
function evidenceRef(ref: z.infer<typeof FinancialPolicyRefSchema>) {
  FinancialPolicyUuidSchema.parse(ref.id);
  if (ref.version !== 1) throw unknown();
}
async function checkedRecord(expected: z.infer<typeof selectorSchema>, r: FinancialPolicyRecord,
  reference: z.infer<typeof FinancialPolicyRefSchema>): Promise<void> {
  if (r.version === 1 && (r.kind === 'draft' && r.state !== 'DRAFT' || r.kind === 'governance' && r.state !== 'OPEN')) throw unknown();
  if (r.environment !== expected.environment || r.organizationId !== expected.organizationId || r.responsibilityId !== expected.responsibilityId ||
    r.id !== expected.id || expected.version !== null && r.version !== expected.version || !equal(reference, await financialPolicyRecordRef(r))) throw unknown();
  evidenceRef(r.identityEvidence);
  if (r.kind === 'document') {
    if ((r.purpose === 'financial_mandate') !== (r.responsibilityId !== null) || r.contentHash !== await financialPolicyTextHash(r.text)) throw unknown();
  } else if (r.kind === 'draft') {
    if (r.draft.scope.authorityHash !== await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: r.draft.scope.authority }) ||
      r.requester.actorId !== r.actor.actorId || r.requester.subject !== r.actor.subject || r.state === 'DRAFT' && !equal(r.requester, r.actor)) throw unknown();
    // Unsupported historical trust cannot be disguised as an incomplete draft.
    if (r.draft.trust !== null) throw unknown();
  } else {
    await validateFinancialGovernanceBundle(r.environment, r.organizationId, r.bundle);
    if (r.state === 'OPEN') {
      if (!equal(r.proposer, r.actor)) throw unknown();
    } else {
      const d = r.decision;
      if (d === null || !equal(d.approverObservation, r.identityEvidence)) throw unknown();
      evidenceRef(d.proposerObservation); evidenceRef(d.approverObservation);
      if (r.state === 'ACCEPTED') {
        if (d.mfaEvidence === null || r.proposer.actorId === r.actor.actorId || r.proposer.subject === r.actor.subject ||
          r.proposer.externalMembershipId === r.actor.externalMembershipId || d.mfaEvidence.id === d.approverObservation.id ||
          d.mfaEvidence.id === d.proposerObservation.id) throw unknown();
        evidenceRef(d.mfaEvidence);
      }
    }
  }
}
function recordProjection(r: FinancialPolicyRecord): FinancialPolicyHttpRecord {
  const common = { schemaVersion: r.schemaVersion, environment: r.environment, organizationId: r.organizationId,
    id: r.id, version: r.version, predecessor: r.predecessor, actor: actor(r.actor), organizationEpoch: r.organizationEpoch,
    operationId: r.operationId, createdAt: r.createdAt };
  if (r.kind === 'document') return FinancialPolicyHttpRecordSchema.parse({ ...common, kind: r.kind, responsibilityId: r.responsibilityId,
    purpose: r.purpose, text: r.text, contentHash: r.contentHash });
  if (r.kind === 'draft') {
    const a = r.draft.scope.authority;
    return FinancialPolicyHttpRecordSchema.parse({ ...common, kind: r.kind, responsibilityId: r.responsibilityId,
      state: r.state, requester: actor(r.requester), draft: { ...r.draft, scope: { ...r.draft.scope,
        authority: { schemaVersion: a.schemaVersion, responsibility: a.responsibility, generation: a.generation, family: a.family, legacyHead: a.legacyHead } } } });
  }
  return FinancialPolicyHttpRecordSchema.parse({ ...common, kind: r.kind, responsibilityId: null, state: r.state,
    proposer: actor(r.proposer), bundle: r.bundle, expectedControl: r.expectedControl, expiresAt: r.expiresAt });
}

/** Pure allowlist projection. The caller must already have current private read permission. */
export async function projectFinancialPolicyHttpRecord(expectedScopeAndSelector: unknown, privateRecord: unknown,
  privateReference: unknown): Promise<FinancialPolicyHttpRecord> {
  try {
    const expected = immutable(selectorSchema.parse(expectedScopeAndSelector)), r = immutable(FinancialPolicyRecordSchema.parse(privateRecord)),
      reference = immutable(FinancialPolicyRefSchema.parse(privateReference));
    await checkedRecord(expected, r, reference);
    return immutable(recordProjection(r));
  } catch { throw unknown(); }
}

/** Currentness and budget control must be supplied by a coherent authorized read, never inferred from roles. */
export async function projectFinancialPolicyHttpView(expectedScopeAndSelector: unknown, privateRead: unknown,
  budgetObservation: unknown): Promise<FinancialPolicyHttpPolicyView> {
  try {
    const expected = immutable(selectorSchema.parse(expectedScopeAndSelector)), read = immutable(FinancialPolicyReadSchema.parse(privateRead)),
      budget = immutable(FinancialPolicyHttpBudgetObservationSchema.nullable().parse(budgetObservation));
    await checkedRecord(expected, read.record, read.reference);
    return immutable(FinancialPolicyHttpPolicyViewSchema.parse({ reference: read.reference, record: recordProjection(read.record),
      projection: { currentRecord: read.current, state: read.state, blockers: [...new Set(read.blockers)].sort() }, budgetConfiguration: budget }));
  } catch { throw unknown(); }
}

async function checkedResult(command: FinancialPolicyCommand, result: FinancialPolicyResult): Promise<void> {
  const r = result.body;
  if (command.environment !== result.environment || command.organizationId !== result.organizationId || command.responsibilityId !== result.responsibilityId ||
    command.id !== r.id || command.kind !== result.kind || command.key !== result.key || command.organizationEpoch !== r.organizationEpoch ||
    !equal(command.previous, r.predecessor) || result.id !== r.operationId || result.actorId !== r.actor.actorId ||
    result.commandHash !== await financialPolicyCommandHash(result.actorId, command)) throw unknown();
  await checkedRecord({ environment: result.environment, organizationId: result.organizationId, responsibilityId: result.responsibilityId,
    id: command.id, version: r.version }, r, result.target);
  switch (command.kind) {
    case 'save_document':
      if (r.kind !== 'document' || r.purpose !== command.purpose || r.text !== command.text) throw unknown(); break;
    case 'save_draft':
      if (r.kind !== 'draft' || r.state !== 'DRAFT' || !equal(r.draft, command.draft)) throw unknown(); break;
    case 'withdraw_draft':
      if (r.kind !== 'draft' || r.state !== 'WITHDRAWN') throw unknown(); break;
    case 'propose_governance':
      if (r.kind !== 'governance' || r.state !== 'OPEN' || !equal(r.bundle, command.bundle) ||
        !equal(r.expectedControl, command.expectedControl) || r.expiresAt !== command.expiresAt) throw unknown(); break;
    case 'accept_governance':
    case 'reject_governance': {
      if (r.kind !== 'governance' || r.state !== (command.kind === 'accept_governance' ? 'ACCEPTED' : 'REJECTED') || r.decision === null ||
        !equal(r.expectedControl, command.expectedControl) || r.decision.proposerObservation.id !== command.proposerEvidenceId) throw unknown();
      if (command.kind === 'accept_governance') {
        if (r.decisionNonce !== command.nonce || r.decision.mfaEvidence?.id !== command.mfaEvidenceId) throw unknown();
        // Validate the existing decision preimage from its exact predecessor REF;
        // this is not a reconstructed predecessor record or newly minted proof.
        const intent = FinancialPolicyDecisionIntentSchema.parse({ schemaVersion: 1, purpose: 'financial_policy_authorization',
          environment: r.environment, organizationId: r.organizationId, proposal: command.previous, control: command.expectedControl,
          proposer: r.proposer, approver: r.actor, organizationEpoch: command.organizationEpoch, key: command.key, nonce: command.nonce });
        if (r.decision.intentHash !== await commandDigest(intent) || r.decision.requestHash !== await commandDigest({
          schemaVersion: 1, purpose: 'financial_policy_authorization', request: { nonce: command.nonce, key: command.key, intent },
        })) throw unknown();
      }
      break;
    }
  }
}

/**
 * A historical receipt requires an exact stored/acknowledged command-result pair.
 * Current external identity and reciprocal persisted history are checked by the
 * private repository. This helper has no database, token, MFA or mutation path.
 */
export async function projectFinancialPolicyHttpReceipt(expectedPublicRequestAndScope: unknown, privateCommand: unknown,
  privateResult: unknown): Promise<FinancialPolicyHttpReceipt> {
  try {
    const expected = immutable(originalSchema.parse(expectedPublicRequestAndScope)), command = immutable(FinancialPolicyCommandSchema.parse(privateCommand)),
      result = immutable(FinancialPolicyResultSchema.parse(privateResult));
    if (result.environment !== expected.scope.environment || result.organizationId !== expected.scope.organizationId ||
      result.actorId !== expected.scope.actorId) throw unknown();
    await checkedResult(command, result);
    const request = await financialPolicyHttpRequestFromStoredCommand(expected.scope, command);
    if (!equal(request, expected.request) || expected.publicRequestHash !== await financialPolicyHttpRequestHash(expected.scope, request)) throw unknown();
    return immutable(FinancialPolicyHttpReceiptSchema.parse({ schemaVersion: 1, environment: result.environment, organizationId: result.organizationId,
      actor: actor(result.body.actor), responsibilityId: result.responsibilityId, operationId: result.id, kind: result.kind, key: result.key,
      publicRequestHash: expected.publicRequestHash, target: result.target, record: recordProjection(result.body),
      effectiveAuthority: false, financialState: null }));
  } catch { throw unknown(); }
}
