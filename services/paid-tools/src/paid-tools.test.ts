import { describe, expect, it } from 'vitest';
import type { ActionBinding } from '../../../packages/contracts/src/financial.js';
import { FINANCE_DEVNET_ASSET } from '../../../packages/contracts/src/finance-provenance.js';
import { optimizeEquipment, equipmentRequestHash, equipmentCatalogueHash, equipmentResourceHash, type EquipmentCatalogue } from './equipment-optimizer.js';
import { inspectEquipmentPurchase, paidToolChallengeHash } from './quote-binding.js';

const now = '2026-11-19T16:00:00Z', expiresAt = '2026-11-19T16:05:00Z';
const request = { seats: 20, microphones: 2, projectors: 1, budgetMinor: 30000 };
const catalogue: EquipmentCatalogue = { version: 1, currency: 'USD', provenance: 'controlled_demo_catalogue', offers: [
  { id: 'seating', label: 'Twenty seats', seats: 20, microphones: 0, projectors: 0, priceMinor: 5000 },
  { id: 'av', label: 'Audio and projection', seats: 0, microphones: 2, projectors: 1, priceMinor: 8000 },
  { id: 'bundle', label: 'Complete package', seats: 20, microphones: 2, projectors: 1, priceMinor: 15000 },
] };
async function action(): Promise<ActionBinding> {
  const ref = { id: 'reference', version: 1, hash: 'a'.repeat(64) };
  const payee = { id: 'provider_payee', version: 1, environment: 'development' as const, network: 'solana-devnet',
    recipient: '11111111111111111111111111111111', assetId: 'devnet_usdc', mint: FINANCE_DEVNET_ASSET.mint,
    tokenProgram: FINANCE_DEVNET_ASSET.tokenProgram, verificationRef: 'payee_verification' };
  const requestHash = await equipmentRequestHash(request), resourceHash = await equipmentResourceHash(catalogue);
  const challenge = { id: 'quote_one', providerId: 'equipment_optimizer_v1', resourceHash, requestHash, payee,
    amountBaseUnits: '10000', expiresAt };
  return { schemaVersion: 1, kind: 'purchase_tool', responsibilityId: 'responsibility_one', siteId: 'site_one',
    authority: { organizationId: 'organization_one', environment: 'development', organizationEpoch: 1, mandateId: 'mandate_one', mandateVersion: 1, mandateEpoch: 1 },
    supplierRelationshipId: null, terms: null, payee, withdrawal: null,
    toolPurchase: { providerId: 'equipment_optimizer_v1', resource: { ...ref, hash: resourceHash }, request: { ...ref, hash: requestHash },
      challenge: { ...challenge, hash: await paidToolChallengeHash(challenge) }, allowlistPolicy: ref, deliveryPolicy: ref },
    assets: [{ id: 'devnet_usdc', environment: 'development', network: 'solana-devnet', mint: FINANCE_DEVNET_ASSET.mint,
      tokenProgram: FINANCE_DEVNET_ASSET.tokenProgram, symbol: 'USDC', decimals: 6 }],
    components: [{ id: 'tool_fee', economicPortionId: 'purchase_one', assetId: 'devnet_usdc', category: 'operating_allowance', amountBaseUnits: '10000' }],
    expiresAt, nonce: 'nonce_one' };
}

describe('bounded real equipment computation', () => {
  it('selects the cheapest compatible package rather than first complete offer', async () => {
    const result = await optimizeEquipment(request, catalogue);
    expect(result).toMatchObject({ status: 'feasible', selectedOfferIds: ['av', 'seating'], totalMinor: 13000, evaluatedPackages: 7,
      supplied: { seats: 20, microphones: 2, projectors: 1 }, provenance: 'controlled_demo_catalogue' });
  });
  it('changes its answer for changed budget or capacity', async () => {
    expect((await optimizeEquipment({ ...request, budgetMinor: 12999 }, catalogue)).status).toBe('no_feasible_package');
    expect((await optimizeEquipment({ ...request, seats: 40 }, catalogue)).selectedOfferIds).toEqual(['bundle', 'seating']);
  });
  it('breaks equal costs with fewer offers then stable IDs', async () => {
    const equal = { ...catalogue, offers: catalogue.offers.map(offer => offer.id === 'bundle' ? { ...offer, priceMinor: 13000 } : offer) };
    expect((await optimizeEquipment(request, equal)).selectedOfferIds).toEqual(['bundle']);
    const twins = { ...equal, offers: [{ ...equal.offers[2]!, id: 'z' }, { ...equal.offers[2]!, id: 'a' }] };
    expect((await optimizeEquipment(request, twins)).selectedOfferIds).toEqual(['a']);
  });
  it('normalizes ordering for stable hashes and binds price changes', async () => {
    expect(await equipmentCatalogueHash({ ...catalogue, offers: [...catalogue.offers].reverse() })).toBe(await equipmentCatalogueHash(catalogue));
    expect(await equipmentCatalogueHash({ ...catalogue, offers: catalogue.offers.map(row => ({ ...row, priceMinor: row.priceMinor + 1 })) })).not.toBe(await equipmentCatalogueHash(catalogue));
  });
  it.each([NaN, Infinity, -1, 1.5, 1_000_000_001])('rejects unsafe budget %s', async budgetMinor => {
    await expect(optimizeEquipment({ ...request, budgetMinor }, catalogue)).rejects.toThrow();
  });
  it('rejects unbounded, duplicate, unlabelled and unknown inputs', async () => {
    for (const invalid of [{ ...catalogue, offers: [...catalogue.offers, catalogue.offers[0]] },
      { ...catalogue, offers: Array.from({ length: 13 }, (_, i) => ({ ...catalogue.offers[0], id: `item_${i}` })) },
      { ...catalogue, provenance: 'live_supplier_quotes' }, { ...catalogue, arbitrary: true }]) {
      await expect(optimizeEquipment(request, invalid)).rejects.toThrow();
    }
    await expect(optimizeEquipment({ ...request, execute: true }, catalogue)).rejects.toThrow();
  });
});

describe('inert exact paid-tool bindings', () => {
  it('returns no authority even with a well-formed candidate', async () => {
    expect(await inspectEquipmentPurchase(await action(), request, catalogue, now)).toMatchObject({ kind: 'inert_paid_tool_candidate', authority: 'none', priceBaseUnits: '10000' });
  });
  it('rejects changed request, catalogue and expired quote', async () => {
    const original = await action();
    await expect(inspectEquipmentPurchase(original, { ...request, seats: 21 }, catalogue, now)).rejects.toThrow();
    await expect(inspectEquipmentPurchase(original, request, { ...catalogue, version: 2 }, now)).rejects.toThrow();
    await expect(inspectEquipmentPurchase(original, request, catalogue, expiresAt)).rejects.toThrow();
  });
  it('rejects recipient, amount and arbitrary asset substitutions', async () => {
    for (const mutate of [
      (a: ActionBinding) => { a.payee!.recipient = FINANCE_DEVNET_ASSET.mint; },
      (a: ActionBinding) => { a.components[0]!.amountBaseUnits = '10001'; },
      (a: ActionBinding) => { a.assets[0]!.mint = '11111111111111111111111111111111'; },
      (a: ActionBinding) => { a.toolPurchase!.challenge.hash = 'b'.repeat(64); },
      (a: ActionBinding) => { a.components[0]!.category = 'supplier_principal'; },
    ]) { const value = await action(); mutate(value); await expect(inspectEquipmentPurchase(value, request, catalogue, now)).rejects.toThrow(); }
  });
});
