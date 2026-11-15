import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionBindingSchema, ApprovalPolicySchema, ApprovalReceiptSchema, BudgetSnapshotSchema, CommercialCostKindSchema, MandateHeadSchema, MandateVersionSchema, OfferTermsVersionSchema, type Asset } from '@pactwoven/contracts';
import { BudgetExposureReview, DecisionExactReview, SupplierTermsReview } from '../components/financial-review';
import { MandateReview } from '../components/mandate-review';
import { exactReviewIssues, formatAssetAmount, formatBaseUnits, mandateReviewIssues, matchingPolicyText, reviewAsset, samePayee, totalsByAsset } from './financial-review';

const hash = 'a'.repeat(64), changedHash = 'b'.repeat(64);
const observedAt = '2026-11-15T12:00:00Z', expiresAt = '2026-11-16T12:00:00Z';
const scope = { organizationId: 'org_test', environment: 'development' as const, responsibilityId: 'responsibility_test' };
const asset: Asset = { id: 'asset_test_usdc', environment: 'development', network: 'solana-devnet', mint: 'test_mint_usdc', tokenProgram: 'test_token_program', symbol: 'USDC', decimals: 6 };
const networkAsset: Asset = { ...asset, id: 'asset_test_sol', mint: 'test_native_asset', symbol: 'SOL', decimals: 9 };
const reference = { id: 'acceptance_policy_test', version: 1, hash };
const acceptancePolicy = { reference, text: 'Accept only after the receiver verifies all four items against the agreed specification.' };
const payee = { id: 'payee_test', version: 1, environment: 'development' as const, network: asset.network, recipient: 'test_recipient_full_address_1234567890', assetId: asset.id, mint: asset.mint, tokenProgram: asset.tokenProgram, verificationRef: 'payee_evidence_test' };
function makeTerms() {
  return OfferTermsVersionSchema.parse({ id: 'terms_test', version: 1, previousVersionHash: null, organizationId: scope.organizationId, environment: scope.environment, supplierRelationshipId: 'supplier_test', source: { id: 'supplier_document_test', version: 2, hash }, payee, assets: [asset], window: { startsAt: observedAt, endsAt: expiresAt, timeZone: 'America/Chicago' }, items: [{ id: 'item_test', specification: 'Four tested devices with exact connectors and capacity.', quantityBaseUnits: '400', quantityScale: 2, unit: 'devices' }], costs: CommercialCostKindSchema.options.map(kind => ({ id: `cost_${kind}`, kind, state: kind === 'base' ? 'QUOTED' : 'NOT_APPLICABLE', assetId: asset.id, amountBaseUnits: kind === 'base' ? '1234567' : '0', dueTrigger: kind === 'base' ? 'After signed acceptance' : 'Not applicable', earnedTrigger: kind === 'base' ? 'After verified delivery' : 'Not applicable', refundable: 'NONREFUNDABLE', refundTerms: 'No refund after acceptance.' })), paymentSchedule: [{ id: 'schedule_final', costIds: ['cost_base'], kind: 'FINAL', dueTrigger: 'After the receiver signs acceptance' }], acceptancePolicy: reference, substitutionTerms: 'No substitutions without a new exact approval.', disputeTerms: 'Record missing items before releasing the final payment.', expiresAt });
}
function makeAction() {
  return ActionBindingSchema.parse({ schemaVersion: 1, kind: 'pay_supplier', responsibilityId: scope.responsibilityId, siteId: 'site_test', supplierRelationshipId: 'supplier_test', authority: { organizationId: scope.organizationId, environment: scope.environment, organizationEpoch: 2, mandateId: 'mandate_test', mandateVersion: 3, mandateEpoch: 1 }, terms: { id: 'terms_test', version: 1, hash }, payee, withdrawal: null, toolPurchase: null, assets: [asset, networkAsset], components: [{ id: 'principal', economicPortionId: 'portion_principal', assetId: asset.id, category: 'supplier_principal', amountBaseUnits: '1234567' }, { id: 'network', economicPortionId: 'portion_network', assetId: networkAsset.id, category: 'network_fee', amountBaseUnits: '5000' }], expiresAt, nonce: 'action_nonce_test' });
}
function makeHead() { return MandateHeadSchema.parse({ ...makeAction().authority, responsibilityId: scope.responsibilityId, state: 'ACTIVE', policyHash: hash, expiresAt }); }
function makePolicy() { return ApprovalPolicySchema.parse({ reference: { id: 'approval_policy_test', version: 1, hash }, organizationId: scope.organizationId, environment: scope.environment, eligibleRoles: ['finance','owner'], independentApprover: true, maximumStepUpAgeMs: 300_000, maximumApprovalAgeMs: 180_000, expiresAt }); }
function makeMandate() { return MandateVersionSchema.parse({ id: 'mandate_test', organizationId: scope.organizationId, environment: scope.environment, responsibilityId: scope.responsibilityId, version: 3, mandateEpoch: 1, organizationEpoch: 2, policy: { mode: 'ACT_WITHIN_MANDATE', siteIds: ['site_test'], supplierRelationshipIds: ['supplier_test'], actions: ['pay_supplier'], budgets: [{ assetId: asset.id, category: 'supplier_principal', perOperation: '2000000', perResponsibility: '5000000', periodMaximum: '20000000', periodStartsAt: observedAt, periodEndsAt: expiresAt }], acceptancePolicy: reference, communication: { recipientIds: ['recipient_test'], purposes: ['Delivery coordination'], messageKinds: ['Delivery status'], maximumMessages: 3, expiresAt }, expiresAt }, policyHash: hash, previousVersionHash: changedHash, createdAt: observedAt, createdBy: 'owner_test' }); }
function review() { return { scope, action: makeAction(), actionHash: hash, requestedBy: 'requester_test', observedAt, terms: { terms: makeTerms(), hash }, acceptancePolicy, documents: {withdrawalPolicy:null,toolResource:null,toolRequest:null,toolAllowlistPolicy:null,toolDeliveryPolicy:null}, approvalReceipt: null, authority: makeHead(), approvalPolicy: makePolicy() }; }

