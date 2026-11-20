import { z } from 'zod';
import { BaseUnitsSchema, EnvironmentSchema, IdempotencyKeySchema, IdSchema, InstantSchema, MoneySchema, ServiceWindowSchema } from './core';
import { HashSchema, OfferTermsVersionSchema, PayeeBindingSchema, VersionReferenceSchema } from './financial';

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const durationMs = z.number().int().min(0).max(31_536_000_000);
const evidenceRefs = z.array(VersionReferenceSchema).min(1).max(100);
const requestedAmounts = z.array(MoneySchema).min(1).max(10).refine(amounts =>
  new Set(amounts.map(amount => amount.assetId)).size === amounts.length && amounts.every(amount => amount.amountBaseUnits !== '0'),
'Requested amounts require distinct assets and positive exact amounts.');
const sameReference = (a: z.infer<typeof VersionReferenceSchema>, b: z.infer<typeof VersionReferenceSchema>) =>
  a.id === b.id && a.version === b.version && a.hash === b.hash;

// All supplier declarations, observations, wire messages and result claims are untrusted.
// Parsing these schemas proves shape only, never identity, consent, payment or exclusivity.
export const SupplierScopeSchema = z.strictObject({
  environment: EnvironmentSchema, buyerOrganizationId: IdSchema, supplierOrganizationId: IdSchema,
  supplierRelationshipId: IdSchema,
}).refine(value => value.buyerOrganizationId !== value.supplierOrganizationId, 'Counterparties must be distinct.');
export type SupplierScope = z.infer<typeof SupplierScopeSchema>;
export const SupplierProvenanceSchema = z.discriminatedUnion('synthetic', [
  z.strictObject({ synthetic: z.literal(true), kind: z.literal('SYNTHETIC'), runId: IdSchema, fixture: VersionReferenceSchema }),
  z.strictObject({ synthetic: z.literal(false), kind: z.literal('EXTERNAL_UNVERIFIED'), connector: VersionReferenceSchema }),
]);
export type SupplierProvenance = z.infer<typeof SupplierProvenanceSchema>;
export const SupplierCapabilitySchema = z.enum([
  'availability', 'binding_quote', 'hold', 'activation', 'amendment', 'cancellation',
  'refund_request', 'dispatch_update', 'fulfillment_evidence', 'status_reconciliation',
]);
export type SupplierCapability = z.infer<typeof SupplierCapabilitySchema>;
export const SupplierCapabilityDeclarationSchema = z.strictObject({
  mode: z.enum(['AUTOMATIC', 'HUMAN_ASSISTED', 'UNSUPPORTED']),
  accountRef: IdSchema.nullable(), credentialScopeRefs: z.array(IdSchema).max(30),
  idempotency: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('KEYED'), retentionMs: durationMs.refine(value => value > 0) }),
    z.strictObject({ kind: z.literal('NO_DEDUPLICATION') }), z.strictObject({ kind: z.literal('NOT_APPLICABLE') }),
  ]),
  rateLimit: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('BOUNDED'), requests: z.number().int().min(1).max(1_000_000), windowMs: durationMs.refine(value => value > 0) }),
    z.strictObject({ kind: z.literal('UNDISCLOSED') }), z.strictObject({ kind: z.literal('NOT_APPLICABLE') }),
  ]),
  observationLag: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('BOUNDED'), maximumMs: durationMs }),
    z.strictObject({ kind: z.literal('UNDISCLOSED') }), z.strictObject({ kind: z.literal('NOT_APPLICABLE') }),
  ]),
  lookup: z.enum(['ORIGINAL_IDEMPOTENCY_KEY', 'ORIGINAL_CUSTOMER_REFERENCE', 'EXTERNAL_REFERENCE', 'NONE']),
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(value.credentialScopeRefs).size !== value.credentialScopeRefs.length) invalid('Credential scope references must be unique.');
  if (value.mode === 'UNSUPPORTED') {
    if (value.accountRef !== null || value.credentialScopeRefs.length || value.idempotency.kind !== 'NOT_APPLICABLE' ||
        value.rateLimit.kind !== 'NOT_APPLICABLE' || value.observationLag.kind !== 'NOT_APPLICABLE' || value.lookup !== 'NONE') {
      invalid('Unsupported capability must explicitly declare no execution or lookup support.');
    }
  } else if (value.accountRef === null || value.idempotency.kind === 'NOT_APPLICABLE' || value.rateLimit.kind === 'NOT_APPLICABLE' ||
      value.observationLag.kind === 'NOT_APPLICABLE' || (value.mode === 'AUTOMATIC' && !value.credentialScopeRefs.length)) {
    invalid('Supported capability requires an account, explicit limits and automatic credential scope references.');
  }
});
export type SupplierCapabilityDeclaration = z.infer<typeof SupplierCapabilityDeclarationSchema>;
export const UntrustedSupplierCapabilityManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), scope: SupplierScopeSchema, source: VersionReferenceSchema,
  provenance: SupplierProvenanceSchema, observedAt: InstantSchema, expiresAt: InstantSchema,
  capabilities: z.strictObject({
    availability: SupplierCapabilityDeclarationSchema, binding_quote: SupplierCapabilityDeclarationSchema,
    hold: SupplierCapabilityDeclarationSchema, activation: SupplierCapabilityDeclarationSchema,
    amendment: SupplierCapabilityDeclarationSchema, cancellation: SupplierCapabilityDeclarationSchema,
    refund_request: SupplierCapabilityDeclarationSchema, dispatch_update: SupplierCapabilityDeclarationSchema,
    fulfillment_evidence: SupplierCapabilityDeclarationSchema, status_reconciliation: SupplierCapabilityDeclarationSchema,
  }),
  manualResolution: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('SUPPORTED'), accountRef: IdSchema, procedureRef: VersionReferenceSchema }),
    z.strictObject({ mode: z.literal('UNSUPPORTED') }),
  ]),
}).refine(value => Date.parse(value.expiresAt) > Date.parse(value.observedAt), 'Manifest expiry must follow observation.');
export type UntrustedSupplierCapabilityManifest = z.infer<typeof UntrustedSupplierCapabilityManifestSchema>;

