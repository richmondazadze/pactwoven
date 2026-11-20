import { describe, expect, it } from 'vitest';
import {
  SupplierCapabilityDeclarationSchema, SupplierCapabilitySchema, SupplierDurableReceiptSchema,
  SupplierQuantitySchema, UntrustedSupplierAvailabilityObservationSchema, UntrustedSupplierCapabilityManifestSchema,
  UntrustedSupplierDomainAcknowledgementSchema, UntrustedSupplierEffectResultSchema, UntrustedSupplierMessageSchema,
  type SupplierCapabilityDeclaration, type SupplierOriginalEffectIdentity, type UntrustedSupplierCapabilityManifest,
  type UntrustedSupplierMessage,
} from './supplier-protocol';

const reference = (id = 'synthetic_record') => ({ id, version: 1, hash: 'a'.repeat(64) });
const scope = { environment: 'simulation' as const, buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier', supplierRelationshipId: 'relationship' };
const provenance = { synthetic: true as const, kind: 'SYNTHETIC' as const, runId: 'fixture_run', fixture: reference('fixture') };
const window = { startsAt: '2026-11-15T11:00:00Z', endsAt: '2026-11-15T15:00:00Z', timeZone: 'America/Chicago' };
const unsupported = (): SupplierCapabilityDeclaration => ({ mode: 'UNSUPPORTED', accountRef: null, credentialScopeRefs: [],
  idempotency: { kind: 'NOT_APPLICABLE' }, rateLimit: { kind: 'NOT_APPLICABLE' }, observationLag: { kind: 'NOT_APPLICABLE' }, lookup: 'NONE' });
const manifest = (): UntrustedSupplierCapabilityManifest => ({ schemaVersion: 1, scope, source: reference('manifest'), provenance,
  observedAt: '2026-11-15T10:00:00Z', expiresAt: '2026-11-15T11:00:00Z',
  capabilities: Object.fromEntries(SupplierCapabilitySchema.options.map(capability => [capability, unsupported()])) as UntrustedSupplierCapabilityManifest['capabilities'],
  manualResolution: { mode: 'UNSUPPORTED' } });
const observation = () => ({ schemaVersion: 1, id: 'observation', scope, resource: reference('resource'),
  quantity: { quantityBaseUnits: '1200', quantityScale: 2, unit: 'unit' }, window,
  claimedAssurance: 'OBSERVED_AVAILABILITY', acceptedTerms: null, claimedEnforcementRef: null,
  externalReference: { systemRef: 'fixture_system', recordId: 'record-1' }, source: reference('source'),
  observedAt: '2026-11-15T10:00:00Z', expiresAt: '2026-11-15T11:00:00Z', evidenceRefs: [reference('evidence')], provenance });
const identity = (): SupplierOriginalEffectIdentity => ({ scope, operationId: 'operation', capability: 'hold', connector: reference('connector'), accountRef: 'account',
  originalMessageId: 'hold_message', requestDigest: 'b'.repeat(64), idempotencyKey: 'original_key_1234', customerReference: 'customer_ref',
  createdAt: '2026-11-15T10:00:00Z', provenance });
const effect = () => ({ identity: identity(), observedAt: '2026-11-15T10:01:00Z', diagnosticRef: reference('diagnostic'), state: 'unknown',
  externalReference: null, nextCheckAt: null, reason: 'TIMEOUT' });
const message = (): Extract<UntrustedSupplierMessage, { action: 'dispatch_update' }> => ({
  protocol: 'PACTWOVEN_SUPPLIER', protocolVersion: 1, scope, senderOrganizationId: 'supplier', recipientOrganizationId: 'buyer', messageId: 'message',
  senderPrincipal: reference('principal'), relationship: reference('relationship'), exchangeId: 'exchange',
  references: { responsibility: reference('responsibility'), offer: reference('offer'), commitment: reference('commitment') },
  version: 1, predecessor: null, issuedAt: '2026-11-15T10:00:00Z', expiresAt: '2026-11-15T11:00:00Z', nonce: 'nonce_value_1234a',
  authenticationRef: reference('authentication'), provenance,
  action: 'dispatch_update', payload: { dispatch: reference('dispatch'), state: 'DISPATCHED', effectiveAt: '2026-11-15T10:00:00Z', estimatedArrivalAt: null, evidenceRefs: [reference('evidence')] },
});
const receipt = () => ({ kind: 'DURABLY_RECEIVED', receiptId: 'receipt', identity: { protocol: 'PACTWOVEN_SUPPLIER', protocolVersion: 1, scope,
  senderOrganizationId: 'supplier', recipientOrganizationId: 'buyer', messageId: 'message' },
  messageDigest: 'b'.repeat(64), receivedAt: '2026-11-15T10:00:01Z', inboxRecord: reference('inbox') });

describe('explicit supplier capabilities', () => {
  it('requires all ten declarations and retains unsupported values', () => {
    const parsed = UntrustedSupplierCapabilityManifestSchema.parse(manifest());
    expect(Object.keys(parsed.capabilities)).toHaveLength(10);
    expect(Object.values(parsed.capabilities).every(item => item.mode === 'UNSUPPORTED')).toBe(true);
  });
  it.each(SupplierCapabilitySchema.options)('rejects missing %s rather than assuming support', capability => {
    const input = manifest();
    const { [capability]: omitted, ...remaining } = input.capabilities;
    expect(omitted).toBeDefined();
    expect(UntrustedSupplierCapabilityManifestSchema.safeParse({ ...input, capabilities: remaining }).success).toBe(false);
  });
  it('rejects unknown support and secret-bearing fields', () => {
    expect(SupplierCapabilityDeclarationSchema.safeParse({ ...unsupported(), mode: 'AUTO' }).success).toBe(false);
    expect(SupplierCapabilityDeclarationSchema.safeParse({ ...unsupported(), credential: 'not_a_credential_reference' }).success).toBe(false);
    expect(SupplierCapabilityDeclarationSchema.safeParse({ ...unsupported(), lookup: 'EXTERNAL_REFERENCE' }).success).toBe(false);
  });
  it('requires scoped credentials for automatic support but allows human assisted references', () => {
    const supported = { mode: 'AUTOMATIC', accountRef: 'account', credentialScopeRefs: ['scope_reference'],
      idempotency: { kind: 'NO_DEDUPLICATION' }, rateLimit: { kind: 'UNDISCLOSED' }, observationLag: { kind: 'UNDISCLOSED' }, lookup: 'NONE' };
    expect(SupplierCapabilityDeclarationSchema.safeParse(supported).success).toBe(true);
    expect(SupplierCapabilityDeclarationSchema.safeParse({ ...supported, credentialScopeRefs: [] }).success).toBe(false);
    expect(SupplierCapabilityDeclarationSchema.safeParse({ ...supported, mode: 'HUMAN_ASSISTED', credentialScopeRefs: [] }).success).toBe(true);
    expect(SupplierCapabilityDeclarationSchema.safeParse({ ...supported, accountRef: null }).success).toBe(false);
  });
  it('rejects zero idempotency retention, invalid limits and expired-at-observation manifests', () => {
    expect(SupplierCapabilityDeclarationSchema.safeParse({ ...unsupported(), idempotency: { kind: 'KEYED', retentionMs: 0 } }).success).toBe(false);
    expect(SupplierCapabilityDeclarationSchema.safeParse({ ...unsupported(), rateLimit: { kind: 'BOUNDED', requests: 1.5, windowMs: 0 } }).success).toBe(false);
    expect(UntrustedSupplierCapabilityManifestSchema.safeParse({ ...manifest(), expiresAt: manifest().observedAt }).success).toBe(false);
  });
});

describe('untrusted availability and exact quantities', () => {
  it.each(['0', '1', '18446744073709551615'])('accepts exact u64 quantity %s', quantityBaseUnits => {
    expect(SupplierQuantitySchema.parse({ quantityBaseUnits, quantityScale: 18, unit: 'unit' }).quantityBaseUnits).toBe(quantityBaseUnits);
  });
  it.each(['-1', '01', '1.0', '1e3', '18446744073709551616'])('rejects noncanonical or overflowing quantity %s', quantityBaseUnits => {
    expect(SupplierQuantitySchema.safeParse({ quantityBaseUnits, quantityScale: 0, unit: 'unit' }).success).toBe(false);
  });
  it('rejects blank units and unsupported scales without coercion', () => {
    expect(SupplierQuantitySchema.safeParse({ quantityBaseUnits: '1', quantityScale: 0, unit: ' ' }).success).toBe(false);
    expect(SupplierQuantitySchema.safeParse({ quantityBaseUnits: '1', quantityScale: 19, unit: 'unit' }).success).toBe(false);
    expect(SupplierQuantitySchema.safeParse({ quantityBaseUnits: 1, quantityScale: 0, unit: 'unit' }).success).toBe(false);
  });
  it('requires positive held capacity and exact terms/enforcement claims', () => {
    const hold = { ...observation(), claimedAssurance: 'SUPPLIER_ATTESTED_HOLD', acceptedTerms: reference('offer') };
    expect(UntrustedSupplierAvailabilityObservationSchema.safeParse(hold).success).toBe(true);
    expect(UntrustedSupplierAvailabilityObservationSchema.safeParse({ ...hold, acceptedTerms: null }).success).toBe(false);
    expect(UntrustedSupplierAvailabilityObservationSchema.safeParse({ ...hold, quantity: { ...hold.quantity, quantityBaseUnits: '0' } }).success).toBe(false);
    expect(UntrustedSupplierAvailabilityObservationSchema.safeParse({ ...hold, claimedAssurance: 'SYSTEM_ENFORCED_RESERVATION' }).success).toBe(false);
    expect(UntrustedSupplierAvailabilityObservationSchema.safeParse({ ...hold, claimedAssurance: 'SYSTEM_ENFORCED_RESERVATION', claimedEnforcementRef: reference('enforcement') }).success).toBe(true);
    expect(UntrustedSupplierAvailabilityObservationSchema.safeParse({ ...observation(), verified: true }).success).toBe(false);
  });
  it('rejects invalid intervals, zones and observation expiry', () => {
    for (const input of [
      { ...observation(), window: { ...window, endsAt: window.startsAt } },
      { ...observation(), window: { ...window, timeZone: 'Mars/Olympus' } },
      { ...observation(), expiresAt: observation().observedAt },
      { ...observation(), expiresAt: '2026-11-16T10:00:00Z' },
    ]) expect(UntrustedSupplierAvailabilityObservationSchema.safeParse(input).success).toBe(false);
  });
  it('preserves synthetic source/version/evidence and rejects contradictory provenance', () => {
    const parsed = UntrustedSupplierAvailabilityObservationSchema.parse(observation());
    expect(parsed.provenance).toEqual(provenance);
    expect(parsed.source).toEqual(reference('source'));
    expect(parsed.evidenceRefs).toEqual([reference('evidence')]);
    expect(UntrustedSupplierAvailabilityObservationSchema.safeParse({ ...observation(), provenance: { ...provenance, synthetic: false } }).success).toBe(false);
  });
});

describe('strict supplier wire envelope', () => {
  it('retains typed content without authentication flags', () => {
    const parsed = UntrustedSupplierMessageSchema.parse(message());
    expect(parsed).toEqual(message());
    expect('verified' in parsed).toBe(false);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...message(), verified: true }).success).toBe(false);
  });
  it('rejects arbitrary payloads, omitted version and implicit coercion', () => {
    expect(UntrustedSupplierMessageSchema.safeParse({ ...message(), payload: { arbitrary: 'json' } }).success).toBe(false);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...message(), protocolVersion: '1' }).success).toBe(false);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...message(), version: undefined }).success).toBe(false);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...message(), protocolVersion: 2 }).success).toBe(false);
  });
  it('binds direction, relationship and immutable commercial references', () => {
    for (const input of [
      { ...message(), recipientOrganizationId: 'bystander' },
      { ...message(), senderOrganizationId: 'buyer' },
      { ...message(), relationship: reference('other_relationship') },
      { ...message(), references: { ...message().references, offer: null } },
      { ...message(), references: { ...message().references, commitment: null } },
    ]) expect(UntrustedSupplierMessageSchema.safeParse(input).success).toBe(false);
  });
  it('requires exact predecessor versions and strictly increasing expiry', () => {
    expect(UntrustedSupplierMessageSchema.safeParse({ ...message(), version: 2 }).success).toBe(false);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...message(), version: 2, predecessor: { messageId: 'prior', version: 3, hash: 'a'.repeat(64) } }).success).toBe(false);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...message(), version: 2, predecessor: { messageId: 'prior', version: 1, hash: 'a'.repeat(64) } }).success).toBe(true);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...message(), expiresAt: message().issuedAt }).success).toBe(false);
  });
  it('rejects nested source laundering and scope substitution', () => {
    const input = { ...message(), action: 'availability_observation', payload: observation() };
    expect(UntrustedSupplierMessageSchema.safeParse(input).success).toBe(true);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...input, payload: { ...observation(), scope: { ...scope, supplierOrganizationId: 'another_supplier' } } }).success).toBe(false);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...input, provenance: { synthetic: false, kind: 'EXTERNAL_UNVERIFIED', connector: reference('connector') } }).success).toBe(false);
  });
  it('requires distinct positive refund amounts', () => {
    const payload = { originalIdentity: identity(), acceptedTerms: reference('offer'), requestedAmounts: [{ assetId: 'asset', amountBaseUnits: '1' }], reason: 'UNFULFILLED' };
    const input = { ...message(), action: 'refund_request', payload };
    expect(UntrustedSupplierMessageSchema.safeParse(input).success).toBe(true);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...input, payload: { ...payload, requestedAmounts: [...payload.requestedAmounts, ...payload.requestedAmounts] } }).success).toBe(false);
    expect(UntrustedSupplierMessageSchema.safeParse({ ...input, payload: { ...payload, requestedAmounts: [{ assetId: 'asset', amountBaseUnits: '0' }] } }).success).toBe(false);
  });
});

