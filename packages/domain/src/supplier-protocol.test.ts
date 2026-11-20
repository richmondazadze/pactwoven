import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommercialCostKindSchema, SupplierCapabilitySchema, UntrustedSupplierAvailabilityObservationSchema,
  type OfferTermsVersion, type SupplierCapabilityDeclaration, type SupplierOriginalEffectIdentity,
  type SupplierStoredDelivery, type UntrustedSupplierCapabilityManifest, type UntrustedSupplierEffectResult,
  type UntrustedSupplierMessage,
} from '@pactwoven/contracts';
import { commandDigest } from './canonical.js';
import {
  assessUntrustedSupplierAvailability, inspectSupplierCapability, inspectSupplierMessageDelivery,
  planSupplierEffectRecovery, prepareUntrustedSupplierMessage, snapshotSupplierEffectUpdate, supplierMessageDigest,
} from './supplier-protocol.js';

const now = '2026-11-15T10:05:00Z';
const reference = (id = 'synthetic_record') => ({ id, version: 1, hash: 'a'.repeat(64) });
const scope = { environment: 'simulation' as const, buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier', supplierRelationshipId: 'relationship' };
const provenance = { synthetic: true as const, kind: 'SYNTHETIC' as const, runId: 'fixture_run', fixture: reference('fixture') };
const window = { startsAt: '2026-11-15T11:00:00Z', endsAt: '2026-11-15T15:00:00Z', timeZone: 'America/Chicago' };
type DispatchMessage = Extract<UntrustedSupplierMessage, { action: 'dispatch_update' }>;
const message = (): DispatchMessage => structuredClone({
  protocol: 'PACTWOVEN_SUPPLIER', protocolVersion: 1, scope, senderOrganizationId: 'supplier', recipientOrganizationId: 'buyer', messageId: 'message',
  senderPrincipal: reference('principal'), relationship: reference('relationship'), exchangeId: 'exchange',
  references: { responsibility: reference('responsibility'), offer: reference('offer'), commitment: reference('commitment') },
  version: 1, predecessor: null, issuedAt: '2026-11-15T10:00:00Z', expiresAt: '2026-11-15T11:00:00Z', nonce: 'nonce_value_1234a',
  authenticationRef: reference('authentication'), provenance,
  action: 'dispatch_update', payload: { dispatch: reference('dispatch'), state: 'DISPATCHED', effectiveAt: '2026-11-15T10:00:00Z', estimatedArrivalAt: null, evidenceRefs: [reference('evidence'), reference('evidence_2')] },
});
const query = () => structuredClone({ scope, resource: reference('resource'), quantity: { quantityBaseUnits: '1200', quantityScale: 2, unit: 'unit' }, window });
const observation = () => UntrustedSupplierAvailabilityObservationSchema.parse({ schemaVersion: 1, id: 'observation', ...query(),
  claimedAssurance: 'OBSERVED_AVAILABILITY', acceptedTerms: null, claimedEnforcementRef: null,
  externalReference: { systemRef: 'fixture_system', recordId: 'record-1' }, source: reference('source'),
  observedAt: '2026-11-15T10:00:00Z', expiresAt: '2026-11-15T11:00:00Z', evidenceRefs: [reference('evidence')], provenance });
const identity = (): SupplierOriginalEffectIdentity => structuredClone({ scope, operationId: 'operation', capability: 'hold', connector: reference('connector'), accountRef: 'account',
  originalMessageId: 'hold_message', requestDigest: 'b'.repeat(64), idempotencyKey: 'original_key_1234', customerReference: 'customer_ref',
  createdAt: '2026-11-15T10:00:00Z', provenance });
const unknownResult = (): Extract<UntrustedSupplierEffectResult, { state: 'unknown' }> => ({
  identity: identity(), observedAt: '2026-11-15T10:01:00Z', diagnosticRef: reference('diagnostic'), state: 'unknown', externalReference: null, nextCheckAt: null, reason: 'TIMEOUT',
});
const unsupported = (): SupplierCapabilityDeclaration => ({ mode: 'UNSUPPORTED', accountRef: null, credentialScopeRefs: [],
  idempotency: { kind: 'NOT_APPLICABLE' }, rateLimit: { kind: 'NOT_APPLICABLE' }, observationLag: { kind: 'NOT_APPLICABLE' }, lookup: 'NONE' });
const declaration = (): SupplierCapabilityDeclaration => ({ mode: 'AUTOMATIC', accountRef: 'account', credentialScopeRefs: ['credential_scope'],
  idempotency: { kind: 'KEYED', retentionMs: 1000 }, rateLimit: { kind: 'BOUNDED', requests: 10, windowMs: 1000 },
  observationLag: { kind: 'BOUNDED', maximumMs: 1000 }, lookup: 'ORIGINAL_CUSTOMER_REFERENCE' });
const manifest = (): UntrustedSupplierCapabilityManifest => structuredClone({ schemaVersion: 1, scope, source: reference('manifest'), provenance,
  observedAt: '2026-11-15T10:00:00Z', expiresAt: '2026-11-15T11:00:00Z',
  capabilities: Object.fromEntries(SupplierCapabilitySchema.options.map(capability => [capability, capability === 'status_reconciliation' ? declaration() : unsupported()])) as UntrustedSupplierCapabilityManifest['capabilities'],
  manualResolution: { mode: 'SUPPORTED', accountRef: 'account', procedureRef: reference('manual_procedure') } });
async function storedDelivery(input = message()): Promise<SupplierStoredDelivery> {
  const digest = await supplierMessageDigest(input);
  const identity = { protocol: input.protocol, protocolVersion: input.protocolVersion, scope: input.scope,
    senderOrganizationId: input.senderOrganizationId, recipientOrganizationId: input.recipientOrganizationId, messageId: input.messageId };
  return { receipt: { kind: 'DURABLY_RECEIVED', receiptId: 'receipt', identity, messageDigest: digest, receivedAt: '2026-11-15T10:00:01Z', inboxRecord: reference('inbox') },
    acknowledgement: { kind: 'DOMAIN_ACKNOWLEDGEMENT', acknowledgementId: 'ack', identity, messageDigest: digest, recordedAt: '2026-11-15T10:00:02Z', provenance,
      outcome: { state: 'UPDATE_RECORDED', record: reference('dispatch'), evidenceRefs: [reference('evidence')] } } };
}
function terms(): OfferTermsVersion {
  const asset = { id: 'asset', environment: 'simulation' as const, network: 'fixture_network', mint: 'fixture_mint', tokenProgram: 'fixture_token', symbol: 'TEST', decimals: 6 };
  return { id: 'offer', version: 1, previousVersionHash: null, organizationId: 'buyer', environment: 'simulation', supplierRelationshipId: 'relationship',
    source: reference('quote_source'), payee: { id: 'payee', version: 1, environment: 'simulation', network: asset.network, recipient: 'fixture_payee', assetId: asset.id, mint: asset.mint, tokenProgram: asset.tokenProgram, verificationRef: 'unverified_fixture_reference' },
    assets: [asset], window, items: [{ id: 'item', specification: 'Synthetic test item', quantityBaseUnits: '1', quantityScale: 0, unit: 'unit' }],
    costs: CommercialCostKindSchema.options.map(kind => ({ id: kind, kind, state: kind === 'base' ? 'QUOTED' : 'NOT_APPLICABLE', assetId: asset.id,
      amountBaseUnits: kind === 'base' ? '100' : '0', dueTrigger: 'fixture trigger', earnedTrigger: 'fixture evidence', refundable: 'NONREFUNDABLE', refundTerms: '' })),
    paymentSchedule: [{ id: 'final', costIds: ['base'], kind: 'FINAL', dueTrigger: 'fixture acceptance' }], acceptancePolicy: reference('policy'),
    substitutionTerms: 'No fixture substitutions', disputeTerms: 'Fixture review', expiresAt: '2026-11-15T11:00:00Z' };
}

afterEach(() => vi.restoreAllMocks());

describe('namespaced supplier message identity', () => {
  it('uses a fixed namespace and is independent of object key ordering', async () => {
    const input = message();
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    const digest = await supplierMessageDigest(input);
    // Fixed vector independently encoded with Python sorted-key JSON and hashlib SHA-256.
    expect(digest).toBe('fe09fc1eb58f11ce19e327dfdedc00f7bc2c7734d2d33b1aafaf62202e19fc35');
    expect(digest).toBe(await commandDigest({ namespace: 'pactwoven/supplier-message/v1', message: input }));
    expect(digest).not.toBe(await commandDigest(input));
    expect(await supplierMessageDigest(reversed)).toBe(digest);
  });
  it('covers every material envelope field and preserves semantic array order', async () => {
    const input = message();
    const digest = await supplierMessageDigest(input);
    const edits: Array<(value: DispatchMessage) => void> = [
      value => { value.scope.environment = 'development'; },
      value => { value.messageId = 'another_message'; },
      value => { value.senderOrganizationId = 'buyer'; value.recipientOrganizationId = 'supplier'; },
      value => { value.scope.supplierOrganizationId = 'another_supplier'; value.senderOrganizationId = 'another_supplier'; },
      value => { value.scope.buyerOrganizationId = 'another_buyer'; value.recipientOrganizationId = 'another_buyer'; },
      value => { value.scope.supplierRelationshipId = 'another_relationship'; value.relationship.id = 'another_relationship'; },
      value => { value.senderPrincipal.hash = 'b'.repeat(64); },
      value => { value.relationship.version = 2; },
      value => { value.exchangeId = 'another_exchange'; },
      value => { value.references.responsibility.hash = 'b'.repeat(64); },
      value => { value.references.offer!.hash = 'b'.repeat(64); },
      value => { value.references.commitment!.hash = 'b'.repeat(64); },
      value => { value.version = 2; value.predecessor = { messageId: 'prior', version: 1, hash: 'b'.repeat(64) }; },
      value => { value.issuedAt = '2026-11-15T10:00:01Z'; },
      value => { value.expiresAt = '2026-11-15T10:59:59Z'; },
      value => { value.nonce = 'another_nonce_1234'; },
      value => { value.authenticationRef.hash = 'b'.repeat(64); },
      value => { if (value.provenance.synthetic) value.provenance.fixture.hash = 'b'.repeat(64); },
      value => { value.payload.state = 'ARRIVED'; },
      value => { value.payload.dispatch.hash = 'b'.repeat(64); },
      value => { value.payload.effectiveAt = '2026-11-15T10:00:01Z'; },
      value => { value.payload.estimatedArrivalAt = '2026-11-15T12:00:00Z'; },
      value => { value.payload.evidenceRefs.reverse(); },
    ];
    for (const edit of edits) {
      const changed = structuredClone(input); edit(changed);
      expect(await supplierMessageDigest(changed)).not.toBe(digest);
    }
    const changedAction = { ...input, action: 'status_query', payload: { originalIdentity: identity() } };
    expect(await supplierMessageDigest(changedAction)).not.toBe(digest);
  });
  it('distinguishes exact duplicate replay from same-ID content collision', async () => {
    const input = message();
    const stored = await storedDelivery(input);
    const duplicate = await inspectSupplierMessageDelivery(input, stored);
    expect(duplicate).toMatchObject({ kind: 'EXACT_DUPLICATE', original: stored });
    expect(await inspectSupplierMessageDelivery({ ...input, payload: { ...input.payload, state: 'ARRIVED' } }, stored)).toMatchObject({ kind: 'MESSAGE_ID_CONFLICT' });
    expect(await inspectSupplierMessageDelivery({ ...input, provenance: { ...provenance, runId: 'other_run' } }, stored)).toMatchObject({ kind: 'MESSAGE_ID_CONFLICT' });
    expect(await inspectSupplierMessageDelivery(input, null)).toMatchObject({ kind: 'NEW_UNTRUSTED_MESSAGE' });
    expect('outcome' in duplicate).toBe(false);
  });
  it('returns the original result for an exact expired redelivery without treating it as a new action', async () => {
    const expired = { ...message(), expiresAt: '2026-11-15T10:01:00Z' };
    const stored = await storedDelivery(expired);
    await expect(prepareUntrustedSupplierMessage(expired, scope, now)).rejects.toMatchObject({ code: 'SUPPLIER_MESSAGE_EXPIRED' });
    expect(await inspectSupplierMessageDelivery(expired, stored)).toMatchObject({ kind: 'EXACT_DUPLICATE', original: stored });
  });
  it('rejects a stored result from another identity or digest', async () => {
    const stored = await storedDelivery();
    await expect(inspectSupplierMessageDelivery({ ...message(), messageId: 'another' }, stored)).rejects.toMatchObject({ code: 'SUPPLIER_DELIVERY_SCOPE_MISMATCH' });
    stored.acknowledgement!.messageDigest = 'f'.repeat(64);
    await expect(inspectSupplierMessageDelivery(message(), stored)).rejects.toMatchObject({ code: 'SUPPLIER_DELIVERY_RECORD_CONFLICT' });
  });
  it('rejects an exact stored acknowledgement that launders synthetic provenance', async () => {
    const stored = await storedDelivery();
    stored.acknowledgement!.provenance = { synthetic: false, kind: 'EXTERNAL_UNVERIFIED', connector: reference('external') };
    await expect(inspectSupplierMessageDelivery(message(), stored)).rejects.toMatchObject({ code: 'SUPPLIER_DELIVERY_RECORD_CONFLICT' });
  });
});

describe('structural message preparation without authority', () => {
  it('returns an immutable parsed message with no authenticated or authorized output', async () => {
    const result = await prepareUntrustedSupplierMessage(message(), scope, now);
    expect(result.validation).toBe('STRUCTURAL_ONLY');
    expect(Object.keys(result).sort()).toEqual(['digest', 'message', 'validation']);
    expect(result.message.action).toBe('dispatch_update');
    if (result.message.action === 'dispatch_update') expect(Object.isFrozen(result.message.payload.evidenceRefs[0])).toBe(true);
  });
  it('rejects wrong scope, expired and future messages', async () => {
    await expect(prepareUntrustedSupplierMessage(message(), { ...scope, supplierOrganizationId: 'other' }, now)).rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_MISMATCH' });
    await expect(prepareUntrustedSupplierMessage(message(), scope, message().expiresAt)).rejects.toMatchObject({ code: 'SUPPLIER_MESSAGE_EXPIRED' });
    await expect(prepareUntrustedSupplierMessage(message(), scope, '2026-11-15T09:59:59Z')).rejects.toMatchObject({ code: 'SUPPLIER_MESSAGE_NOT_CURRENT' });
  });
  it('requires exact prior message content, scope and immutable source references', async () => {
    const previous = message();
    const next = { ...message(), messageId: 'message_2', version: 2, predecessor: { messageId: previous.messageId, version: 1, hash: await supplierMessageDigest(previous) } };
    await expect(prepareUntrustedSupplierMessage(next, scope, now, previous)).resolves.toMatchObject({ validation: 'STRUCTURAL_ONLY' });
    await expect(prepareUntrustedSupplierMessage(next, scope, now)).rejects.toMatchObject({ code: 'SUPPLIER_PREDECESSOR_MISSING' });
    await expect(prepareUntrustedSupplierMessage(next, scope, now, { ...previous, payload: { ...previous.payload, state: 'ARRIVED' } })).rejects.toMatchObject({ code: 'SUPPLIER_PREDECESSOR_CONFLICT' });
    await expect(prepareUntrustedSupplierMessage({ ...next, exchangeId: 'other' }, scope, now, previous)).rejects.toMatchObject({ code: 'SUPPLIER_VERSION_CONFLICT' });
    await expect(prepareUntrustedSupplierMessage({ ...next, relationship: { ...next.relationship, hash: 'b'.repeat(64) } }, scope, now, previous)).rejects.toMatchObject({ code: 'SUPPLIER_VERSION_CONFLICT' });
    await expect(prepareUntrustedSupplierMessage({ ...next, references: { ...next.references, responsibility: { ...next.references.responsibility, hash: 'b'.repeat(64) } } }, scope, now, previous)).rejects.toMatchObject({ code: 'SUPPLIER_VERSION_CONFLICT' });
    await expect(prepareUntrustedSupplierMessage({ ...next, references: { ...next.references, offer: reference('another_offer') } }, scope, now, previous)).rejects.toMatchObject({ code: 'SUPPLIER_REFERENCE_CONFLICT' });
  });
  it('binds complete typed terms and the exact accepted payee without authenticating either', async () => {
    const offer = terms();
    const offerReference = { id: offer.id, version: offer.version, hash: await commandDigest(offer) };
    const accepted: UntrustedSupplierMessage = { ...message(), action: 'offer_acceptance', references: { ...message().references, offer: offerReference },
      payload: { terms: offer, acceptedTerms: offerReference, payee: offer.payee, evidenceRefs: [reference('acceptance_evidence')] } };
    await expect(prepareUntrustedSupplierMessage(accepted, scope, now)).resolves.toMatchObject({ validation: 'STRUCTURAL_ONLY' });
    await expect(prepareUntrustedSupplierMessage({ ...accepted, payload: { ...accepted.payload, payee: { ...offer.payee, recipient: 'changed_payee' } } }, scope, now))
      .rejects.toMatchObject({ code: 'SUPPLIER_PAYEE_REFERENCE_CONFLICT' });
    await expect(prepareUntrustedSupplierMessage({ ...accepted, payload: { ...accepted.payload, terms: { ...offer, substitutionTerms: 'changed' } } }, scope, now))
      .rejects.toMatchObject({ code: 'SUPPLIER_TERMS_REFERENCE_CONFLICT' });
  });
  it.each(['offer_proposal', 'amendment_proposal'] as const)('binds advancing %s terms to the exact previous offer branch', async action => {
    const originalTerms = terms();
    const priorOffer = { id: originalTerms.id, version: originalTerms.version, hash: await commandDigest(originalTerms) };
    const previous: UntrustedSupplierMessage = { ...message(), action: 'offer_proposal', references: { ...message().references, offer: priorOffer }, payload: { terms: originalTerms } };
    await expect(prepareUntrustedSupplierMessage(previous, scope, now)).resolves.toMatchObject({ validation: 'STRUCTURAL_ONLY' });
    const predecessor = { messageId: previous.messageId, version: previous.version, hash: await supplierMessageDigest(previous) };
    for (const previousHash of [priorOffer.hash, 'f'.repeat(64)]) {
      const nextTerms = { ...originalTerms, version: 2, previousVersionHash: previousHash, disputeTerms: 'Revised fixture terms' };
      const nextOffer = { id: nextTerms.id, version: nextTerms.version, hash: await commandDigest(nextTerms) };
      const base = { ...message(), messageId: 'next_message', version: 2, predecessor, references: { ...message().references, offer: nextOffer } };
      const next: UntrustedSupplierMessage = action === 'amendment_proposal'
        ? { ...base, action, payload: { terms: nextTerms, previousTerms: { ...priorOffer, hash: previousHash } } }
        : { ...base, action, payload: { terms: nextTerms } };
      if (previousHash === priorOffer.hash) {
        await expect(prepareUntrustedSupplierMessage(next, scope, now, previous)).resolves.toMatchObject({ validation: 'STRUCTURAL_ONLY', message: next });
      } else {
        await expect(prepareUntrustedSupplierMessage(next, scope, now, previous)).rejects.toMatchObject({ code: 'SUPPLIER_REFERENCE_CONFLICT' });
      }
    }
  });
  it.each(['offer_proposal', 'amendment_proposal'] as const)('preserves initial %s semantics when no previous exchange message is supplied', async action => {
    const priorOffer = { id: 'offer', version: 1, hash: 'f'.repeat(64) };
    const existingTerms = { ...terms(), version: 2, previousVersionHash: priorOffer.hash };
    const offer = { id: existingTerms.id, version: existingTerms.version, hash: await commandDigest(existingTerms) };
    const base = { ...message(), references: { ...message().references, offer } };
    const input: UntrustedSupplierMessage = action === 'amendment_proposal'
      ? { ...base, action, payload: { terms: existingTerms, previousTerms: priorOffer } }
      : { ...base, action, payload: { terms: existingTerms } };
    await expect(prepareUntrustedSupplierMessage(input, scope, now)).resolves.toMatchObject({ validation: 'STRUCTURAL_ONLY', message: input });
  });
  it.each(['offer_proposal', 'amendment_proposal'] as const)('preserves exact non-advancing %s terms', async action => {
    const priorOffer = { id: 'offer', version: 1, hash: 'f'.repeat(64) };
    const existingTerms = { ...terms(), version: 2, previousVersionHash: priorOffer.hash };
    const offer = { id: existingTerms.id, version: existingTerms.version, hash: await commandDigest(existingTerms) };
    const previous: UntrustedSupplierMessage = { ...message(), action: 'offer_proposal', references: { ...message().references, offer }, payload: { terms: existingTerms } };
    const base = { ...message(), messageId: 'next_message', version: 2, references: { ...message().references, offer },
      predecessor: { messageId: previous.messageId, version: previous.version, hash: await supplierMessageDigest(previous) } };
    const next: UntrustedSupplierMessage = action === 'amendment_proposal'
      ? { ...base, action, payload: { terms: existingTerms, previousTerms: priorOffer } }
      : { ...base, action, payload: { terms: existingTerms } };
    await expect(prepareUntrustedSupplierMessage(next, scope, now, previous)).resolves.toMatchObject({ validation: 'STRUCTURAL_ONLY', message: next });
  });
  it('preserves a referring message that advances an offer reference without supplying full terms', async () => {
    const previous = message();
    const next = { ...message(), messageId: 'next_message', version: 2,
      predecessor: { messageId: previous.messageId, version: previous.version, hash: await supplierMessageDigest(previous) },
      references: { ...message().references, offer: { id: previous.references.offer!.id, version: 2, hash: 'f'.repeat(64) } } };
    await expect(prepareUntrustedSupplierMessage(next, scope, now, previous)).resolves.toMatchObject({ validation: 'STRUCTURAL_ONLY', message: next });
  });
  it('snapshots current message, predecessor and expected scope before asynchronous hashing', async () => {
    const previous = message();
    const next = { ...message(), messageId: 'message_2', version: 2, predecessor: { messageId: previous.messageId, version: 1, hash: await supplierMessageDigest(previous) } };
    const expected = structuredClone(next);
    const expectedScope = structuredClone(scope);
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { await gate; return originalDigest(algorithm, data); });
    const pending = prepareUntrustedSupplierMessage(next, expectedScope, now, previous);
    next.payload.state = 'ARRIVED'; previous.payload.evidenceRefs.reverse(); expectedScope.buyerOrganizationId = 'changed';
    release();
    const prepared = await pending;
    expect(prepared.message).toEqual(expected);
    expect(prepared.digest).toBe(await supplierMessageDigest(expected));
  });
  it('snapshots stored results before asynchronous duplicate classification', async () => {
    const input = message();
    const stored = await storedDelivery(input);
    const original = structuredClone(stored);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { await gate; return digest(algorithm, data); });
    const pending = inspectSupplierMessageDelivery(input, stored);
    stored.receipt.receiptId = 'changed'; input.payload.state = 'ARRIVED';
    release();
    expect(await pending).toMatchObject({ kind: 'EXACT_DUPLICATE', original });
  });
});