export const SupplierQuantitySchema = z.strictObject({
  quantityBaseUnits: BaseUnitsSchema, quantityScale: z.number().int().min(0).max(18),
  unit: z.string().min(1).max(48).refine(value => value.trim().length > 0 && value === value.trim(), 'Use a nonblank unit without surrounding whitespace.'),
});
export type SupplierQuantity = z.infer<typeof SupplierQuantitySchema>;
export const SupplierExternalReferenceSchema = z.strictObject({ systemRef: IdSchema, recordId: z.string().min(1).max(256) });
export const SupplierAvailabilityQuerySchema = z.strictObject({
  scope: SupplierScopeSchema, resource: VersionReferenceSchema, quantity: SupplierQuantitySchema,
  window: ServiceWindowSchema,
}).refine(value => value.quantity.quantityBaseUnits !== '0', 'A query requires a positive quantity.');
export type SupplierAvailabilityQuery = z.infer<typeof SupplierAvailabilityQuerySchema>;
export const UntrustedSupplierAvailabilityObservationSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, scope: SupplierScopeSchema,
  resource: VersionReferenceSchema, quantity: SupplierQuantitySchema, window: ServiceWindowSchema,
  claimedAssurance: z.enum(['OBSERVED_AVAILABILITY', 'SUPPLIER_ATTESTED_HOLD', 'SYSTEM_ENFORCED_RESERVATION']),
  acceptedTerms: VersionReferenceSchema.nullable(), claimedEnforcementRef: VersionReferenceSchema.nullable(),
  externalReference: SupplierExternalReferenceSchema, source: VersionReferenceSchema,
  observedAt: InstantSchema, expiresAt: InstantSchema, evidenceRefs, provenance: SupplierProvenanceSchema,
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt) || Date.parse(value.expiresAt) > Date.parse(value.window.endsAt)) {
    invalid('Observation expiry must follow observation and may not exceed the resource interval.');
  }
  if (value.claimedAssurance === 'OBSERVED_AVAILABILITY') {
    if (value.acceptedTerms !== null || value.claimedEnforcementRef !== null) invalid('Availability is not a claimed lease.');
  } else if (value.acceptedTerms === null || value.quantity.quantityBaseUnits === '0') invalid('A claimed lease requires accepted terms and positive exact quantity.');
  if ((value.claimedAssurance === 'SYSTEM_ENFORCED_RESERVATION') !== (value.claimedEnforcementRef !== null)) {
    invalid('Only a system-enforced reservation claim carries an enforcement reference; the reference is not proof.');
  }
});
export type UntrustedSupplierAvailabilityObservation = z.infer<typeof UntrustedSupplierAvailabilityObservationSchema>;

