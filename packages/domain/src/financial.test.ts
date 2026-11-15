import { describe, expect, it } from 'vitest';
import { CommercialCostKindSchema, type ActionBinding, type ActorContext, type ApprovalPolicy, type BudgetLimit, type BudgetSnapshot,
  type FinancialComponent, type JournalEntry, type LedgerAccount, type MandateHead, type MandatePolicy, type OfferTermsVersion, type StepUpEvidence } from '@pactwoven/contracts';
import { approveExactAction, assertApprovalCurrent, validateActionBinding } from './approvals.js';
import { assertMandateAction, changeAuthorityState, createMandateVersion } from './authority.js';
import { qualifyOfferTerms, quotedCostBounds } from './commercial.js';
import { appendJournal, availableForNewCommitments, deduplicateEconomicIntent, prepareEconomicIntent,
  requiredFutureLiquidity, reserveBudget, retainUnknownExposure, sumAmounts, validateJournal } from './finance.js';

const now = '2026-11-14T12:00:00.000Z';
const expiry = '2026-11-14T13:00:00.000Z';
const reference = { id: 'policy_ref', version: 1, hash: 'a'.repeat(64) };
const asset = { id: 'test_asset', environment: 'development' as const, network: 'solana-devnet', mint: 'test_mint', tokenProgram: 'test_token_program', symbol: 'TEST', decimals: 6 };
const limit = (category: BudgetLimit['category'] = 'supplier_principal'): BudgetLimit => ({ assetId: asset.id, category,
  perOperation: '500', perResponsibility: '500', periodMaximum: '1000', periodStartsAt: '2026-11-14T00:00:00.000Z', periodEndsAt: '2026-11-15T00:00:00.000Z' });
const mandatePolicy = (): MandatePolicy => ({ mode: 'PREPARE_FOR_APPROVAL', siteIds: ['site_a'], supplierRelationshipIds: ['supplier_a'],
  actions: ['allocate_funds', 'pay_supplier'], budgets: [limit()], acceptancePolicy: reference,
  communication: { recipientIds: [], purposes: [], messageKinds: [], maximumMessages: 0, expiresAt: expiry }, expiresAt: expiry });
const mandateContext = { id: 'mandate_a', organizationId: 'org_a', environment: 'development' as const, responsibilityId: 'responsibility_a',
  authorId: 'owner_a', organizationEpoch: 0, currentMandateEpoch: 0, expectedVersion: 0, now };
const approver: ActorContext = { actorId: 'finance_a', principalKind: 'human', organizationId: 'org_a', environment: 'development',
  roles: ['finance'], siteIds: ['site_a'], actionSiteIds: ['site_a'], sessionId: 'finance_session', authenticatedAt: '2026-11-14T00:00:00.000Z', correlationId: 'trace_test' };
const approvalPolicy: ApprovalPolicy = { reference, organizationId: 'org_a', environment: 'development', eligibleRoles: ['finance'],
  independentApprover: true, maximumStepUpAgeMs: 300_000, maximumApprovalAgeMs: 300_000, expiresAt: expiry };
const stepUp: StepUpEvidence = { id: 'step_up_a', actorId: approver.actorId, sessionId: approver.sessionId,
  method: 'MFA', verifiedAt: now, expiresAt: expiry, providerProofRef: 'verified_provider_fixture' };
const component = (value = '100', id = 'allocation_a', category: FinancialComponent['category'] = 'supplier_principal'): FinancialComponent =>
  ({ id, economicPortionId: `portion_${id}`, assetId: asset.id, category, amountBaseUnits: value });

async function authorityFixture(policy = mandatePolicy()) {
  const mandate = await createMandateVersion(mandateContext, policy, null);
  const binding = { organizationId: 'org_a', environment: 'development' as const, organizationEpoch: 0, mandateId: mandate.id, mandateVersion: 1, mandateEpoch: 1 };
  const head: MandateHead = { ...binding, responsibilityId: 'responsibility_a', state: 'ACTIVE', policyHash: mandate.policyHash, expiresAt: policy.expiresAt };
  const action: ActionBinding = { schemaVersion: 1, kind: 'allocate_funds', responsibilityId: 'responsibility_a', authority: binding,
    siteId: 'site_a', supplierRelationshipId: null,
    terms: null, payee: null, withdrawal: null, toolPurchase: null, assets: [asset], components: [component()], expiresAt: policy.expiresAt, nonce: 'review_a' };
  const approveContext = { receiptId: 'approval_a', requesterId: 'owner_a', actor: approver, stepUp, policy: approvalPolicy, head, mandate, now };
  const checkContext = { head, mandate, policy: approvalPolicy, approver, stepUp, requesterId: 'owner_a', now };
  const approval = { ...checkContext, receipt: await approveExactAction(approveContext, action) };
  return { mandate, head, action, approveContext, checkContext, approval };
}