describe('exact financial display', () => {
  it('displays the complete unsigned64 amount and18 decimal precision without floating point', () => {
    expect(formatBaseUnits('18446744073709551615', 6)).toBe('18,446,744,073,709.551615');
    expect(formatBaseUnits('1', 18)).toBe('0.000000000000000001');
    expect(formatBaseUnits('0', 6)).toBe('0.000000');
    expect(formatBaseUnits('9007199254740993', 0)).toBe('9,007,199,254,740,993');
  });
  it('does not invent precision or a currency for an unknown asset', () => {
    expect(formatAssetAmount('1234567', undefined)).toBe('1234567 base units · asset details unavailable');
    expect(formatBaseUnits('1e9', 6)).toBe('Unrecognized amount');
  });
  it('does not choose a symbol or decimal scale from ambiguous or cross-environment asset metadata', () => {
    expect(reviewAsset([asset, { ...asset, decimals: 9 }], asset.id, 'development')).toBeUndefined();
    expect(reviewAsset([{ ...asset, environment: 'production' }], asset.id, 'development')).toBeUndefined();
    const props=review();props.action.assets.push({ ...asset, decimals: 9 });
    const html=renderToStaticMarkup(createElement(DecisionExactReview,props));
    expect(html).toContain('asset details unavailable');expect(html).toContain('missing, ambiguous or in a different environment');
  });
  it('keeps totals separate by asset identity, even if symbols are the same', () => {
    const components = makeAction().components;
    expect(totalsByAsset([...components, { ...components[0]!, id: 'other', economicPortionId: 'other_portion', amountBaseUnits: '1' }])).toEqual([{ assetId: asset.id, amountBaseUnits: '1234568' }, { assetId: networkAsset.id, amountBaseUnits: '5000' }]);
  });
  it('requires the exact policy reference and nonempty full text', () => {
    expect(matchingPolicyText(reference, acceptancePolicy)).toBe(acceptancePolicy.text);
    expect(matchingPolicyText(reference, null)).toBeNull();
    expect(matchingPolicyText(reference, { ...acceptancePolicy, reference: { ...reference, hash: changedHash } })).toBeNull();
    expect(matchingPolicyText(reference, { ...acceptancePolicy, text: '  ' })).toBeNull();
  });
  it('compares the full payee binding independent of object key ordering', () => {
    expect(samePayee(payee, Object.fromEntries(Object.entries(payee).reverse()) as typeof payee)).toBe(true);
    expect(samePayee(payee, { ...payee, recipient: 'changed_recipient' })).toBe(false);
    expect(samePayee(payee, { ...payee, version: 2 })).toBe(false);
  });
  it('flags changed authority, revoked authority, mismatched terms and missing approval policy', () => {
    const props = review();
    expect(exactReviewIssues(props.action, props.terms, props.authority, props.approvalPolicy)).toEqual([]);
    expect(exactReviewIssues(props.action, { ...props.terms, hash: changedHash }, { ...props.authority, mandateEpoch: 2, state: 'REVOKED' }, null)).toEqual(expect.arrayContaining([expect.stringContaining('pinned version and hash'), expect.stringContaining('Authority changed'), expect.stringContaining('revoked'), expect.stringContaining('approval policy is unavailable')]));
  });
  it('shows expiry at the observed snapshot without claiming the browser can authorize execution', () => {
    const props=review();
    expect(exactReviewIssues(props.action,props.terms,props.authority,props.approvalPolicy,expiresAt)).toHaveLength(4);
    expect(mandateReviewIssues(makeMandate(),makeHead(),expiresAt)).toContain('The mandate had expired when this snapshot was observed.');
  });
  it('renders all charge categories, complete terms, full recipient and separate exact totals without an approval action', () => {
    const html = renderToStaticMarkup(createElement(DecisionExactReview, review()));
    for (const text of ['Supplier principal','Supplier charges','Platform fee','Network fee','Agent &amp; tool allowance','No component listed','Goods &amp; services','Tax','Delivery','Installation','Service fee','Hold','Overtime','Cancellation','Damage','Return',payee.recipient,'1.234567 USDC','0.000005000 SOL','After signed acceptance','After verified delivery','No refund after acceptance.',acceptancePolicy.text,'No substitutions without a new exact approval.','Record missing items before releasing the final payment.','Independent approval','The requester cannot approve their own request.','300 seconds','180 seconds']) expect(html).toContain(text);
    expect(html).toContain('Approval is not connected');expect(html).not.toContain('<button');expect(html).not.toContain('<form');
  });
  it('does not disclose a review under a different organization or render substituted terms', () => {
    const props = review();
    const denied = renderToStaticMarkup(createElement(DecisionExactReview, { ...props, scope: { ...scope, organizationId: 'other_org' } }));
    expect(denied).toContain('This review is unavailable');expect(denied).not.toContain(payee.recipient);
    const changed = renderToStaticMarkup(createElement(DecisionExactReview, { ...props, terms: { hash: changedHash, terms: { ...props.terms.terms, substitutionTerms: 'Unbound terms must not appear' } } }));
    expect(changed).toContain('pinned supplier terms are unavailable');expect(changed).not.toContain('Unbound terms must not appear');
  });
  it('does not turn unknown commercial amounts or refunds into zero', () => {
    const terms = makeTerms();terms.costs[0] = { ...terms.costs[0]!, state: 'UNKNOWN', amountBaseUnits: null, refundable: 'UNKNOWN' };
    const html = renderToStaticMarkup(createElement(SupplierTermsReview, { terms, hash, acceptancePolicy }));
    expect(html).toContain('Unknown is not zero.');expect(html).toContain('Amount not specified');expect(html).toContain('Refund terms unknown');
  });
  it('shows all mandate ceilings, communication boundaries and changed-version warnings without claiming remaining funds', () => {
    const mandate = makeMandate(), head = makeHead();
    expect(mandateReviewIssues(mandate, head)).toEqual([]);
    const html = renderToStaticMarkup(createElement(MandateReview, { scope, mandate, head: { ...head, mandateVersion: 4, state: 'PAUSED' }, assets: [asset], acceptancePolicy, observedAt }));
    for (const text of ['Per operation','Per responsibility','Period maximum','2.000000 USDC','5.000000 USDC','20.000000 USDC','Maximum messages','Delivery coordination','recipient_test','Authority is paused','does not match the reported authority record']) expect(html).toContain(text);
    expect(html).not.toContain('<button');expect(html).not.toContain('Remaining balance');
  });
});