export const SupplierEffectCapabilitySchema = SupplierCapabilitySchema.exclude(['availability', 'status_reconciliation']);
export const SupplierOriginalEffectIdentitySchema = z.strictObject({
  scope: SupplierScopeSchema, operationId: IdSchema, capability: SupplierEffectCapabilitySchema,
  connector: VersionReferenceSchema, accountRef: IdSchema,
  originalMessageId: IdSchema, requestDigest: HashSchema, idempotencyKey: IdempotencyKeySchema,
  customerReference: IdSchema, createdAt: InstantSchema, provenance: SupplierProvenanceSchema,
});
export type SupplierOriginalEffectIdentity = z.infer<typeof SupplierOriginalEffectIdentitySchema>;
const effectValue = z.discriminatedUnion('capability', [
  z.strictObject({ capability: z.literal('binding_quote'), terms: OfferTermsVersionSchema }),
  z.strictObject({ capability: z.literal('hold'), observation: UntrustedSupplierAvailabilityObservationSchema }),
  z.strictObject({ capability: z.literal('activation'), record: VersionReferenceSchema, acceptedTerms: VersionReferenceSchema }),
  z.strictObject({ capability: z.literal('amendment'), terms: OfferTermsVersionSchema }),
  z.strictObject({ capability: z.literal('cancellation'), record: VersionReferenceSchema, acceptedTerms: VersionReferenceSchema }),
  z.strictObject({ capability: z.literal('refund_request'), record: VersionReferenceSchema, requestedAmounts }),
  z.strictObject({ capability: z.literal('dispatch_update'), record: VersionReferenceSchema }),
  z.strictObject({ capability: z.literal('fulfillment_evidence'), record: VersionReferenceSchema }),
]);
const effectFields = {
  identity: SupplierOriginalEffectIdentitySchema, observedAt: InstantSchema,
  diagnosticRef: VersionReferenceSchema.nullable(),
};
export const UntrustedSupplierEffectResultSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...effectFields, state: z.literal('succeeded'), externalReference: SupplierExternalReferenceSchema, evidenceRefs, value: effectValue }),
  z.strictObject({ ...effectFields, state: z.literal('pending'), externalReference: SupplierExternalReferenceSchema.nullable(), nextCheckAt: InstantSchema }),
  z.strictObject({ ...effectFields, state: z.literal('unknown'), externalReference: SupplierExternalReferenceSchema.nullable(), nextCheckAt: InstantSchema.nullable(),
    reason: z.enum(['TIMEOUT', 'INCOMPLETE_RESPONSE', 'CONNECTION_LOST', 'UNRECONCILED']) }),
  z.strictObject({ ...effectFields, state: z.literal('failed'), externalReference: SupplierExternalReferenceSchema.nullable(),
    code: z.enum(['UNSUPPORTED', 'REJECTED', 'INVALID_REQUEST', 'RATE_LIMITED', 'PROVIDER_FAILURE']),
    effectConfirmedAbsent: z.boolean(), absenceEvidenceRefs: z.array(VersionReferenceSchema).max(100) }),
]).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (Date.parse(value.observedAt) < Date.parse(value.identity.createdAt)) invalid('An effect observation cannot precede its original identity.');
  if ('nextCheckAt' in value && value.nextCheckAt !== null && Date.parse(value.nextCheckAt) <= Date.parse(value.observedAt)) invalid('Next check must follow observation.');
  if (value.state === 'failed' && (value.effectConfirmedAbsent !== (value.absenceEvidenceRefs.length > 0))) invalid('Absence requires explicit evidence; nonabsence may not carry absence evidence.');
  if (value.state !== 'succeeded') return;
  if (value.identity.capability !== value.value.capability) invalid('Result capability must match the enduring original identity.');
  const nested = value.value;
  if ('terms' in nested && (nested.terms.environment !== value.identity.scope.environment ||
      nested.terms.organizationId !== value.identity.scope.buyerOrganizationId || nested.terms.supplierRelationshipId !== value.identity.scope.supplierRelationshipId)) invalid('Offer result crosses its original scope.');
  if (nested.capability === 'hold') {
    if (nested.observation.claimedAssurance === 'OBSERVED_AVAILABILITY') invalid('Observed availability is not a hold result.');
    if (!supplierScopesMatch(nested.observation.scope, value.identity.scope) || !supplierProvenanceMatches(nested.observation.provenance, value.identity.provenance)) invalid('Capacity result must preserve original scope and provenance.');
  }
});
export type UntrustedSupplierEffectResult = z.infer<typeof UntrustedSupplierEffectResultSchema>;