describe('mandate versions and exact independent approvals', () => {
  it('denies baseline nonbuyer roles at issuance and effect use even under a widened policy', async () => {
    const { action, approveContext, checkContext, head, mandate, approval } = await authorityFixture();
    for (const role of ['auditor', 'supplier_admin', 'supplier_dispatcher', 'receiver', 'support', 'service'] as const) {
      const nonbuyer: ActorContext = { ...approver, roles: [role] };
      const widenedPolicy = { ...approvalPolicy, eligibleRoles: [role] } as unknown as ApprovalPolicy;
      await expect(approveExactAction({ ...approveContext, actor: nonbuyer, policy: widenedPolicy }, action)).rejects.toBeDefined();
      await expect(assertApprovalCurrent(approval.receipt, action, { ...checkContext, approver: nonbuyer, policy: widenedPolicy })).rejects.toBeDefined();
      await expect(assertMandateAction(action, head, mandate, now, { ...approval, approver: nonbuyer, policy: widenedPolicy }, approver)).rejects.toBeDefined();
      // Current actor roles must pass the hard ceiling even when the stored policy is valid.
      await expect(approveExactAction({ ...approveContext, actor: nonbuyer }, action)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(assertApprovalCurrent(approval.receipt, action, { ...checkContext, approver: nonbuyer })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(assertMandateAction(action, head, mandate, now, { ...approval, approver: nonbuyer }, approver)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    }
    for (const role of ['owner', 'finance', 'operations'] as const) {
      const buyer: ActorContext = { ...approver, roles: [role] };
      const policy: ApprovalPolicy = { ...approvalPolicy, eligibleRoles: [role] };
      const receipt = await approveExactAction({ ...approveContext, actor: buyer, policy }, action);
      await expect(assertMandateAction(action, head, mandate, now, { ...approval, receipt, approver: buyer, policy }, approver)).resolves.toBeUndefined();
    }
  });

  it('rejects action lifetime beyond a shortened current head in autonomous, approval and use paths', async () => {
    const { action, approveContext, checkContext, head, mandate, approval } = await authorityFixture({ ...mandatePolicy(), mode: 'ACT_WITHIN_MANDATE' });
    const short = '2026-11-14T12:00:01.000Z';
    const narrowedHead = { ...head, expiresAt: short };
    await expect(assertMandateAction(action, narrowedHead, mandate, now, null, approver)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(approveExactAction({ ...approveContext, head: narrowedHead }, action)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(assertApprovalCurrent(approval.receipt, action, { ...checkContext, head: narrowedHead })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    const bounded = { ...action, expiresAt: short };
    await expect(assertMandateAction(bounded, narrowedHead, mandate, now, null, approver)).resolves.toBeUndefined();
    const receipt = await approveExactAction({ ...approveContext, head: narrowedHead }, bounded);
    expect(receipt.expiresAt).toBe(short);
    await expect(assertApprovalCurrent(receipt, bounded, { ...checkContext, head: narrowedHead })).resolves.toBeUndefined();
    await expect(assertMandateAction(bounded, narrowedHead, mandate, short, null, approver)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });

  it('runs complete binding validation for autonomous actions and rejects undefined component assets', async () => {
    const { action, mandate, head } = await authorityFixture({ ...mandatePolicy(), mode: 'ACT_WITHIN_MANDATE' });
    const supplier = { ...action, kind: 'pay_supplier' as const, supplierRelationshipId: 'supplier_a' };
    await expect(assertMandateAction(supplier, head, mandate, now, null, approver)).rejects.toMatchObject({ code: 'TERMS_INCOMPLETE' });
    await expect(assertMandateAction({ ...action, assets: [{ ...asset, id: 'unrelated_asset' }] }, head, mandate, now, null, approver))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(assertMandateAction({ ...supplier, terms: reference, payee: offerFixture().payee }, head, mandate, now, null, approver)).resolves.toBeUndefined();
  });

  it('requires current site scope for independent operations approvers and effect actors', async () => {
    const { action, approveContext, checkContext, head, mandate, approval } = await authorityFixture();
    const scopedActor = { ...approver, roles: ['operations'] as ActorContext['roles'], siteIds: ['site_a'] };
    const policy = { ...approvalPolicy, eligibleRoles: ['operations'] as ApprovalPolicy['eligibleRoles'] };
    const receipt = await approveExactAction({ ...approveContext, actor: scopedActor, policy }, action);
    await expect(assertApprovalCurrent(receipt, action, { ...checkContext, approver: scopedActor, policy })).resolves.toBeUndefined();
    for (const siteIds of [[], ['site_b']]) {
      await expect(approveExactAction({ ...approveContext, actor: { ...scopedActor, actionSiteIds: siteIds }, policy }, action)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(assertApprovalCurrent(receipt, action, { ...checkContext, approver: { ...scopedActor, actionSiteIds: siteIds }, policy })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(assertMandateAction(action, head, mandate, now, approval, { ...approver, actionSiteIds: siteIds })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(assertMandateAction(action, head, mandate, now,
        { ...checkContext, receipt, policy, approver: { ...scopedActor, actionSiteIds: siteIds } }, approver)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    }
    // A shape-compatible caller flag cannot stand in for verified approval evidence.
    await expect(assertMandateAction(action, head, mandate, now, true as never, approver)).rejects.toBeDefined();
    await expect(assertMandateAction(action, head, mandate, now, approval, { ...approver, roles: ['auditor'] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const broadReader = { ...approver, siteIds: ['site_a', 'site_b'], actionSiteIds: ['site_b'] };
    await expect(approveExactAction({ ...approveContext, actor: broadReader }, action)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertApprovalCurrent(approval.receipt, action, { ...checkContext, approver: broadReader })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(assertMandateAction(action, head, mandate, now, approval, broadReader)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('bounds approval use by proof age as well as every other expiry', async () => {
    const { action, approveContext, checkContext, head, mandate } = await authorityFixture();
    const proof = { ...stepUp, verifiedAt: '2026-11-14T11:55:01.000Z' };
    const receipt = await approveExactAction({ ...approveContext, stepUp: proof }, action);
    expect(receipt.expiresAt).toBe('2026-11-14T12:00:01.000Z');
    await expect(assertApprovalCurrent(receipt, action, { ...checkContext, stepUp: proof, now: '2026-11-14T12:00:00.999Z' })).resolves.toBeUndefined();
    for (const later of [receipt.expiresAt, '2026-11-14T12:04:59.000Z']) {
      await expect(assertApprovalCurrent(receipt, action, { ...checkContext, stepUp: proof, now: later })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(assertMandateAction(action, head, mandate, later, { ...checkContext, receipt, stepUp: proof }, approver)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    }
    await expect(assertApprovalCurrent({ ...receipt, expiresAt: expiry }, action, { ...checkContext, stepUp: proof })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(assertApprovalCurrent(receipt, action, checkContext)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    const short = '2026-11-14T12:00:00.500Z';
    const variants = [
      { context: approveContext, action: { ...action, expiresAt: short } },
      { context: { ...approveContext, head: { ...head, expiresAt: short } }, action: { ...action, expiresAt: short } },
      { context: { ...approveContext, policy: { ...approvalPolicy, expiresAt: short } }, action },
      { context: { ...approveContext, stepUp: { ...stepUp, expiresAt: short } }, action },
      { context: { ...approveContext, policy: { ...approvalPolicy, maximumApprovalAgeMs: 500 } }, action },
    ];
    for (const variant of variants) expect((await approveExactAction(variant.context, variant.action)).expiresAt).toBe(short);
    const shortMandate = await authorityFixture({ ...mandatePolicy(), expiresAt: short,
      communication: { ...mandatePolicy().communication, expiresAt: short } });
    expect(shortMandate.approval.receipt.expiresAt).toBe(short);
    await expect(approveExactAction({ ...shortMandate.approveContext, head: { ...shortMandate.head, expiresAt: expiry } }, shortMandate.action))
      .rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(approveExactAction({ ...approveContext, stepUp: { ...stepUp, verifiedAt: '2026-11-14T11:55:00.000Z' } }, action))
      .rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('preserves immutable history and increments versions/epochs from current authority', async () => {
    const { mandate } = await authorityFixture();
    const revised = await createMandateVersion({ ...mandateContext, expectedVersion: 1, currentMandateEpoch: 3 },
      { ...mandatePolicy(), expiresAt: '2026-11-14T14:00:00.000Z' }, mandate);
    expect([revised.version, revised.mandateEpoch]).toEqual([2, 4]);
    expect(revised.previousVersionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mandate.version).toBe(1);
    expect(() => { mandate.policy.siteIds.push('forged_site'); }).toThrow();
    await expect(createMandateVersion({ ...mandateContext, expectedVersion: 0 }, mandatePolicy(), mandate)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('uses the same action safely across advice, shadow and approved/mandated modes', async () => {
    for (const mode of ['ADVISE', 'SHADOW', 'PREPARE_FOR_APPROVAL', 'ACT_WITHIN_MANDATE'] as const) {
      const { mandate, head, action, approval } = await authorityFixture({ ...mandatePolicy(), mode });
      if (mode === 'ADVISE' || mode === 'SHADOW') await expect(assertMandateAction(action, head, mandate, now, approval, approver)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      else if (mode === 'PREPARE_FOR_APPROVAL') {
        await expect(assertMandateAction(action, head, mandate, now, null, approver)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
        await expect(assertMandateAction(action, head, mandate, now, approval, approver)).resolves.toBeUndefined();
      } else await expect(assertMandateAction(action, head, mandate, now, null, approver)).resolves.toBeUndefined();
    }
  });

  it('rejects altered policy content, stale versions, revoked epochs and exact deadline boundaries', async () => {
    const { mandate, head, action, approval } = await authorityFixture();
    await expect(assertMandateAction(action, head, { ...mandate, policy: { ...mandate.policy, mode: 'ACT_WITHIN_MANDATE' } }, now, approval, approver))
      .rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(assertMandateAction(action, { ...head, organizationEpoch: 1 }, mandate, now, approval, approver)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(assertMandateAction(action, head, mandate, expiry, approval, approver)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    const revoked = changeAuthorityState(head, 'REVOKED', 1);
    expect(revoked.mandateEpoch).toBe(2);
    expect(() => changeAuthorityState(revoked, 'ACTIVE', 2)).toThrowError(expect.objectContaining({ code: 'AUTHORITY_CHANGED' }));
    await expect(assertMandateAction(action, revoked, mandate, now, approval, approver)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });

  it('denies a site, supplier or fee category outside the exact mandate', async () => {
    const { mandate, head, action, approval } = await authorityFixture();
    await expect(assertMandateAction({ ...action, siteId: 'unrelated_site' }, head, mandate, now, approval, approver)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertMandateAction({ ...action, supplierRelationshipId: 'unapproved_supplier' }, head, mandate, now, approval, approver)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertMandateAction({ ...action, components: [component('1', 'tools', 'operating_allowance')] }, head, mandate, now, approval, approver))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(assertMandateAction({ ...action, components: [component('501')] }, head, mandate, now, approval, approver)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('requires another current approver and session-bound verified step-up rather than session age', async () => {
    const { action, approveContext } = await authorityFixture();
    await expect(approveExactAction({ ...approveContext, requesterId: approver.actorId }, action)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(approveExactAction({ ...approveContext, actor: { ...approver, roles: ['operations'] } }, action)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const proof of [{ ...stepUp, sessionId: 'other_session' }, { ...stepUp, actorId: 'other_actor' },
      { ...stepUp, verifiedAt: '2026-11-14T11:54:59.999Z' }, { ...stepUp, verifiedAt: '2026-11-14T12:00:00.001Z' }, { ...stepUp, expiresAt: now }]) {
      await expect(approveExactAction({ ...approveContext, stepUp: proof }, action)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
    const receipt = await approveExactAction(approveContext, action);
    expect(receipt.expiresAt).toBe('2026-11-14T12:05:00.000Z');
    expect(receipt).not.toHaveProperty('financialState');
  });

  it('binds all payment details and rechecks policy, approver and expiry before use', async () => {
    const { action, approveContext, checkContext } = await authorityFixture();
    const receipt = await approveExactAction(approveContext, action);
    await expect(assertApprovalCurrent(receipt, action, checkContext)).resolves.toBeUndefined();
    for (const changed of [{ ...action, components: [component('101')] }, { ...action, nonce: 'changed' },
      { ...action, terms: { ...reference, version: 2 } }, { ...action, assets: [{ ...asset, mint: 'different_mint' }] },
      { ...action, components: [component('100', 'allocation_a', 'operating_allowance')] }]) {
      await expect(assertApprovalCurrent(receipt, changed, checkContext)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    }
    await expect(assertApprovalCurrent(receipt, action, { ...checkContext, approver: { ...approver, roles: ['auditor'] } })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(assertApprovalCurrent(receipt, action, { ...checkContext, policy: { ...approvalPolicy, reference: { ...reference, version: 2 } } }))
      .rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(assertApprovalCurrent(receipt, action, { ...checkContext, now: receipt.expiresAt })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
  });
});

describe('exact withdrawal and paid-tool bindings', () => {
  async function fixture(kind: 'withdraw_unused' | 'purchase_tool') {
    const base = await authorityFixture({ ...mandatePolicy(), actions: [kind], budgets: [limit(), limit('operating_allowance'), limit('network_fee')] });
    const payee = offerFixture().payee;
    const action: ActionBinding = kind === 'withdraw_unused'
      ? { ...base.action, kind, payee, withdrawal: { destination: { ...payee, organizationId: 'org_a', purpose: 'CUSTOMER_RETURN' }, amountBaseUnits: '100', policy: reference } }
      : { ...base.action, kind, payee, components: [component('100', 'tool_a', 'operating_allowance')], toolPurchase: {
        providerId: 'tool_provider', resource: reference, request: reference,
        challenge: { id: 'challenge_a', hash: 'b'.repeat(64), providerId: 'tool_provider', resourceHash: reference.hash, requestHash: reference.hash,
          payee, amountBaseUnits: '100', expiresAt: expiry }, allowlistPolicy: reference, deliveryPolicy: reference,
      } };
    return { ...base, action };
  }

  it('rejects destinationless withdrawals and tools through validation, approval, autonomous authority and preparation', async () => {
    for (const kind of ['withdraw_unused', 'purchase_tool'] as const) {
      const { action, approveContext, mandate, head } = await fixture(kind);
      const missing = { ...action, payee: null, withdrawal: null, toolPurchase: null };
      expect(() => validateActionBinding(missing)).toThrowError(expect.objectContaining({ code: 'TERMS_INCOMPLETE' }));
      await expect(approveExactAction(approveContext, missing)).rejects.toMatchObject({ code: 'TERMS_INCOMPLETE' });
      await expect(assertMandateAction(missing, head, mandate, now, null, approver)).rejects.toMatchObject({ code: 'TERMS_INCOMPLETE' });
      await expect(prepareEconomicIntent({ id: 'operation_a', paymentAuthorizationId: 'payment_a', approvalId: 'approval_a', now }, missing))
        .rejects.toMatchObject({ code: 'TERMS_INCOMPLETE' });
    }
  });

  it('approves exact organization-owned returns and rejects beneficiary, amount or policy substitution', async () => {
    const { action, approveContext, checkContext, mandate, head } = await fixture('withdraw_unused');
    const receipt = await approveExactAction(approveContext, action);
    await expect(assertMandateAction(action, head, mandate, now, { ...checkContext, receipt }, approver)).resolves.toBeUndefined();
    expect(() => validateActionBinding({ ...action, withdrawal: { ...action.withdrawal!, destination: { ...action.withdrawal!.destination, organizationId: 'other_org' } } }))
      .toThrowError(expect.objectContaining({ code: 'PAYEE_MISMATCH' }));
    expect(() => validateActionBinding({ ...action, withdrawal: { ...action.withdrawal!, amountBaseUnits: '101' } }))
      .toThrowError(expect.objectContaining({ code: 'AMOUNT_MISMATCH' }));
    const substitute = { ...action, payee: { ...action.payee!, recipient: 'different_customer_wallet' },
      withdrawal: { ...action.withdrawal!, destination: { ...action.withdrawal!.destination, recipient: 'different_customer_wallet' } } };
    await expect(assertApprovalCurrent(receipt, substitute, checkContext)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(assertApprovalCurrent(receipt, { ...action, withdrawal: { ...action.withdrawal!, policy: { ...reference, version: 2 } } }, checkContext))
      .rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
  });

  it('binds exact tool provider/resource/request/challenge and spends only operating allowance with separate network fees', async () => {
    const { action, approveContext, checkContext, mandate, head } = await fixture('purchase_tool');
    const withFee = { ...action, components: [...action.components, component('1', 'network_a', 'network_fee')] };
    const receipt = await approveExactAction(approveContext, withFee);
    await expect(assertMandateAction(withFee, head, mandate, now, { ...checkContext, receipt }, approver)).resolves.toBeUndefined();
    for (const challenge of [
      { ...action.toolPurchase!.challenge, providerId: 'another_provider' },
      { ...action.toolPurchase!.challenge, resourceHash: 'c'.repeat(64) },
      { ...action.toolPurchase!.challenge, requestHash: 'c'.repeat(64) },
      { ...action.toolPurchase!.challenge, payee: { ...action.payee!, recipient: 'another_wallet' } },
      { ...action.toolPurchase!.challenge, expiresAt: now },
    ]) expect(() => validateActionBinding({ ...action, toolPurchase: { ...action.toolPurchase!, challenge } }))
      .toThrowError(expect.objectContaining({ code: 'CHALLENGE_MISMATCH' }));
    for (const category of ['supplier_principal', 'supplier_fee', 'platform_fee'] as const) {
      expect(() => validateActionBinding({ ...action, components: [component('100', 'tool_a', category)] }))
        .toThrowError(expect.objectContaining({ code: 'AMOUNT_MISMATCH' }));
    }
    expect(() => validateActionBinding({ ...action, components: [component('101', 'tool_a', 'operating_allowance')] }))
      .toThrowError(expect.objectContaining({ code: 'AMOUNT_MISMATCH' }));
    for (const toolPurchase of [
      { ...action.toolPurchase!, request: { ...reference, version: 2 } },
      { ...action.toolPurchase!, resource: { ...reference, version: 2 } },
      { ...action.toolPurchase!, challenge: { ...action.toolPurchase!.challenge, hash: 'c'.repeat(64) } },
      { ...action.toolPurchase!, deliveryPolicy: { ...reference, version: 2 } },
      { ...action.toolPurchase!, allowlistPolicy: { ...reference, version: 2 } },
    ]) await expect(assertApprovalCurrent(receipt, { ...withFee, toolPurchase }, checkContext)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(prepareEconomicIntent({ id: 'operation_a', paymentAuthorizationId: 'payment_a', approvalId: receipt.id, now: expiry }, action))
      .rejects.toMatchObject({ code: 'TERMS_EXPIRED' });
  });
});

function offerFixture(): OfferTermsVersion {
  return { id: 'offer_a', version: 1, previousVersionHash: null, organizationId: 'org_a', environment: 'development', supplierRelationshipId: 'supplier_a',
    source: reference, payee: { id: 'payee_a', version: 1, environment: 'development', network: asset.network, recipient: 'supplier_wallet',
      assetId: asset.id, mint: asset.mint, tokenProgram: asset.tokenProgram, verificationRef: 'verified_payee_fixture' }, assets: [asset],
    window: { startsAt: expiry, endsAt: '2026-11-14T16:00:00.000Z', timeZone: 'America/Chicago' },
    items: [{ id: 'chairs', specification: 'Banquet chairs', quantityBaseUnits: '120', quantityScale: 0, unit: 'chairs' }],
    costs: CommercialCostKindSchema.options.map(kind => ({ id: `cost_${kind}`, kind, state: kind === 'base' || kind === 'hold' ? 'QUOTED' : 'NOT_APPLICABLE',
      assetId: asset.id, amountBaseUnits: kind === 'base' ? '100' : kind === 'hold' ? '5' : '0', dueTrigger: 'Named accepted milestone',
      earnedTrigger: 'Terms-defined performance', refundable: 'NONREFUNDABLE', refundTerms: '' })),
    paymentSchedule: [{ id: 'hold', costIds: ['cost_hold'], kind: 'EARNED_HOLD', dueTrigger: 'Accepted reservation' },
      { id: 'final', costIds: ['cost_base'], kind: 'FINAL', dueTrigger: 'Authorized acceptance' }],
    acceptancePolicy: reference, substitutionTerms: 'Separate authorized amendment', disputeTerms: 'Disputed portions remain held', expiresAt: expiry };
}
describe('complete immutable commercial terms', () => {
  it('qualifies exact versioned charges, separately accounting earned holds and final price', async () => {
    const qualified = await qualifyOfferTerms(offerFixture(), now);
    expect(quotedCostBounds(qualified.terms)).toEqual({ test_asset: '105' });
    expect(() => { qualified.terms.costs[0]!.amountBaseUnits = '1'; }).toThrow();
    const counter = { ...offerFixture(), version: 2, previousVersionHash: qualified.hash,
      costs: offerFixture().costs.map(cost => cost.kind === 'base' ? { ...cost, amountBaseUnits: '110' } : cost) };
    expect((await qualifyOfferTerms(counter, now, qualified.terms)).hash).not.toBe(qualified.hash);
  });
  it('rejects omitted/unknown mandatory costs, duplicate advance charges and changed asset identity', async () => {
    const offer = offerFixture();
    const unknown = { ...offer, costs: offer.costs.map(cost => cost.kind === 'tax' ? { ...cost, state: 'UNKNOWN' as const, amountBaseUnits: null } : cost) };
    await expect(qualifyOfferTerms(unknown, now)).rejects.toMatchObject({ code: 'TERMS_INCOMPLETE' });
    await expect(qualifyOfferTerms({ ...offer, costs: [...offer.costs.filter(cost => cost.kind !== 'tax'), { ...offer.costs[0]!, id: 'other_base' }] }, now))
      .rejects.toMatchObject({ code: 'TERMS_INCOMPLETE' });
    await expect(qualifyOfferTerms({ ...offer, paymentSchedule: [...offer.paymentSchedule, { id: 'advance', kind: 'ADVANCE', costIds: ['cost_base'], dueTrigger: 'Up front' }] }, now))
      .rejects.toMatchObject({ code: 'TERMS_INCOMPLETE' });
    await expect(qualifyOfferTerms({ ...offer, payee: { ...offer.payee, mint: 'wrong_mint' } }, now)).rejects.toMatchObject({ code: 'TERMS_INCOMPLETE' });
    await expect(qualifyOfferTerms(offer, expiry)).rejects.toMatchObject({ code: 'TERMS_EXPIRED' });
  });
});

function budgetFixture(balance = '200'): BudgetSnapshot {
  return { organizationId: 'org_a', environment: 'development', version: 1, asset, verifiedSpendableBaseUnits: balance, verifiedAt: now,
    expectedRefundBaseUnits: '60', exposures: [], spend: [{ responsibilityId: 'responsibility_a', category: 'supplier_principal',
      lifetimeBaseUnits: '0', periodBaseUnits: '0', periodStartsAt: limit().periodStartsAt, periodEndsAt: limit().periodEndsAt }] };
}
const allocationContext = { expectedVersion: 1, responsibilityId: 'responsibility_a', limits: [limit()], now, notObservedBefore: now };
describe('exact budget, liability and economic identity invariants', () => {
  it('fails closed when mutable counters omit or understate already-paid portions', () => {
    const paid = { ...component('500', 'paid_a'), responsibilityId: 'responsibility_a', kind: 'OUTGOING' as const, state: 'PAID' as const, paidAt: now };
    const inconsistent = { ...budgetFixture('1000'), exposures: [paid] };
    expect(() => reserveBudget(inconsistent, [component('100')], allocationContext)).toThrowError(expect.objectContaining({ code: 'BUDGET_INCONSISTENT' }));
    expect(() => availableForNewCommitments({ ...inconsistent, spend: [] })).toThrowError(expect.objectContaining({ code: 'BUDGET_INCONSISTENT' }));
    const lifetimeOnly = { ...inconsistent, spend: [{ ...inconsistent.spend[0]!, lifetimeBaseUnits: '500' }] };
    expect(() => availableForNewCommitments(lifetimeOnly)).toThrowError(expect.objectContaining({ code: 'BUDGET_INCONSISTENT' }));
    const reconciled = { ...inconsistent, spend: [{ ...inconsistent.spend[0]!, lifetimeBaseUnits: '500', periodBaseUnits: '500' }] };
    expect(availableForNewCommitments(reconciled)).toBe('1000');
    expect(() => reserveBudget(reconciled, [component('1')], allocationContext)).toThrowError(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
    expect(() => availableForNewCommitments({ ...reconciled, exposures: [{ ...paid, paidAt: null }] })).toThrowError(expect.objectContaining({ code: 'BUDGET_INCONSISTENT' }));
    expect(() => availableForNewCommitments({ ...reconciled, exposures: [{ ...paid, paidAt: expiry }] })).toThrowError(expect.objectContaining({ code: 'BUDGET_INCONSISTENT' }));
    expect(() => availableForNewCommitments({ ...reconciled, spend: [{ ...reconciled.spend[0]!, lifetimeBaseUnits: '499' }] })).toThrowError(expect.objectContaining({ code: 'BUDGET_INCONSISTENT' }));
    const priorPeriod = { ...reconciled, exposures: [{ ...paid, paidAt: '2026-11-13T12:00:00.000Z' }], spend: [{ ...reconciled.spend[0]!, periodBaseUnits: '0' }] };
    expect(availableForNewCommitments(priorPeriod)).toBe('1000');
    expect(() => reserveBudget(priorPeriod, [component('1')], allocationContext)).toThrowError(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
  });
  it('retains unknown coverage once, excludes expected refunds and rejects stale competing allocation', () => {
    const funded = budgetFixture();
    const reserved = reserveBudget(funded, [component('145')], allocationContext);
    expect(availableForNewCommitments(reserved)).toBe('55');
    const unknown = retainUnknownExposure(reserved, 'allocation_a');
    expect(availableForNewCommitments(unknown)).toBe('55');
    expect(unknown.exposures).toHaveLength(1);
    expect(availableForNewCommitments({ ...unknown, expectedRefundBaseUnits: '1000000' })).toBe('55');
    expect(() => reserveBudget(unknown, [component('60', 'other_job')], { ...allocationContext, expectedVersion: unknown.version, responsibilityId: 'responsibility_b' }))
      .toThrowError(expect.objectContaining({ code: 'INSUFFICIENT_RESERVE' }));
    expect(() => reserveBudget(reserved, [component('1', 'other_job')], allocationContext)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(() => availableForNewCommitments({ ...unknown, exposures: [...unknown.exposures, { ...unknown.exposures[0]!, id: 'duplicate_coverage' }] }))
      .toThrowError(expect.objectContaining({ code: 'BUDGET_INCONSISTENT' }));
  });
  it('enforces fee, operating, lifetime and period limits independently without refund resets', () => {
    expect(() => reserveBudget(budgetFixture(), [component('1', 'fee', 'network_fee')], allocationContext))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
    expect(() => reserveBudget(budgetFixture(), [component('1', 'tool', 'operating_allowance')], allocationContext))
      .toThrowError(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
    const spent = budgetFixture();
    spent.spend[0]!.lifetimeBaseUnits = '490';
    expect(() => reserveBudget(spent, [component('11')], allocationContext)).toThrowError(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
    spent.spend[0]!.lifetimeBaseUnits = '995';
    spent.spend[0]!.periodBaseUnits = '995';
    expect(() => reserveBudget(spent, [component('6')], allocationContext)).toThrowError(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
    expect(() => reserveBudget(budgetFixture(), [component('1')], { ...allocationContext, notObservedBefore: expiry }))
      .toThrowError(expect.objectContaining({ code: 'FUNDS_STALE' }));
  });
  it('preserves conservation over 250 deterministic generated allocation/unknown sequences', () => {
    let seed = 937;
    for (let run = 0; run < 250; run++) {
      let state = budgetFixture('1000');
      let reserved = 0n;
      for (let step = 0; step < 8; step++) {
        seed = (seed * 48271) % 2147483647;
        const value = BigInt(seed % 40 + 1);
        const id = `allocation_${step}`;
        state = reserveBudget(state, [component(value.toString(), id)], { ...allocationContext, expectedVersion: state.version });
        if (step % 2 === 0) state = retainUnknownExposure(state, id);
        reserved += value;
        expect(BigInt(availableForNewCommitments(state)) + reserved).toBe(1000n);
      }
    }
    expect(() => sumAmounts(['18446744073709551615', '1'])).toThrowError(expect.objectContaining({ code: 'AMOUNT_OVERFLOW' }));
    expect(requiredFutureLiquidity(['20'], ['60', '90'], '5')).toBe('115');
  });
  it('reuses one economic payment identity across attempts and rejects changed purpose/amount', async () => {
    const { action } = await authorityFixture();
    const first = await prepareEconomicIntent({ id: 'operation_1', paymentAuthorizationId: 'payable_portion_1', approvalId: 'approval_a', now }, action);
    const retry = await prepareEconomicIntent({ id: 'operation_2', paymentAuthorizationId: 'payable_portion_1', approvalId: 'approval_a', now }, action);
    expect(deduplicateEconomicIntent([first], retry).id).toBe(first.id);
    const changed = await prepareEconomicIntent({ id: 'operation_3', paymentAuthorizationId: 'payable_portion_1', approvalId: 'approval_a', now }, { ...action, components: [component('101')] });
    expect(() => deduplicateEconomicIntent([first], changed)).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(first.state).toBe('PREPARED');
  });
});

const accounts: LedgerAccount[] = [
  { id: 'vault', organizationId: 'org_a', environment: 'development', assetId: asset.id, kind: 'VAULT_ASSET' },
  { id: 'available', organizationId: 'org_a', environment: 'development', assetId: asset.id, kind: 'CUSTOMER_AVAILABLE' },
];
function journalFixture(value = '200'): JournalEntry {
  return { id: 'entry_a', organizationId: 'org_a', environment: 'development', economicEventKey: 'verified_deposit_a', operationId: 'operation_a',
    postedAt: now, sourceEvidenceRefs: ['verified_source_fixture'], correctionOf: null,
    lines: [{ id: 'debit', accountId: 'vault', assetId: asset.id, direction: 'DEBIT', amountBaseUnits: value },
      { id: 'credit', accountId: 'available', assetId: asset.id, direction: 'CREDIT', amountBaseUnits: value }] };
}
describe('append-only balanced operational journal', () => {
  it('balances every asset, preserves immutable originals and rejects unbalanced or wrong-scope entries', () => {
    const entry = journalFixture();
    expect(validateJournal(entry, accounts).id).toBe('entry_a');
    expect(() => validateJournal({ ...entry, lines: [entry.lines[0]!, { ...entry.lines[1]!, amountBaseUnits: '199' }] }, accounts))
      .toThrowError(expect.objectContaining({ code: 'JOURNAL_UNBALANCED' }));
    expect(() => validateJournal({ ...entry, organizationId: 'other_org' }, accounts)).toThrowError(expect.objectContaining({ code: 'JOURNAL_INVALID' }));
    const posted = appendJournal([], entry, accounts);
    expect(() => { posted[0]!.lines[0]!.amountBaseUnits = '1'; }).toThrow();
    expect(appendJournal(posted, { ...entry, id: 'retried_entry' }, accounts)).toHaveLength(1);
    expect(() => appendJournal(posted, journalFixture('201'), accounts)).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    const anotherAssetAccount = { ...accounts[1]!, assetId: 'other_asset' };
    expect(() => validateJournal({ ...entry, lines: [entry.lines[0]!, { ...entry.lines[1]!, assetId: 'other_asset' }] }, [accounts[0]!, anotherAssetAccount]))
      .toThrowError(expect.objectContaining({ code: 'JOURNAL_UNBALANCED' }));
  });
  it('permits a linked full reversal once, preserving both entries and refusing arbitrary corrections', () => {
    const original = journalFixture();
    const reversal: JournalEntry = { ...original, id: 'reversal_a', economicEventKey: 'correction_a', correctionOf: original.id,
      lines: original.lines.map(line => ({ ...line, direction: line.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT' })) };
    const corrected = appendJournal([original], reversal, accounts);
    expect(corrected).toHaveLength(2);
    expect(corrected[0]).toEqual(original);
    expect(() => appendJournal(corrected, { ...reversal, id: 'reversal_b', economicEventKey: 'correction_b' }, accounts))
      .toThrowError(expect.objectContaining({ code: 'CORRECTION_INVALID' }));
    expect(() => appendJournal([original], { ...reversal, lines: journalFixture('199').lines }, accounts))
      .toThrowError(expect.objectContaining({ code: 'CORRECTION_INVALID' }));
  });
});
