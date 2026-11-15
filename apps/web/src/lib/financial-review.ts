import type { ActionBinding, ApprovalPolicy, ApprovalReceipt, Asset, FinancialCategory, FinancialComponent, MandateHead, MandateVersion, OfferTermsVersion } from '@pactwoven/contracts';

export const chargeCategories: { key: FinancialCategory; label: string; explanation: string }[] = [
  { key: 'supplier_principal', label: 'Supplier principal', explanation: 'The supplier’s underlying goods or services.' },
  { key: 'supplier_fee', label: 'Supplier charges', explanation: 'Supplier fees, kept separate from principal.' },
  { key: 'platform_fee', label: 'Platform fee', explanation: 'Charges payable to the platform.' },
  { key: 'network_fee', label: 'Network fee', explanation: 'Transaction and network costs.' },
  { key: 'operating_allowance', label: 'Agent & tool allowance', explanation: 'Agent, API and tool spending from the operating allowance.' },
];
export const actionLabels: Record<ActionBinding['kind'], string> = {
  accept_offer: 'Accept offer', reserve_capacity: 'Reserve capacity', activate_commitment: 'Activate commitment',
  allocate_funds: 'Allocate funds', pay_supplier: 'Pay supplier', withdraw_unused: 'Withdraw unused funds', purchase_tool: 'Purchase tool access',
};
export type ReviewScope = { organizationId: string; environment: ActionBinding['authority']['environment']; responsibilityId: string };
export type QualifiedTermsView = { terms: OfferTermsVersion; hash: string };
export type ResolvedPolicyText = { reference: OfferTermsVersion['acceptancePolicy']; text: string };
export type ExactActionDocuments = {
  withdrawalPolicy: ResolvedPolicyText | null;
  toolResource: ResolvedPolicyText | null;
  toolRequest: ResolvedPolicyText | null;
  toolAllowlistPolicy: ResolvedPolicyText | null;
  toolDeliveryPolicy: ResolvedPolicyText | null;
};
export function matchingPolicyText(reference: OfferTermsVersion['acceptancePolicy'], resolved: ResolvedPolicyText | null): string | null {
  return resolved && resolved.reference.id === reference.id && resolved.reference.version === reference.version && resolved.reference.hash === reference.hash && resolved.text.trim() ? resolved.text : null;
}
export function samePayee(a: NonNullable<ActionBinding['payee']>, b: NonNullable<ActionBinding['payee']>): boolean {
  return a.id === b.id && a.version === b.version && a.environment === b.environment && a.network === b.network && a.recipient === b.recipient && a.assetId === b.assetId && a.mint === b.mint && a.tokenProgram === b.tokenProgram && a.verificationRef === b.verificationRef;
}
export function reviewAsset(assets: Asset[], id: string, environment: Asset['environment']): Asset | undefined {
  const matches = assets.filter(asset => asset.id === id);
  return matches.length === 1 && matches[0]?.environment === environment ? matches[0] : undefined;
}