describe('conservative supplier observation use', () => {
  it('keeps missing and stale observations unavailable, with no fabricated zero', () => {
    expect(assessUntrustedSupplierAvailability(query(), null, now, 300_000)).toMatchObject({ state: 'UNAVAILABLE', reason: 'MISSING', quantity: null });
    expect(assessUntrustedSupplierAvailability(query(), observation(), observation().expiresAt, 3_600_000)).toMatchObject({ state: 'UNAVAILABLE', reason: 'STALE', quantity: null });
    expect(assessUntrustedSupplierAvailability(query(), observation(), now, 299_999)).toMatchObject({ state: 'UNAVAILABLE', reason: 'STALE', quantity: null });
  });
  it('retains explicit observed zero and compares u64 quantities exactly', () => {
    const observed = observation(); observed.quantity.quantityBaseUnits = '0';
    expect(assessUntrustedSupplierAvailability(query(), observed, now, 300_000)).toMatchObject({ state: 'OBSERVATION_PRESENT', quantity: { quantityBaseUnits: '0' }, reportedQuantitySufficient: false });
    observed.quantity.quantityBaseUnits = '18446744073709551615';
    const requested = query(); requested.quantity.quantityBaseUnits = '18446744073709551614';
    expect(assessUntrustedSupplierAvailability(requested, observed, now, 300_000).reportedQuantitySufficient).toBe(true);
  });
  it.each(['OBSERVED_AVAILABILITY', 'SUPPLIER_ATTESTED_HOLD', 'SYSTEM_ENFORCED_RESERVATION'] as const)('never upgrades %s to proven exclusivity or supplier performance', assurance => {
    const observed = observation(); observed.claimedAssurance = assurance;
    if (assurance !== 'OBSERVED_AVAILABILITY') observed.acceptedTerms = reference('offer');
    if (assurance === 'SYSTEM_ENFORCED_RESERVATION') observed.claimedEnforcementRef = reference('enforcement');
    const assessment = assessUntrustedSupplierAvailability(query(), observed, now, 300_000);
    expect(assessment).toMatchObject({ state: 'OBSERVATION_PRESENT', exclusivity: 'NOT_ESTABLISHED', usableCapacity: 'NOT_ESTABLISHED', supplierPerformance: 'UNVERIFIED', observation: { provenance } });
    expect(Object.isFrozen(assessment.observation!.provenance)).toBe(true);
  });
  it('rejects mismatched resource versions, intervals, scales and future observations', () => {
    const source = observation();
    expect(assessUntrustedSupplierAvailability(query(), { ...source, resource: { ...source.resource, version: 2 } }, now, 300_000)).toMatchObject({ state: 'UNAVAILABLE', reason: 'SCOPE_OR_RESOURCE_MISMATCH' });
    expect(assessUntrustedSupplierAvailability(query(), { ...source, window: { ...window, endsAt: '2026-11-15T14:00:00Z' } }, now, 300_000)).toMatchObject({ state: 'UNAVAILABLE', reason: 'INTERVAL_MISMATCH' });
    expect(assessUntrustedSupplierAvailability(query(), { ...source, quantity: { ...source.quantity, quantityScale: 3 } }, now, 300_000)).toMatchObject({ state: 'UNAVAILABLE', reason: 'UNIT_MISMATCH' });
    expect(assessUntrustedSupplierAvailability(query(), source, '2026-11-15T09:59:59Z', 300_000)).toMatchObject({ state: 'UNAVAILABLE', reason: 'NOT_CURRENT' });
  });
  it('does not treat nonsynthetic external observations as verified performance', () => {
    const source = observation();
    source.provenance = { synthetic: false, kind: 'EXTERNAL_UNVERIFIED', connector: reference('external_source') };
    expect(assessUntrustedSupplierAvailability(query(), source, now, 300_000)).toMatchObject({
      supplierPerformance: 'UNVERIFIED', exclusivity: 'NOT_ESTABLISHED', usableCapacity: 'NOT_ESTABLISHED',
      observation: { provenance: { synthetic: false, kind: 'EXTERNAL_UNVERIFIED' } },
    });
  });
  it('fails closed on omitted, unsupported, expired and wrong-scope capability declarations', () => {
    expect(inspectSupplierCapability({}, 'hold', scope, now).state).toBe('UNAVAILABLE');
    expect(inspectSupplierCapability(manifest(), 'hold', scope, now)).toMatchObject({ state: 'UNAVAILABLE', reason: 'UNSUPPORTED' });
    expect(inspectSupplierCapability(manifest(), 'status_reconciliation', scope, now).state).toBe('DECLARED_ONLY');
    expect(inspectSupplierCapability(manifest(), 'status_reconciliation', scope, manifest().expiresAt).state).toBe('UNAVAILABLE');
    expect(inspectSupplierCapability(manifest(), 'status_reconciliation', { ...scope, supplierOrganizationId: 'other' }, now).state).toBe('UNAVAILABLE');
  });
});

