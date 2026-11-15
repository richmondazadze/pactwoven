import { CommercialCostKindSchema, OfferTermsVersionSchema, type OfferTermsVersion } from '@pactwoven/contracts';
import { commandDigest } from './canonical.js';
import { immutable, instant } from './authority.js';
import { DomainError } from './errors.js';

export async function qualifyOfferTerms(input: OfferTermsVersion, now: string, previous: OfferTermsVersion | null = null): Promise<{ terms: OfferTermsVersion; hash: string }> {
  const terms = OfferTermsVersionSchema.parse(input);
  const fail = (message: string): never => { throw new DomainError('TERMS_INCOMPLETE', 422, message); };
  if (instant(terms.expiresAt) <= instant(now)) throw new DomainError('TERMS_EXPIRED', 409, 'The offer expired.');
  if (terms.version !== (previous?.version ?? 0) + 1 || (previous ? terms.previousVersionHash !== await commandDigest(previous) : terms.previousVersionHash !== null) ||
      (previous && (previous.id !== terms.id || previous.organizationId !== terms.organizationId || previous.environment !== terms.environment ||
      previous.supplierRelationshipId !== terms.supplierRelationshipId))) fail('Counteroffers must form one immutable scoped version chain.');
  const assets = new Map(terms.assets.map(asset => [asset.id, asset]));
  if (assets.size !== terms.assets.length || terms.assets.some(asset => asset.environment !== terms.environment)) fail('Asset definitions must be unique and in the same environment.');
  const payeeAsset = assets.get(terms.payee.assetId);
  if (!payeeAsset || terms.payee.environment !== terms.environment || terms.payee.network !== payeeAsset.network || terms.payee.mint !== payeeAsset.mint || terms.payee.tokenProgram !== payeeAsset.tokenProgram) {
    fail('The verified payee must match the exact settlement asset.');
  }
  const costs = new Map(terms.costs.map(cost => [cost.id, cost]));
  if (costs.size !== terms.costs.length || CommercialCostKindSchema.options.some(kind => !terms.costs.some(cost => cost.kind === kind))) {
    fail('Every required charge category must be explicitly disclosed.');
  }
  for (const cost of terms.costs) {
    if (!assets.has(cost.assetId) || cost.state === 'UNKNOWN' || cost.refundable === 'UNKNOWN' || cost.amountBaseUnits === null) fail('Unknown costs or refund terms cannot be accepted as zero.');
    if (cost.state === 'NOT_APPLICABLE' && cost.amountBaseUnits !== '0') fail('A nonapplicable charge must be explicitly zero.');
    if (cost.refundable !== 'NONREFUNDABLE' && !cost.refundTerms.trim()) fail('Refundable charges require explicit refund conditions.');
  }
  if (new Set(terms.items.map(item => item.id)).size !== terms.items.length || terms.items.some(item => BigInt(item.quantityBaseUnits) === 0n)) fail('Offer items require unique identities and positive exact quantities.');
  const scheduled = terms.paymentSchedule.flatMap(part => part.costIds);
  if (new Set(terms.paymentSchedule.map(part => part.id)).size !== terms.paymentSchedule.length || new Set(scheduled).size !== scheduled.length ||
      scheduled.some(id => !costs.has(id) || costs.get(id)!.state === 'NOT_APPLICABLE') ||
      terms.costs.some(cost => cost.state === 'QUOTED' && !scheduled.includes(cost.id))) {
    fail('Payment components must cover each quoted cost exactly once; split advances and balances into explicit cost portions.');
  }
  return immutable({ terms, hash: await commandDigest(terms) });
}

/** Conservative upper bound, including conditional fees; it is not an amount due. */
export function quotedCostBounds(terms: OfferTermsVersion): Record<string, string> {
  const totals = new Map<string, bigint>();
  for (const cost of OfferTermsVersionSchema.parse(terms).costs) {
    if (cost.state === 'UNKNOWN' || cost.amountBaseUnits === null) throw new DomainError('TERMS_INCOMPLETE', 422, 'Unknown costs have no qualified bound.');
    const total = (totals.get(cost.assetId) ?? 0n) + BigInt(cost.amountBaseUnits);
    if (total > 18_446_744_073_709_551_615n) throw new DomainError('AMOUNT_OVERFLOW', 422, 'Cost bounds exceed the supported amount range.');
    totals.set(cost.assetId, total);
  }
  return Object.fromEntries([...totals].map(([asset, total]) => [asset, total.toString()]));
}
