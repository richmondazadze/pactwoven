import { describe, expect, it } from 'vitest';
import type { MandateDecisionIntent, MandateOperationResult, MandateReview } from '@pactwoven/contracts';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { decisionAvailable, decisionDigests, mandateOperationSucceeded, prepareMandateDecision, qualifyMandateDecisionReceipt, qualifyMandateOperation } from './mandate-actions';
import { createMandateCapsule } from './mandate-capsule';
import { locatorFromCapsule } from './mandate-recovery';
import { decisionTestCase, mandateDecisionFixture, mandateFixtureNow, mandateFixtureTime } from './mandates.test-fixtures';
const vectors = [
  ['AUTHORIZE',null,'c78151bcf5a68acdda8d7dbc9377b2c31e02c0a311eeaf684abceae8c7fd542e','9d2235e83a1f589f63f6530b50057fac94ecaa1a5e74075a1db9d19fecfb4367'],
  ['REJECT','Reviewed terms require revision.','849e68a9fa1d0d357a5b40ff6491c32972003df49724f0fb76a1c35c94d8e0c3','f6cd446d4c5931171b4a04ef835f1ca3b75147b89f50143fd0c10ade46c3cf59'],
] as const;
// Independent root-authored constants; not recomputed through a second client helper.
it.each(vectors)('matches the independent %s command and purpose digest',async(action,reason,commandHash,intentHash)=>{
  const intent:MandateDecisionIntent={schemaVersion:1,action,proposal:{id:'proposal_a',version:3,hash:'a'.repeat(64)},expectedDecisionVersion:1,expectedOrganizationEpoch:7,expectedHead:null,reason};
  expect(await decisionDigests({environment:'development',organizationId:'org_a',actorId:'reviewer_a',responsibilityId:'responsibility_a'},intent)).toEqual({commandHash,intentHash});
});
describe('independent decisions',()=>{
  it('normalizes the rejection reason once and preserves internal whitespace',async()=>{const f=await decisionTestCase();expect(f.intent.reason).toBe('Revise these terms.\nKeep the signed copy.');expect(f.intent.proposal.version).toBe(3);expect(f.intent.expectedDecisionVersion).toBe(1);});
  it.each(['self','role','read-site','action-site','service','epoch','stale','expired','wrong-mfa'] as const)('blocks %s before preparing a new decision',async kind=>{
    const f=await mandateDecisionFixture();let now=mandateFixtureNow;
    if(kind==='self')f.scope.actorId=f.review.envelope.proposal!.requesterId;
    if(kind==='role')f.scope.roles=['operations'];if(kind==='read-site')f.scope.siteIds=[];if(kind==='action-site')f.scope.actionSiteIds=[];if(kind==='service')f.scope.principalKind='service';if(kind==='epoch')f.scope.organizationEpoch++;
    if(kind==='stale')now+=60000;if(kind==='expired')now+=600000;if(kind==='wrong-mfa')f.review.envelope.eligibility[0]!.requiresStepUp=false;
    expect(decisionAvailable(f.review,f.scope,'AUTHORIZE',now)).toBe(false);
    await expect(prepareMandateDecision(f.review,f.scope,'AUTHORIZE','',now)).rejects.toThrow();
  });
  it('requires full qualified original documents, not just eligibility',async()=>{const f=await mandateDecisionFixture();f.review.envelope.policyDocuments[0]!.text='substituted text';await expect(prepareMandateDecision(f.review,f.scope,'AUTHORIZE','',mandateFixtureNow)).rejects.toThrow();});
  it.each(['AUTHORIZE','REJECT'] as const)('qualifies %s receipts using original proposal version after reload',async action=>{const f=await decisionTestCase(action);await expect(qualifyMandateDecisionReceipt(f.outcomeReview,f.scope,f.locator,f.result)).resolves.toEqual(f.outcomeReview);expect(qualifyMandateOperation(f.result,f.locator).target.version).toBe(2);});
  it('rejects a receipt locator from another authenticated scope even when its record digests match',async()=>{const f=await decisionTestCase();await expect(qualifyMandateDecisionReceipt(f.outcomeReview,f.scope,{...f.locator,externalOrganizationId:'other'},f.result)).rejects.toThrow();});
  it.each(['organization','environment','kind','responsibility','target','version','command','intent'] as const)('rejects mixed %s operation identity',async field=>{const f=await decisionTestCase(),r=structuredClone(f.result);if(field==='organization')r.organizationId='foreign';if(field==='environment')r.operation.environment='production';if(field==='kind')r.kind='mandate.authorize';if(field==='responsibility')r.responsibilityId='foreign';if(field==='target'){r.target.id='foreign';r.operation.aggregateId='foreign';}if(field==='version'){r.target.version=3;r.operation.aggregateVersion=3;}if(field==='command')r.commandHash='f'.repeat(64);if(field==='intent')r.intentHash='f'.repeat(64);expect(()=>qualifyMandateOperation(r,f.locator)).toThrow();});
  it.each(['accepted','pending','unknown','failed'] as const)('does not close a %s operation',async status=>{const f=await decisionTestCase();f.result.operation.status=status;expect(mandateOperationSucceeded(f.result)).toBe(false);await expect(qualifyMandateDecisionReceipt(f.outcomeReview,f.scope,f.locator,f.result)).rejects.toThrow();});
  it.each(['error','next','evidence'] as const)('does not accept succeeded with unexpected %s fields',async field=>{const f=await decisionTestCase();if(field==='error')f.result.operation.error={code:'error',retryable:false,detailRef:null};if(field==='next')f.result.operation.nextCheckAt=mandateFixtureTime(2000);if(field==='evidence')f.result.operation.evidenceRefs=['unrecognized'];expect(mandateOperationSucceeded(f.result)).toBe(false);});
  it.each(['operation','actor','reason','time','digest'] as const)('rejects a mismatched recorded %s even with coherent response schemas',async field=>{const f=await decisionTestCase(),r=structuredClone(f.outcomeReview),d=r.envelope.decision!;if(field==='operation')d.operationId='other';if(field==='actor')d.actorId='other';if(field==='reason')d.reason='Different reason';if(field==='time')d.decidedAt=mandateFixtureTime(2000);if(field==='digest')f.result.target.hash='f'.repeat(64);await expect(qualifyMandateDecisionReceipt(r,f.scope,f.locator,f.result)).rejects.toThrow();});
  it('keeps a historical approval distinct from a later paused current head',async()=>{const f=await decisionTestCase('AUTHORIZE');f.outcomeReview.envelope.head!.state='PAUSED';f.outcomeReview.envelope.head!.mandateEpoch++;f.outcomeReview.effectiveAuthority={state:'PAUSED',blockers:['AUTHORITY_PAUSED']};const result=await qualifyMandateDecisionReceipt(f.outcomeReview,f.scope,f.locator,f.result);expect(result.effectiveAuthority.state).toBe('PAUSED');expect(result.envelope.decision!.state).toBe('APPROVED');});
  it('rejects forged accepted receipt references even when not the current accepted mandate',async()=>{const f=await decisionTestCase('AUTHORIZE'),r:MandateReview=structuredClone(f.outcomeReview);r.envelope.acceptedVersion=null;r.envelope.acceptedProposal=null;r.envelope.acceptedDecision=null;r.envelope.head=null;r.effectiveAuthority={state:'NONE',blockers:['NO_AUTHORITY']};r.envelope.decision!.authorization!.acceptedVersion.hash='f'.repeat(64);f.result.target.hash=await commandDigest(r.envelope.decision);await expect(qualifyMandateDecisionReceipt(r,f.scope,f.locator,f.result)).rejects.toThrow();});
});
