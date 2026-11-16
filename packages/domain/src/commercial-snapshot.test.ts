import { describe, expect, it, vi } from 'vitest';
import { CommercialCostKindSchema, type OfferTermsVersion } from '@pactwoven/contracts';
import { commandDigest } from './canonical.js';
import { qualifyOfferTerms } from './commercial.js';

const now = '2026-11-14T12:00:00.000Z';
const expiry = '2026-11-14T13:00:00.000Z';
const scopeFields = ['id', 'organizationId', 'environment', 'supplierRelationshipId'] as const;
type ScopeField = typeof scopeFields[number];

function offer(): OfferTermsVersion {
  const reference = { id: 'policy_ref', version: 1, hash: 'a'.repeat(64) };
  const asset = { id: 'test_asset', environment: 'development' as const, network: 'solana-devnet',
    mint: 'test_mint', tokenProgram: 'test_token_program', symbol: 'TEST', decimals: 6 };
  return { id: 'offer_a', version: 1, previousVersionHash: null, organizationId: 'org_a', environment: 'development',
    supplierRelationshipId: 'supplier_a', source: reference,
    payee: { id: 'payee_a', version: 1, environment: 'development', network: asset.network, recipient: 'supplier_wallet',
      assetId: asset.id, mint: asset.mint, tokenProgram: asset.tokenProgram, verificationRef: 'verified_payee_fixture' },
    assets: [asset], window: { startsAt: expiry, endsAt: '2026-11-14T16:00:00.000Z', timeZone: 'America/Chicago' },
    items: [{ id: 'chairs', specification: 'Banquet chairs', quantityBaseUnits: '120', quantityScale: 0, unit: 'chairs' }],
    costs: CommercialCostKindSchema.options.map(kind => ({ id: `cost_${kind}`, kind,
      state: kind === 'base' || kind === 'hold' ? 'QUOTED' : 'NOT_APPLICABLE', assetId: asset.id,
      amountBaseUnits: kind === 'base' ? '100' : kind === 'hold' ? '5' : '0', dueTrigger: 'Named accepted milestone',
      earnedTrigger: 'Terms-defined performance', refundable: 'NONREFUNDABLE', refundTerms: '' })),
    paymentSchedule: [{ id: 'hold', costIds: ['cost_hold'], kind: 'EARNED_HOLD', dueTrigger: 'Accepted reservation' },
      { id: 'final', costIds: ['cost_base'], kind: 'FINAL', dueTrigger: 'Authorized acceptance' }],
    acceptancePolicy: reference, substitutionTerms: 'Separate authorized amendment',
    disputeTerms: 'Disputed portions remain held', expiresAt: expiry };
}

function changeScope(previous: OfferTermsVersion, field: ScopeField): void {
  if (field === 'environment') {
    previous.environment = 'production';
    previous.payee.environment = 'production';
    previous.assets.forEach(asset => { asset.environment = 'production'; });
  } else previous[field] = 'different_scope';
}

function restoreScope(previous: OfferTermsVersion, expected: OfferTermsVersion, field: ScopeField): void {
  if (field === 'environment') {
    previous.environment = expected.environment;
    previous.payee.environment = expected.payee.environment;
    previous.assets.forEach((asset, index) => { asset.environment = expected.assets[index]!.environment; });
  } else previous[field] = expected[field];
}

function pauseNextDigest() {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
    await gate;
    return digest(algorithm, data);
  });
  return { release, restore: () => spy.mockRestore() };
}

describe('offer predecessor snapshot across asynchronous hashing', () => {
  it.each(scopeFields)('rejects a different prior %s even if the caller changes it during hashing', async field => {
    const previous = offer();
    changeScope(previous, field);
    const terms = { ...offer(), version: 2, previousVersionHash: await commandDigest(previous) };
    const held = pauseNextDigest();
    try {
      const pending = qualifyOfferTerms(terms, now, previous);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'TERMS_INCOMPLETE' });
      restoreScope(previous, terms, field);
      held.release();
      await rejected;
    } finally { held.release(); held.restore(); }
  });

  it.each(scopeFields)('keeps a valid prior %s stable when the caller changes it during hashing', async field => {
    const previous = offer();
    const terms = { ...offer(), version: 2, previousVersionHash: await commandDigest(previous) };
    const expected = structuredClone(terms);
    const held = pauseNextDigest();
    try {
      const pending = qualifyOfferTerms(terms, now, previous);
      changeScope(previous, field);
      held.release();
      const qualified = await pending;
      expect(qualified.terms).toEqual(expected);
      expect(qualified.hash).toBe(await commandDigest(expected));
      expect(Object.isFrozen(previous)).toBe(false);
      expect(Object.isFrozen(previous.assets)).toBe(false);
      expect(Object.isFrozen(qualified.terms)).toBe(true);
    } finally { held.release(); held.restore(); }
  });
});