describe('uncertain supplier effects retain original identity', () => {
  it('preserves identity through an unknown to pending observation, with no fabricated success', () => {
    const previous = unknownResult();
    const next = { identity: previous.identity, observedAt: now, diagnosticRef: previous.diagnosticRef, state: 'pending', externalReference: null, nextCheckAt: '2026-11-15T10:06:00Z' };
    const snapshot = snapshotSupplierEffectUpdate(previous, next);
    expect(snapshot).toMatchObject({ state: 'pending', identity: previous.identity });
    expect(Object.isFrozen(snapshot.identity.provenance)).toBe(true);
    next.identity.operationId = 'changed_after_snapshot';
    expect(snapshot.identity.operationId).toBe('operation');
  });
  it('rejects operation, request, key, account, connector and provenance substitution', () => {
    const edits: Array<(identity: SupplierOriginalEffectIdentity) => void> = [
      value => { value.operationId = 'replacement'; }, value => { value.originalMessageId = 'replacement_message'; },
      value => { value.requestDigest = 'c'.repeat(64); }, value => { value.idempotencyKey = 'replacement_key_123'; },
      value => { value.customerReference = 'new_customer_ref'; }, value => { value.accountRef = 'new_account'; },
      value => { value.connector.version = 2; }, value => { value.scope.environment = 'development'; },
      value => { value.provenance = { synthetic: false, kind: 'EXTERNAL_UNVERIFIED', connector: reference('external') }; },
    ];
    for (const edit of edits) {
      const previous = unknownResult(); const next = structuredClone(previous); edit(next.identity);
      expect(() => snapshotSupplierEffectUpdate(previous, next)).toThrow(expect.objectContaining({ code: 'SUPPLIER_EFFECT_IDENTITY_CONFLICT' }));
    }
  });
  it('retains learned external references and rejects older observations', () => {
    const previous = { ...unknownResult(), externalReference: { systemRef: 'fixture', recordId: 'external' } };
    expect(() => snapshotSupplierEffectUpdate(previous, unknownResult())).toThrow(expect.objectContaining({ code: 'SUPPLIER_EXTERNAL_REFERENCE_CONFLICT' }));
    expect(() => snapshotSupplierEffectUpdate(previous, { ...previous, observedAt: '2026-11-15T10:00:00Z' })).toThrow(expect.objectContaining({ code: 'SUPPLIER_EFFECT_OBSERVATION_STALE' }));
  });
  it('requires original lookup even after idempotency retention expires; never grants blind retry', () => {
    const plan = planSupplierEffectRecovery(unknownResult(), manifest(), now);
    expect(plan).toMatchObject({ action: 'QUALIFY_AND_RECONCILE_ORIGINAL', originalIdentity: identity(), lookup: 'ORIGINAL_CUSTOMER_REFERENCE',
      blindRetryAllowed: false, replacementEffectAllowed: false, releaseCapacityOrExposureAllowed: false, authentication: 'NOT_ESTABLISHED' });
  });
  it('uses declared manual resolution when reliable lookup is absent, unsupported or lacks an external id', () => {
    for (const declaration of [unsupported(), { ...manifest().capabilities.status_reconciliation, lookup: 'NONE' as const },
      { ...manifest().capabilities.status_reconciliation, lookup: 'EXTERNAL_REFERENCE' as const }]) {
      const input = manifest(); input.capabilities.status_reconciliation = declaration;
      expect(planSupplierEffectRecovery(unknownResult(), input, now)).toMatchObject({ action: 'SUPPORTED_MANUAL_RESOLUTION_REQUIRED', originalIdentity: identity(), blindRetryAllowed: false });
    }
  });
  it('does not invent manual support or reuse another account, source or expired capability', () => {
    const noManual = manifest(); noManual.capabilities.status_reconciliation = unsupported(); noManual.manualResolution = { mode: 'UNSUPPORTED' };
    const wrongAccount = manifest(); wrongAccount.capabilities.status_reconciliation.accountRef = 'other'; wrongAccount.manualResolution = { mode: 'SUPPORTED', accountRef: 'other', procedureRef: reference('manual') };
    const wrongSource = manifest(); wrongSource.provenance = { synthetic: false, kind: 'EXTERNAL_UNVERIFIED', connector: reference('external') };
    for (const input of [noManual, wrongAccount, wrongSource, null, { ...manifest(), expiresAt: now }]) {
      expect(planSupplierEffectRecovery(unknownResult(), input, now)).toMatchObject({ action: 'MANUAL_RESOLUTION_UNAVAILABLE', originalIdentity: identity(), releaseCapacityOrExposureAllowed: false });
    }
  });
  it('failure without confirmed absence still requires reconciliation and retains exposure', () => {
    const failed = { identity: identity(), observedAt: now, diagnosticRef: null, state: 'failed', externalReference: null, code: 'PROVIDER_FAILURE', effectConfirmedAbsent: false, absenceEvidenceRefs: [] };
    expect(planSupplierEffectRecovery(failed, manifest(), now)).toMatchObject({ action: 'QUALIFY_AND_RECONCILE_ORIGINAL', blindRetryAllowed: false, releaseCapacityOrExposureAllowed: false, replacementEffectAllowed: false });
    expect(planSupplierEffectRecovery({ ...failed, effectConfirmedAbsent: true, absenceEvidenceRefs: [reference('unverified_absence')] }, manifest(), now))
      .toMatchObject({ action: 'VERIFY_ABSENCE_AND_REVALIDATE_AUTHORITY', blindRetryAllowed: false, releaseCapacityOrExposureAllowed: false, replacementEffectAllowed: false });
  });
  it('treats parsed success as a claim requiring verification', () => {
    const observed = { ...observation(), claimedAssurance: 'SUPPLIER_ATTESTED_HOLD', acceptedTerms: reference('offer') };
    const succeeded = { identity: identity(), observedAt: now, diagnosticRef: null, state: 'succeeded', externalReference: observed.externalReference,
      evidenceRefs: [reference('supplier_claim')], value: { capability: 'hold', observation: observed } };
    expect(planSupplierEffectRecovery(succeeded, manifest(), now)).toMatchObject({ action: 'VERIFY_REPORTED_SUCCESS', releaseCapacityOrExposureAllowed: false, replacementEffectAllowed: false });
  });
});
