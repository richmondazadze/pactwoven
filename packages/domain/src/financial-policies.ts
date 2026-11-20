import { EnvironmentSchema, IdSchema, HashSchema, FinancialPolicyActorSchema, FinancialPolicyCommandSchema, FinancialPolicyRecordSchema,
  FinancialPolicyDecisionIntentSchema, FinancialGovernanceBundleSchema, FinancialPolicyRefSchema, FinancialPolicyTextSchema, FinancialPolicyInstantSchema,
  type FinancialPolicyActor, type FinancialPolicyCommand, type FinancialPolicyRecord, type FinancialGovernanceProposal,
  type FinancialGovernanceBundle, type FinancialPolicyRef, type FinancialPolicyDecisionIntent } from '@pactwoven/contracts';
import { commandDigest, canonicalJson } from './canonical.js';
import { immutable } from './authority.js';
import { DomainError } from './errors.js';

const invalid = () => new DomainError('FINANCIAL_POLICY_INVALID', 422, 'Exact financial-policy records and material references are required.');
export async function financialPolicyTextHash(text: string): Promise<string> {
  return commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text: FinancialPolicyTextSchema.parse(text) });
}
export async function financialBudgetAccountId(environment: string, organizationId: string, assetKey: string): Promise<string> {
  return commandDigest({ namespace: 'pactwoven:financial-budget-account:v1', environment: EnvironmentSchema.parse(environment),
    organizationId: IdSchema.parse(organizationId), assetKey: HashSchema.parse(assetKey), category: 'supplier_principal' });
}
export async function financialBudgetPeriodId(budgetAccountId: string, startsAt: string, endsAt: string): Promise<string> {
  const start = FinancialPolicyInstantSchema.parse(startsAt), end = FinancialPolicyInstantSchema.parse(endsAt);
  if (start >= end) throw invalid();
  return commandDigest({ namespace: 'pactwoven:financial-budget-period:v1', budgetAccountId: HashSchema.parse(budgetAccountId), startsAt: start, endsAt: end });
}
export async function financialPolicyCommandHash(actorId: string, input: FinancialPolicyCommand): Promise<string> {
  return commandDigest({ namespace: 'pactwoven:financial-policy-command:v1', actorId: IdSchema.parse(actorId), command: FinancialPolicyCommandSchema.parse(input) });
}
export async function financialPolicyRecordHash(input: FinancialPolicyRecord): Promise<string> {
  const record = FinancialPolicyRecordSchema.parse(input);
  return commandDigest({ namespace: `pactwoven:financial-policy-${record.kind}:v1`, record });
}
export async function financialPolicyRecordRef(input: FinancialPolicyRecord): Promise<FinancialPolicyRef> {
  const record = FinancialPolicyRecordSchema.parse(input);
  return immutable({ id: record.id, version: record.version, recordHash: await financialPolicyRecordHash(record) });
}
export async function validateFinancialGovernanceBundle(environment: string, organizationId: string, input: FinancialGovernanceBundle): Promise<FinancialGovernanceBundle> {
  const bundle = FinancialGovernanceBundleSchema.parse(input);
  if (bundle.budgetAccountId !== await financialBudgetAccountId(environment, organizationId, bundle.asset.key) ||
    bundle.period.id !== await financialBudgetPeriodId(bundle.budgetAccountId, bundle.period.startsAt, bundle.period.endsAt)) throw invalid();
  return immutable(bundle);
}
/** Structural and predecessor validation only; current database authority is checked under locks. */
export async function validateFinancialPolicyRecord(input: FinancialPolicyRecord, previous: FinancialPolicyRecord | null = null): Promise<FinancialPolicyRecord> {
  const record = FinancialPolicyRecordSchema.parse(input);
  if (previous === null ? record.version !== 1 || record.predecessor !== null :
    record.kind !== previous.kind || record.id !== previous.id || record.environment !== previous.environment || record.organizationId !== previous.organizationId ||
    record.responsibilityId !== previous.responsibilityId || record.version !== previous.version + 1 ||
    canonicalJson(record.predecessor) !== canonicalJson(await financialPolicyRecordRef(previous))) throw invalid();
  if (record.kind === 'document') {
    if (record.contentHash !== await financialPolicyTextHash(record.text) || previous?.kind === 'document' && (record.purpose !== previous.purpose || record.actor.actorId !== previous.actor.actorId)) throw invalid();
  } else if (record.kind === 'draft') {
    if (record.draft.scope.authorityHash !== await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: record.draft.scope.authority }) ||
      previous === null && record.state !== 'DRAFT' || previous?.kind === 'draft' && (previous.state !== 'DRAFT' ||
        record.requester.actorId !== previous.requester.actorId || record.requester.subject !== previous.requester.subject ||
        record.state === 'WITHDRAWN' && canonicalJson(record.draft) !== canonicalJson(previous.draft))) throw invalid();
  } else {
    await validateFinancialGovernanceBundle(record.environment, record.organizationId, record.bundle);
    if (record.createdAt >= record.expiresAt && record.state !== 'REJECTED' || previous === null && record.state !== 'OPEN' ||
      previous?.kind === 'governance' && (previous.state !== 'OPEN' || record.proposer.actorId !== previous.proposer.actorId || record.proposer.subject !== previous.proposer.subject ||
        record.state !== 'OPEN' && (canonicalJson(record.bundle) !== canonicalJson(previous.bundle) || canonicalJson(record.expectedControl) !== canonicalJson(previous.expectedControl) ||
          record.decisionNonce !== previous.decisionNonce || record.expiresAt !== previous.expiresAt))) throw invalid();
  }
  return immutable(record);
}
export async function financialPolicyDecisionIntent(proposalInput: FinancialGovernanceProposal, approverInput: FinancialPolicyActor, key: string,
  organizationEpoch: number): Promise<{ intent: FinancialPolicyDecisionIntent; intentHash: string; requestHash: string }> {
  const proposal = FinancialPolicyRecordSchema.parse(proposalInput), approver = FinancialPolicyActorSchema.parse(approverInput);
  if (proposal.kind !== 'governance' || proposal.state !== 'OPEN' || proposal.proposer.actorId === approver.actorId || proposal.proposer.subject === approver.subject ||
    proposal.proposer.externalMembershipId === approver.externalMembershipId || proposal.organizationEpoch !== organizationEpoch) throw invalid();
  const intent = FinancialPolicyDecisionIntentSchema.parse({ schemaVersion: 1, purpose: 'financial_policy_authorization', environment: proposal.environment,
    organizationId: proposal.organizationId, proposal: FinancialPolicyRefSchema.parse(await financialPolicyRecordRef(proposal)), control: proposal.expectedControl,
    proposer: proposal.proposer, approver, organizationEpoch, key, nonce: proposal.decisionNonce });
  return immutable({ intent, intentHash: await commandDigest(intent),
    requestHash: await commandDigest({ schemaVersion: 1, purpose: intent.purpose, request: { nonce: intent.nonce, key: intent.key, intent } }) });
}
