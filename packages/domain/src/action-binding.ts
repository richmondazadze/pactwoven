import { ActionBindingSchema, ActorContextSchema, type ActionBinding, type ActorContext } from '@pactwoven/contracts';
import { canonicalJson } from './canonical.js';
import { DomainError } from './errors.js';

/** Pure binding validation; referenced versions must be resolved from trusted storage before effect acceptance. */
export function validateActionBinding(input: ActionBinding): ActionBinding {
  const action = ActionBindingSchema.parse(input);
  const assets = new Map(action.assets.map(asset => [asset.id, asset]));
  if (assets.size !== action.assets.length || action.assets.some(asset => asset.environment !== action.authority.environment) ||
      new Set(action.components.map(component => component.id)).size !== action.components.length ||
      new Set(action.components.map(component => component.economicPortionId)).size !== action.components.length ||
      action.components.some(component => !assets.has(component.assetId) || BigInt(component.amountBaseUnits) === 0n)) {
    throw new DomainError('VALIDATION_FAILED', 422, 'Action components require unique purposes and exact environment-bound assets.');
  }
  const supplierAction = ['accept_offer', 'reserve_capacity', 'activate_commitment', 'pay_supplier'].includes(action.kind);
  if (supplierAction && (!action.terms || !action.payee || !action.supplierRelationshipId)) {
    throw new DomainError('TERMS_INCOMPLETE', 422, 'This action must pin terms, supplier relationship and verified payee versions.');
  }
  if ((action.kind !== 'withdraw_unused' && action.withdrawal) || (action.kind !== 'purchase_tool' && action.toolPurchase)) {
    throw new DomainError('TERMS_INCOMPLETE', 422, 'A destination or tool challenge cannot authorize a different action kind.');
  }
  if (action.payee) {
    const asset = assets.get(action.payee.assetId);
    if (!asset || action.payee.environment !== action.authority.environment || action.payee.network !== asset.network ||
        action.payee.mint !== asset.mint || action.payee.tokenProgram !== asset.tokenProgram ||
        action.components.some(component => component.category.startsWith('supplier_') && component.assetId !== action.payee!.assetId)) {
      throw new DomainError('ASSET_MISMATCH', 422, 'The payee must match the exact payment asset.');
    }
  }
  if (action.kind === 'withdraw_unused') {
    const binding = action.withdrawal;
    if (!binding || !action.payee || action.supplierRelationshipId || action.terms) {
      throw new DomainError('TERMS_INCOMPLETE', 422, 'Withdrawal requires a verified customer-return destination and explicit withdrawal policy.');
    }
    const { organizationId, purpose: _purpose, ...payee } = binding.destination;
    if (organizationId !== action.authority.organizationId || canonicalJson(payee) !== canonicalJson(action.payee)) {
      throw new DomainError('PAYEE_MISMATCH', 422, 'The exact return destination must belong to this organization.');
    }
    const principal = action.components.filter(component => component.category === 'supplier_principal');
    if (!principal.length || action.components.some(component => !['supplier_principal', 'network_fee'].includes(component.category)) ||
        principal.reduce((total, component) => total + BigInt(component.amountBaseUnits), 0n) !== BigInt(binding.amountBaseUnits)) {
      throw new DomainError('AMOUNT_MISMATCH', 422, 'The exact returned principal and separately capped network fees are required.');
    }
  }
  if (action.kind === 'purchase_tool') {
    const binding = action.toolPurchase;
    if (!binding || !action.payee || action.supplierRelationshipId || action.terms) {
      throw new DomainError('TERMS_INCOMPLETE', 422, 'Paid tools require a pinned provider, request, resource, challenge and delivery policy.');
    }
    const challenge = binding.challenge;
    if (binding.providerId !== challenge.providerId || binding.resource.hash !== challenge.resourceHash || binding.request.hash !== challenge.requestHash ||
        canonicalJson(action.payee) !== canonicalJson(challenge.payee) || Date.parse(action.expiresAt) > Date.parse(challenge.expiresAt)) {
      throw new DomainError('CHALLENGE_MISMATCH', 422, 'The payment challenge must match the exact provider, resource, request, payee and expiry.');
    }
    const purchase = action.components.filter(component => component.category === 'operating_allowance');
    if (!purchase.length || action.components.some(component => !['operating_allowance', 'network_fee'].includes(component.category)) ||
        purchase.some(component => component.assetId !== challenge.payee.assetId) ||
        purchase.reduce((total, component) => total + BigInt(component.amountBaseUnits), 0n) !== BigInt(challenge.amountBaseUnits)) {
      throw new DomainError('AMOUNT_MISMATCH', 422, 'Paid tools must use exact operating allowance and separately capped network fees.');
    }
  }
  return action;
}

/** ActorContext is freshly resolved by the command service, never accepted from the caller payload. */
export function assertActionActorScope(action: ActionBinding, input: ActorContext): ActorContext {
  const actor = ActorContextSchema.parse(input);
  if (actor.organizationId !== action.authority.organizationId || actor.environment !== action.authority.environment || !actor.actionSiteIds.includes(action.siteId)) {
    throw new DomainError('FORBIDDEN', 403, 'Current organization, environment and site access are required.');
  }
  return actor;
}