describe('receipts, acknowledgements and effect claims', () => {
  it('cannot turn durable receipt into terms, money or capacity acceptance', () => {
    expect(SupplierDurableReceiptSchema.safeParse(receipt()).success).toBe(true);
    for (const added of [{ acceptedTerms: reference('offer') }, { accepted: true }, { amountBaseUnits: '100' }, { outcome: 'CAPACITY_ACCEPTED' }]) {
      expect(SupplierDurableReceiptSchema.safeParse({ ...receipt(), ...added }).success).toBe(false);
    }
    expect(UntrustedSupplierDomainAcknowledgementSchema.safeParse(receipt()).success).toBe(false);
  });
  it('cannot acknowledge a bare availability observation as acquired capacity', () => {
    const input = { kind: 'DOMAIN_ACKNOWLEDGEMENT', acknowledgementId: 'ack', identity: receipt().identity,
      messageDigest: 'b'.repeat(64), recordedAt: '2026-11-15T10:02:00Z', provenance, outcome: { state: 'CAPACITY_ACCEPTED', observation: observation() } };
    expect(UntrustedSupplierDomainAcknowledgementSchema.safeParse(input).success).toBe(false);
    expect(UntrustedSupplierDomainAcknowledgementSchema.safeParse({ ...input, outcome: { state: 'CAPACITY_ACCEPTED', observation: { ...observation(), claimedAssurance: 'SUPPLIER_ATTESTED_HOLD', acceptedTerms: reference('offer') } } }).success).toBe(true);
  });
  it('unknown outcome retains original lookup identity without inventing an external id', () => {
    const parsed = UntrustedSupplierEffectResultSchema.parse(effect());
    expect(parsed.identity).toEqual(identity());
    expect(parsed.externalReference).toBeNull();
    expect(UntrustedSupplierEffectResultSchema.safeParse({ ...effect(), identity: { ...identity(), idempotencyKey: undefined } }).success).toBe(false);
    expect(UntrustedSupplierEffectResultSchema.safeParse({ ...effect(), effectConfirmedAbsent: true }).success).toBe(false);
  });
  it('requires explicit evidence for claimed absence and separates pending checks', () => {
    const failed = { identity: identity(), observedAt: effect().observedAt, diagnosticRef: null, state: 'failed', externalReference: null,
      code: 'PROVIDER_FAILURE', effectConfirmedAbsent: false, absenceEvidenceRefs: [] };
    expect(UntrustedSupplierEffectResultSchema.safeParse(failed).success).toBe(true);
    expect(UntrustedSupplierEffectResultSchema.safeParse({ ...failed, effectConfirmedAbsent: true }).success).toBe(false);
    expect(UntrustedSupplierEffectResultSchema.safeParse({ ...failed, effectConfirmedAbsent: true, absenceEvidenceRefs: [reference('absence')] }).success).toBe(true);
    expect(UntrustedSupplierEffectResultSchema.safeParse({ ...effect(), nextCheckAt: '2026-11-15T09:00:00Z' }).success).toBe(false);
  });
  it('rejects a result capability or provenance that differs from the original operation', () => {
    const hold = { ...observation(), claimedAssurance: 'SUPPLIER_ATTESTED_HOLD', acceptedTerms: reference('offer') };
    const succeeded = { identity: identity(), observedAt: effect().observedAt, diagnosticRef: null, state: 'succeeded', externalReference: hold.externalReference,
      evidenceRefs: [reference('receipt_evidence')], value: { capability: 'hold', observation: hold } };
    expect(UntrustedSupplierEffectResultSchema.safeParse(succeeded).success).toBe(true);
    expect(UntrustedSupplierEffectResultSchema.safeParse({ ...succeeded, identity: { ...identity(), capability: 'activation' } }).success).toBe(false);
    expect(UntrustedSupplierEffectResultSchema.safeParse({ ...succeeded, value: { capability: 'hold', observation: { ...hold, provenance: { ...provenance, runId: 'different_run' } } } }).success).toBe(false);
  });
});