export const SupplierMessageIdentitySchema = z.strictObject({
  protocol: z.literal('PACTWOVEN_SUPPLIER'), protocolVersion: z.literal(1), scope: SupplierScopeSchema,
  senderOrganizationId: IdSchema, recipientOrganizationId: IdSchema, messageId: IdSchema,
}).refine(value => (value.senderOrganizationId === value.scope.buyerOrganizationId && value.recipientOrganizationId === value.scope.supplierOrganizationId) ||
  (value.senderOrganizationId === value.scope.supplierOrganizationId && value.recipientOrganizationId === value.scope.buyerOrganizationId), 'Message direction must match the scoped counterparties.');
export type SupplierMessageIdentity = z.infer<typeof SupplierMessageIdentitySchema>;
const envelopeFields = {
  ...SupplierMessageIdentitySchema.shape,
  senderPrincipal: VersionReferenceSchema, relationship: VersionReferenceSchema, exchangeId: IdSchema,
  references: z.strictObject({ responsibility: VersionReferenceSchema, offer: VersionReferenceSchema.nullable(), commitment: VersionReferenceSchema.nullable() }),
  version, predecessor: z.strictObject({ messageId: IdSchema, version, hash: HashSchema }).nullable(),
  issuedAt: InstantSchema, expiresAt: InstantSchema, nonce: IdempotencyKeySchema,
  authenticationRef: VersionReferenceSchema, provenance: SupplierProvenanceSchema,
};
const positiveQuantity = SupplierQuantitySchema.refine(value => value.quantityBaseUnits !== '0', 'Quantity must be positive.');
const effectRequestFields = { originalIdentity: SupplierOriginalEffectIdentitySchema, acceptedTerms: VersionReferenceSchema };
export const UntrustedSupplierMessageSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...envelopeFields, action: z.literal('availability_query'), payload: SupplierAvailabilityQuerySchema }),
  z.strictObject({ ...envelopeFields, action: z.literal('availability_observation'), payload: UntrustedSupplierAvailabilityObservationSchema }),
  z.strictObject({ ...envelopeFields, action: z.literal('quote_request'), payload: z.strictObject({
    lines: z.array(z.strictObject({ resource: VersionReferenceSchema, quantity: positiveQuantity, specification: z.string().min(1).max(2000) })).min(1).max(100),
    window: ServiceWindowSchema, acceptancePolicy: VersionReferenceSchema,
  }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('offer_proposal'), payload: z.strictObject({ terms: OfferTermsVersionSchema }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('offer_acceptance'), payload: z.strictObject({ terms: OfferTermsVersionSchema, acceptedTerms: VersionReferenceSchema, payee: PayeeBindingSchema, evidenceRefs }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('hold_request'), payload: z.strictObject({ query: SupplierAvailabilityQuerySchema, acceptedTerms: VersionReferenceSchema }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('capacity_observation'), payload: UntrustedSupplierAvailabilityObservationSchema }),
  z.strictObject({ ...envelopeFields, action: z.literal('activation_request'), payload: z.strictObject({ lease: VersionReferenceSchema, acceptedTerms: VersionReferenceSchema }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('amendment_proposal'), payload: z.strictObject({ previousTerms: VersionReferenceSchema, terms: OfferTermsVersionSchema }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('cancellation_request'), payload: z.strictObject({ ...effectRequestFields, reason: z.enum(['BUYER_REQUEST', 'SUPPLIER_UNAVAILABLE', 'TERMS_BREACH', 'SCHEDULE_CHANGE']) }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('refund_request'), payload: z.strictObject({ ...effectRequestFields, requestedAmounts, reason: z.enum(['CANCELLED', 'UNFULFILLED', 'PARTIAL_FULFILLMENT', 'DISPUTE']) }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('dispatch_update'), payload: z.strictObject({
    dispatch: VersionReferenceSchema, state: z.enum(['PREPARING', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED', 'DELAYED']),
    effectiveAt: InstantSchema, estimatedArrivalAt: InstantSchema.nullable(), evidenceRefs,
  }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('fulfillment_evidence'), payload: z.strictObject({
    items: z.array(z.strictObject({ offerItemId: IdSchema, quantity: positiveQuantity })).min(1).max(100), deliveredAt: InstantSchema, evidenceRefs,
  }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('status_query'), payload: z.strictObject({ originalIdentity: SupplierOriginalEffectIdentitySchema }) }),
  z.strictObject({ ...envelopeFields, action: z.literal('status_report'), payload: UntrustedSupplierEffectResultSchema }),
]).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!SupplierMessageIdentitySchema.safeParse({ protocol: value.protocol, protocolVersion: value.protocolVersion, scope: value.scope,
    senderOrganizationId: value.senderOrganizationId, recipientOrganizationId: value.recipientOrganizationId, messageId: value.messageId }).success) invalid('Message direction crosses counterparties.');
  if (value.relationship.id !== value.scope.supplierRelationshipId) invalid('Relationship reference must match scope.');
  if ((value.version === 1) !== (value.predecessor === null) || (value.predecessor !== null &&
      (value.predecessor.version !== value.version - 1 || value.predecessor.messageId === value.messageId))) invalid('Message predecessor must identify exactly the prior version.');
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) invalid('Message expiry must follow issue time.');
  const payload = value.payload;
  if ('scope' in payload && !supplierScopesMatch(payload.scope, value.scope)) invalid('Payload crosses envelope scope.');
  if ('provenance' in payload && !supplierProvenanceMatches(payload.provenance, value.provenance)) invalid('Payload must preserve envelope provenance.');
  if (value.action === 'hold_request' && !supplierScopesMatch(value.payload.query.scope, value.scope)) invalid('Hold query crosses envelope scope.');
  if (value.action === 'capacity_observation' && value.payload.claimedAssurance === 'OBSERVED_AVAILABILITY') invalid('Capacity claim requires a lease assurance.');
  if ('terms' in payload) {
    if (payload.terms.organizationId !== value.scope.buyerOrganizationId || payload.terms.environment !== value.scope.environment ||
        payload.terms.supplierRelationshipId !== value.scope.supplierRelationshipId || value.references.offer === null ||
        payload.terms.id !== value.references.offer.id || payload.terms.version !== value.references.offer.version) invalid('Offer terms must bind the envelope scope and immutable offer reference.');
    if (Date.parse(value.expiresAt) > Date.parse(payload.terms.expiresAt)) invalid('Message may not outlive proposed terms.');
  }
  if ('acceptedTerms' in payload && payload.acceptedTerms !== null && (value.references.offer === null || !sameReference(payload.acceptedTerms, value.references.offer))) invalid('Accepted terms must match the exact offer reference.');
  if (value.action === 'offer_acceptance' && value.payload.payee.environment !== value.scope.environment) invalid('Accepted payee crosses environment.');
  if (value.action === 'amendment_proposal' && (value.payload.previousTerms.id !== value.payload.terms.id ||
      value.payload.terms.version !== value.payload.previousTerms.version + 1 || value.payload.terms.previousVersionHash !== value.payload.previousTerms.hash)) invalid('Amendment must advance exactly the referenced terms version.');
  const original = value.action === 'status_report' ? value.payload.identity : ('originalIdentity' in payload ? payload.originalIdentity : null);
  if (original && (!supplierScopesMatch(original.scope, value.scope) || !supplierProvenanceMatches(original.provenance, value.provenance))) invalid('Original effect must preserve scope and provenance.');
  if (['hold_request', 'offer_acceptance', 'activation_request', 'cancellation_request', 'refund_request', 'dispatch_update', 'fulfillment_evidence', 'capacity_observation'].includes(value.action) && value.references.offer === null) invalid('Commercial actions require immutable offer terms.');
  if (['activation_request', 'cancellation_request', 'refund_request', 'dispatch_update', 'fulfillment_evidence', 'capacity_observation'].includes(value.action) && value.references.commitment === null) invalid('Commitment action requires an immutable commitment.');
  if (value.action === 'fulfillment_evidence' && new Set(value.payload.items.map(item => item.offerItemId)).size !== value.payload.items.length) invalid('Fulfillment items must be unique.');
});
export type UntrustedSupplierMessage = z.infer<typeof UntrustedSupplierMessageSchema>;
export type SupplierMessageAction = UntrustedSupplierMessage['action'];

export const SupplierDurableReceiptSchema = z.strictObject({
  kind: z.literal('DURABLY_RECEIVED'), receiptId: IdSchema, identity: SupplierMessageIdentitySchema,
  messageDigest: HashSchema, receivedAt: InstantSchema, inboxRecord: VersionReferenceSchema,
});
export type SupplierDurableReceipt = z.infer<typeof SupplierDurableReceiptSchema>;
export const UntrustedSupplierDomainAcknowledgementSchema = z.strictObject({
  kind: z.literal('DOMAIN_ACKNOWLEDGEMENT'), acknowledgementId: IdSchema, identity: SupplierMessageIdentitySchema,
  messageDigest: HashSchema, recordedAt: InstantSchema, provenance: SupplierProvenanceSchema,
  outcome: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('DECLINED'), reason: z.enum(['STALE', 'SCOPE_MISMATCH', 'TERMS_REJECTED', 'CAPACITY_UNAVAILABLE', 'UNSUPPORTED']), evidenceRefs }),
    z.strictObject({ state: z.literal('PENDING'), originalIdentity: SupplierOriginalEffectIdentitySchema }),
    z.strictObject({ state: z.literal('TERMS_ACCEPTED'), terms: VersionReferenceSchema, payee: PayeeBindingSchema, evidenceRefs }),
    z.strictObject({ state: z.literal('CAPACITY_ACCEPTED'), observation: UntrustedSupplierAvailabilityObservationSchema }),
    z.strictObject({ state: z.literal('UPDATE_RECORDED'), record: VersionReferenceSchema, evidenceRefs }),
  ]),
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  const nested = value.outcome.state === 'PENDING' ? value.outcome.originalIdentity : value.outcome.state === 'CAPACITY_ACCEPTED' ? value.outcome.observation : null;
  if (nested && (!supplierScopesMatch(nested.scope, value.identity.scope) || !supplierProvenanceMatches(nested.provenance, value.provenance))) invalid('Acknowledgement must preserve message scope and provenance.');
  if (value.outcome.state === 'CAPACITY_ACCEPTED' && value.outcome.observation.claimedAssurance === 'OBSERVED_AVAILABILITY') invalid('Availability alone cannot acknowledge capacity acceptance.');
  if (value.outcome.state === 'TERMS_ACCEPTED' && value.outcome.payee.environment !== value.identity.scope.environment) invalid('Payee acknowledgement crosses environment.');
});
export type UntrustedSupplierDomainAcknowledgement = z.infer<typeof UntrustedSupplierDomainAcknowledgementSchema>;
export const SupplierStoredDeliverySchema = z.strictObject({
  receipt: SupplierDurableReceiptSchema, acknowledgement: UntrustedSupplierDomainAcknowledgementSchema.nullable(),
});
export type SupplierStoredDelivery = z.infer<typeof SupplierStoredDeliverySchema>;

// Equality helpers only. These never authenticate the supplied scope or provenance.
export function supplierScopesMatch(a: SupplierScope, b: SupplierScope): boolean {
  return a.environment === b.environment && a.buyerOrganizationId === b.buyerOrganizationId &&
    a.supplierOrganizationId === b.supplierOrganizationId && a.supplierRelationshipId === b.supplierRelationshipId;
}
export function supplierProvenanceMatches(a: SupplierProvenance, b: SupplierProvenance): boolean {
  return a.synthetic && b.synthetic ? a.runId === b.runId && sameReference(a.fixture, b.fixture) :
    !a.synthetic && !b.synthetic && sameReference(a.connector, b.connector);
}