/** Decimal placement uses strings only: financial displays never pass through floating point. */
export function formatBaseUnits(units: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(units) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return 'Unrecognized amount';
  const digits = units.padStart(decimals + 1, '0');
  const whole = (decimals ? digits.slice(0, -decimals) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimals ? `${whole}.${digits.slice(-decimals)}` : whole;
}
export function formatAssetAmount(units: string, asset: Asset | undefined): string {
  return asset ? `${formatBaseUnits(units, asset.decimals)} ${asset.symbol}` : `${units} base units · asset details unavailable`;
}
export function totalsByAsset(components: FinancialComponent[]): { assetId: string; amountBaseUnits: string }[] {
  const totals = new Map<string, bigint>();
  for (const component of components) totals.set(component.assetId, (totals.get(component.assetId) ?? 0n) + BigInt(component.amountBaseUnits));
  return [...totals].map(([assetId, amount]) => ({ assetId, amountBaseUnits: amount.toString() }));
}
export function sameReviewScope(value: ReviewScope, scope: ReviewScope): boolean {
  return value.organizationId === scope.organizationId && value.environment === scope.environment && value.responsibilityId === scope.responsibilityId;
}
export function receiptMatchesReview(receipt: ApprovalReceipt, action: ActionBinding, actionHash: string, requestedBy: string, policy: ApprovalPolicy | null): boolean {
  return receipt.actionHash === actionHash && receipt.requesterId === requestedBy && receipt.approverId !== requestedBy &&
    receipt.authority.organizationId === action.authority.organizationId && receipt.authority.environment === action.authority.environment &&
    receipt.authority.mandateId === action.authority.mandateId && receipt.authority.mandateVersion === action.authority.mandateVersion &&
    receipt.authority.mandateEpoch === action.authority.mandateEpoch && receipt.authority.organizationEpoch === action.authority.organizationEpoch &&
    Boolean(policy && receipt.policy.id === policy.reference.id && receipt.policy.version === policy.reference.version && receipt.policy.hash === policy.reference.hash);
}
export function mandateReviewIssues(mandate: MandateVersion, head: MandateHead, observedAt?: string): string[] {
  const issues: string[] = [];
  if (!sameReviewScope(mandate, head) || head.mandateId !== mandate.id || head.mandateVersion !== mandate.version || head.mandateEpoch !== mandate.mandateEpoch || head.organizationEpoch !== mandate.organizationEpoch || head.policyHash !== mandate.policyHash || head.expiresAt !== mandate.policy.expiresAt) issues.push('The displayed mandate version does not match the reported authority record. Refresh the review before taking action.');
  if (head.state !== 'ACTIVE') issues.push(`Authority is ${head.state.toLowerCase()}. New execution is unavailable; existing obligations remain separate.`);
  if (observedAt && Date.parse(mandate.policy.expiresAt) <= Date.parse(observedAt)) issues.push('The mandate had expired when this snapshot was observed.');
  return issues;
}
/** Presentation consistency checks only. These never grant authority or replace server qualification. */
export function exactReviewIssues(action: ActionBinding, terms: QualifiedTermsView | null, head: MandateHead | null, policy: ApprovalPolicy | null, observedAt?: string): string[] {
  const issues: string[] = [];
  if (action.components.some(component => !reviewAsset(action.assets, component.assetId, action.authority.environment))) issues.push('At least one action asset is missing, ambiguous or in a different environment. Exact amounts cannot be fully verified.');
  if (action.terms) {
    if (!terms) issues.push('The pinned supplier terms are unavailable. This review is incomplete.');
    else if (action.terms.id !== terms.terms.id || action.terms.version !== terms.terms.version || action.terms.hash !== terms.hash) issues.push('The displayed supplier terms do not match the action’s pinned version and hash.');
  } else if (terms) issues.push('Supplier terms were supplied without a pinned terms reference in this action.');
  if (terms && (terms.terms.organizationId !== action.authority.organizationId || terms.terms.environment !== action.authority.environment || terms.terms.supplierRelationshipId !== action.supplierRelationshipId)) issues.push('The supplier terms belong to a different organization, environment or supplier relationship.');
  if (terms && action.payee && !samePayee(action.payee, terms.terms.payee)) issues.push('The action’s payee differs from the payee in the pinned supplier terms.');
  if (action.kind === 'withdraw_unused' && !action.withdrawal) issues.push('The exact organization-owned return destination is missing.');
  if (action.withdrawal) {
    if (action.kind !== 'withdraw_unused') issues.push('A withdrawal binding is attached to a different action type.');
    if (action.withdrawal.destination.organizationId !== action.authority.organizationId || action.withdrawal.destination.environment !== action.authority.environment) issues.push('The return destination belongs to a different organization or environment.');
    if (!action.payee || !samePayee(action.payee, action.withdrawal.destination)) issues.push('The action payee does not match the exact return destination.');
  }
  if (action.kind === 'purchase_tool' && !action.toolPurchase) issues.push('The exact tool request and payment challenge are missing.');
  if (action.toolPurchase) {
    const tool = action.toolPurchase;
    if (action.kind !== 'purchase_tool') issues.push('A tool purchase binding is attached to a different action type.');
    if (tool.providerId !== tool.challenge.providerId || tool.resource.hash !== tool.challenge.resourceHash || tool.request.hash !== tool.challenge.requestHash) issues.push('The payment challenge does not match the exact provider, resource and request.');
    if (!action.payee || !samePayee(action.payee, tool.challenge.payee)) issues.push('The action payee does not match the payment challenge.');
    if (observedAt && Date.parse(tool.challenge.expiresAt) <= Date.parse(observedAt)) issues.push('The tool payment challenge had expired when this snapshot was observed.');
  }
  if (!head) issues.push('The current authority record is unavailable.');
  else {
    const binding = action.authority;
    if (!sameReviewScope({ ...binding, responsibilityId: action.responsibilityId }, head) || binding.mandateId !== head.mandateId || binding.mandateVersion !== head.mandateVersion || binding.mandateEpoch !== head.mandateEpoch || binding.organizationEpoch !== head.organizationEpoch) issues.push('Authority changed after this action was prepared. A fresh review is required.');
    if (head.state !== 'ACTIVE') issues.push(`Authority is ${head.state.toLowerCase()}. This action cannot proceed.`);
    if (Date.parse(action.expiresAt) > Date.parse(head.expiresAt)) issues.push('The action expiry exceeds the current mandate expiry. A newly bounded action is required.');
  }
  if (!policy) issues.push('The independent approval policy is unavailable.');
  else if (policy.organizationId !== action.authority.organizationId || policy.environment !== action.authority.environment) issues.push('The approval policy belongs to a different organization or environment.');
  if (observedAt) {
    const observed = Date.parse(observedAt);
    if (Date.parse(action.expiresAt) <= observed) issues.push('The exact action had expired when this snapshot was observed.');
    if (terms && Date.parse(terms.terms.expiresAt) <= observed) issues.push('The supplier terms had expired when this snapshot was observed.');
    if (head && Date.parse(head.expiresAt) <= observed) issues.push('The mandate had expired when this snapshot was observed.');
    if (policy && Date.parse(policy.expiresAt) <= observed) issues.push('The approval policy had expired when this snapshot was observed.');
  }
  return issues;
}