describe('withdrawal, tool and recorded financial evidence', () => {
  it('requires explicit nullable bindings on ordinary supplier actions', () => {
    const action=makeAction();expect(action.withdrawal).toBeNull();expect(action.toolPurchase).toBeNull();
    const {withdrawal: _withdrawal,...withoutBinding}=action;expect(ActionBindingSchema.safeParse(withoutBinding).success).toBe(false);
  });
  it('discloses the exact return destination, amount and resolved policy without describing the return as supplier spending', () => {
    const withdrawalPolicy={reference:{id:'withdrawal_policy_test',version:2,hash},text:'Return only verified unused funds to the organization treasury.'};
    const action=ActionBindingSchema.parse({...makeAction(),kind:'withdraw_unused',terms:null,supplierRelationshipId:null,withdrawal:{destination:{...payee,organizationId:scope.organizationId,purpose:'CUSTOMER_RETURN'},amountBaseUnits:'1234567',policy:withdrawalPolicy.reference}});
    const props={...review(),action,terms:null,documents:{...review().documents,withdrawalPolicy}};
    const html=renderToStaticMarkup(createElement(DecisionExactReview,props));
    for(const text of ['Funds returned','Return amount','Destination organization','Customer return',payee.recipient,'1.234567 USDC',withdrawalPolicy.text]) expect(html).toContain(text);
    expect(html).not.toContain('<button');
    const denied=renderToStaticMarkup(createElement(DecisionExactReview,{...props,action:{...action,withdrawal:{...action.withdrawal!,destination:{...action.withdrawal!.destination,organizationId:'different_org'}}}}));
    expect(denied).toContain('Destination outside this organization');expect(denied).not.toContain(payee.recipient);
  });
  it('shows exact tool resource/request, immutable challenge and all required policy text', () => {
    const resource={id:'resource_test',version:2,hash},request={id:'request_test',version:3,hash:changedHash};
    const allowlistPolicy={id:'allowlist_test',version:1,hash},deliveryPolicy={id:'delivery_policy_test',version:4,hash};
    const action=ActionBindingSchema.parse({...makeAction(),kind:'purchase_tool',terms:null,supplierRelationshipId:null,components:[{...makeAction().components[0]!,category:'operating_allowance'}],toolPurchase:{providerId:'provider_test',resource,request,challenge:{id:'challenge_test',hash,providerId:'provider_test',resourceHash:hash,requestHash:changedHash,payee,amountBaseUnits:'1234567',expiresAt},allowlistPolicy,deliveryPolicy}});
    const props={...review(),action,terms:null,documents:{withdrawalPolicy:null,toolResource:{reference:resource,text:'One availability lookup for the specified resource.'},toolRequest:{reference:request,text:'Read availability for the agreed service window only.'},toolAllowlistPolicy:{reference:allowlistPolicy,text:'Only the verified provider and exact resource are allowed.'},toolDeliveryPolicy:{reference:deliveryPolicy,text:'A verifiable result for this request must be returned.'}}};
    const html=renderToStaticMarkup(createElement(DecisionExactReview,props));
    for(const text of ['provider_test','resource_test','request_test','challenge_test','Exact challenge amount','Challenge expires',payee.recipient,props.documents.toolResource.text,props.documents.toolRequest.text,props.documents.toolAllowlistPolicy.text,props.documents.toolDeliveryPolicy.text]) expect(html).toContain(text);
    const changed={...action,toolPurchase:{...action.toolPurchase!,challenge:{...action.toolPurchase!.challenge,requestHash:hash}}};
    expect(exactReviewIssues(changed,null,makeHead(),makePolicy(),observedAt)).toContain('The payment challenge does not match the exact provider, resource and request.');
    const incomplete=renderToStaticMarkup(createElement(DecisionExactReview,{...props,documents:review().documents}));
    expect(incomplete).toContain('Exact request text unavailable');expect(incomplete).toContain('Delivery policy text unavailable');expect(incomplete).not.toContain('<form');
  });
  it('shows step-up timestamps on a matching receipt and withholds an approval for a different action', () => {
    const receipt=ApprovalReceiptSchema.parse({id:'approval_receipt_test',actionHash:hash,authority:makeAction().authority,policy:makePolicy().reference,requesterId:'requester_test',approverId:'independent_finance_test',approverSessionId:'test_session_ref',stepUpEvidenceId:'test_step_up_evidence',stepUpVerifiedAt:'2026-11-15T11:59:30Z',stepUpExpiresAt:'2026-11-15T12:05:00Z',approvedAt:observedAt,expiresAt:'2026-11-15T12:03:00Z'});
    const html=renderToStaticMarkup(createElement(DecisionExactReview,{...review(),approvalReceipt:receipt}));
    for(const text of ['Recorded approval','Independent approver','Step-up verified','Step-up expires','2026-11-15T11:59:30Z','2026-11-15T12:05:00Z','independent_finance_test']) expect(html).toContain(text);
    expect(html).not.toContain('test_session_ref');
    const mismatch=renderToStaticMarkup(createElement(DecisionExactReview,{...review(),approvalReceipt:{...receipt,actionHash:changedHash}}));
    expect(mismatch).toContain('Approval does not match this review');expect(mismatch).not.toContain('independent_finance_test');
  });
  it('keeps exposure payment observations separate from unknown outcomes and expected refunds', () => {
    const component=makeAction().components[0]!;
    const snapshot=BudgetSnapshotSchema.parse({organizationId:scope.organizationId,environment:scope.environment,version:1,asset,verifiedSpendableBaseUnits:'5000000',verifiedAt:observedAt,expectedRefundBaseUnits:'1000000',exposures:[{...component,id:'exposure_paid',responsibilityId:scope.responsibilityId,kind:'OUTGOING',state:'PAID',paidAt:'2026-11-15T11:50:00Z'},{...component,id:'exposure_unknown',economicPortionId:'unknown_portion',responsibilityId:scope.responsibilityId,kind:'OUTGOING',state:'OUTCOME_UNKNOWN',paidAt:null}],spend:[]});
    const html=renderToStaticMarkup(createElement(BudgetExposureReview,{scope,snapshot}));
    for(const text of ['Organization spendable snapshot','Expected refunds','5.000000 USDC','1.000000 USDC','2026-11-15T11:50:00Z','outcome unknown','No paid event recorded for this state','Unknown outcomes remain unresolved.']) expect(html).toContain(text);
    const inconsistent={...snapshot,exposures:[{...snapshot.exposures[0]!,paidAt:null}]};
    expect(renderToStaticMarkup(createElement(BudgetExposureReview,{scope,snapshot:inconsistent}))).toContain('Payment timestamp unavailable');
    const denied=renderToStaticMarkup(createElement(BudgetExposureReview,{scope:{...scope,organizationId:'other_org'},snapshot}));expect(denied).toContain('Budget observations unavailable');expect(denied).not.toContain('5.000000');
  });
  it('flags an exact action whose expiry exceeds the current mandate', () => {
    expect(exactReviewIssues(makeAction(),{terms:makeTerms(),hash},{...makeHead(),expiresAt:observedAt},makePolicy())).toContain('The action expiry exceeds the current mandate expiry. A newly bounded action is required.');
  });
});
