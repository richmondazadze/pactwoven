import { type ActionBinding, ToolPurchaseBindingSchema } from '../../../packages/contracts/src/financial.js';
import { FINANCE_DEVNET_ASSET, SolanaPublicKeySchema } from '../../../packages/contracts/src/finance-provenance.js';
import { InstantSchema } from '../../../packages/contracts/src/core.js';
import { validateActionBinding } from '../../../packages/domain/src/action-binding.js';
import { commandDigest } from '../../../packages/domain/src/canonical.js';
import { EQUIPMENT_OPTIMIZER, equipmentRequestHash, equipmentResourceHash } from './equipment-optimizer.js';

export class PaidToolBindingError extends Error {
  constructor() { super('The exact unexpired paid-tool quote, request, resource and development asset are required.'); this.name = 'PaidToolBindingError'; }
}
export async function paidToolChallengeHash(input: unknown): Promise<string> {
  const challenge = ToolPurchaseBindingSchema.shape.challenge.omit({ hash: true }).parse(input);
  return commandDigest({ namespace: 'pactwoven.paid-tools.challenge.v1', challenge });
}
/** This produces an INERT candidate, never approval or a payment permit.
 * Caller must independently resolve allowlist/delivery-policy versions and
 * reuse current mandate/approval and locked budget checks in the real service.
 * No quote can widen the existing native advisory task's external authority. */
export async function inspectEquipmentPurchase(input: ActionBinding, request: unknown, catalogue: unknown, nowInput: string) {
  const action = validateActionBinding(input), now = Date.parse(InstantSchema.parse(nowInput)), tool = action.toolPurchase;
  const paymentAsset = action.assets.find(asset => asset.id === action.payee?.assetId);
  if (action.kind !== 'purchase_tool' || !tool || !action.payee || action.authority.environment !== 'development' ||
    tool.providerId !== EQUIPMENT_OPTIMIZER || Date.parse(action.expiresAt) <= now || Date.parse(tool.challenge.expiresAt) <= now ||
    !paymentAsset || paymentAsset.network !== 'solana-devnet' || paymentAsset.mint !== FINANCE_DEVNET_ASSET.mint ||
      paymentAsset.tokenProgram !== FINANCE_DEVNET_ASSET.tokenProgram || paymentAsset.decimals !== 6 ||
    tool.request.hash !== await equipmentRequestHash(request) || tool.resource.hash !== await equipmentResourceHash(catalogue)) throw new PaidToolBindingError();
  SolanaPublicKeySchema.parse(action.payee.recipient);
  const { hash, ...challenge } = tool.challenge;
  if (hash !== await paidToolChallengeHash(challenge)) throw new PaidToolBindingError();
  return Object.freeze({ kind: 'inert_paid_tool_candidate' as const, authority: 'none' as const,
    actionHash: await commandDigest(action), requestHash: tool.request.hash, resourceHash: tool.resource.hash,
    quoteHash: hash, priceBaseUnits: tool.challenge.amountBaseUnits, service: EQUIPMENT_OPTIMIZER });
}
