import {
  InstantSchema, SupplierAvailabilityQuerySchema, SupplierCapabilitySchema, SupplierMessageIdentitySchema,
  SupplierScopeSchema, SupplierStoredDeliverySchema, UntrustedSupplierAvailabilityObservationSchema,
  UntrustedSupplierCapabilityManifestSchema, UntrustedSupplierEffectResultSchema, UntrustedSupplierMessageSchema,
  supplierProvenanceMatches, supplierScopesMatch,
  type SupplierCapability, type SupplierMessageIdentity, type SupplierScope,
  type SupplierStoredDelivery, type UntrustedSupplierMessage,
} from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';
import { immutable } from './financial-primitives.js';
import { DomainError } from './errors.js';

const MESSAGE_DIGEST_NAMESPACE = 'pactwoven/supplier-message/v1';
const milliseconds = (value: string) => Date.parse(InstantSchema.parse(value));
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const fail = (code: string, message: string): never => { throw new DomainError(code, 409, message); };

function identityOf(message: UntrustedSupplierMessage): SupplierMessageIdentity {
  return SupplierMessageIdentitySchema.parse({
    protocol: message.protocol, protocolVersion: message.protocolVersion, scope: message.scope,
    senderOrganizationId: message.senderOrganizationId, recipientOrganizationId: message.recipientOrganizationId,
    messageId: message.messageId,
  });
}
function digestSnapshot(message: UntrustedSupplierMessage): Promise<string> {
  return commandDigest({ namespace: MESSAGE_DIGEST_NAMESPACE, message });
}

/** A digest identifies parsed bytes. It neither authenticates the supplier nor grants authority. */
export async function supplierMessageDigest(input: unknown): Promise<string> {
  return digestSnapshot(immutable(UntrustedSupplierMessageSchema.parse(input)));
}

/** Snapshot all caller-owned objects before the first await; this is structural preparation only. */
export async function prepareUntrustedSupplierMessage(input: unknown, expectedScope: SupplierScope, now: string, previousInput: unknown = null) {
  const message = immutable(UntrustedSupplierMessageSchema.parse(input));
  const scope = immutable(SupplierScopeSchema.parse(expectedScope));
  const previous = previousInput === null ? null : immutable(UntrustedSupplierMessageSchema.parse(previousInput));
  const at = milliseconds(now);
  if (!supplierScopesMatch(message.scope, scope)) fail('SUPPLIER_SCOPE_MISMATCH', 'Message does not match the expected relationship scope.');
  if (milliseconds(message.issuedAt) > at) fail('SUPPLIER_MESSAGE_NOT_CURRENT', 'Message issue time is in the future.');
  if (milliseconds(message.expiresAt) <= at) fail('SUPPLIER_MESSAGE_EXPIRED', 'Message has expired.');
  if (previous === null) {
    if (message.version !== 1 || message.predecessor !== null) fail('SUPPLIER_PREDECESSOR_MISSING', 'A later message requires the exact prior message.');
  } else {
    if (!supplierScopesMatch(previous.scope, scope) || message.exchangeId !== previous.exchangeId ||
        !equal(message.relationship, previous.relationship) || !equal(message.references.responsibility, previous.references.responsibility) ||
        !supplierProvenanceMatches(message.provenance, previous.provenance) || message.version !== previous.version + 1 ||
        message.predecessor?.messageId !== previous.messageId || message.predecessor.version !== previous.version ||
        milliseconds(message.issuedAt) < milliseconds(previous.issuedAt)) {
      fail('SUPPLIER_VERSION_CONFLICT', 'Messages must form one immutable scoped exchange chain.');
    }
    for (const key of ['offer', 'commitment'] as const) {
      const prior = previous.references[key];
      const next = message.references[key];
      if (prior && (!next || next.id !== prior.id || next.version < prior.version || next.version > prior.version + 1 ||
          (next.version === prior.version && next.hash !== prior.hash))) fail('SUPPLIER_REFERENCE_CONFLICT', 'A bound commercial reference cannot be rewritten or dropped.');
      if (key === 'offer' && prior && next?.version === prior.version + 1 && 'terms' in message.payload) {
        if (message.payload.terms.id !== prior.id || message.payload.terms.version !== next.version ||
            message.payload.terms.previousVersionHash !== prior.hash ||
            (message.action === 'amendment_proposal' && !equal(message.payload.previousTerms, prior))) {
          fail('SUPPLIER_REFERENCE_CONFLICT', 'Advancing terms must continue the exact prior offer reference.');
        }
      }
    }
    if (message.predecessor?.hash !== await digestSnapshot(previous)) fail('SUPPLIER_PREDECESSOR_CONFLICT', 'Predecessor hash does not identify the prior message.');
  }
  if ('terms' in message.payload && message.references.offer?.hash !== await commandDigest(message.payload.terms)) {
    fail('SUPPLIER_TERMS_REFERENCE_CONFLICT', 'Proposed terms do not match the immutable offer digest.');
  }
  if (message.action === 'offer_acceptance' && !equal(message.payload.payee, message.payload.terms.payee)) {
    fail('SUPPLIER_PAYEE_REFERENCE_CONFLICT', 'Acceptance must bind the exact payee in the referenced terms.');
  }
  return immutable({ validation: 'STRUCTURAL_ONLY' as const, message, digest: await digestSnapshot(message) });
}

/** Durable inbox identity and result replay only; delivery is not domain acceptance. */
export async function inspectSupplierMessageDelivery(input: unknown, storedInput: SupplierStoredDelivery | null) {
  const message = immutable(UntrustedSupplierMessageSchema.parse(input));
  const stored = storedInput === null ? null : immutable(SupplierStoredDeliverySchema.parse(storedInput));
  const identity = immutable(identityOf(message));
  if (stored && !equal(stored.receipt.identity, identity)) fail('SUPPLIER_DELIVERY_SCOPE_MISMATCH', 'The stored receipt belongs to a different message identity.');
  if (stored?.acknowledgement && (!equal(stored.acknowledgement.identity, identity) ||
      stored.acknowledgement.messageDigest !== stored.receipt.messageDigest)) {
    fail('SUPPLIER_DELIVERY_RECORD_CONFLICT', 'Receipt and domain acknowledgement must retain the same message and provenance.');
  }
  const digest = await digestSnapshot(message);
  if (stored === null) return immutable({ kind: 'NEW_UNTRUSTED_MESSAGE' as const, identity, digest });
  if (stored.receipt.messageDigest !== digest) return immutable({ kind: 'MESSAGE_ID_CONFLICT' as const, identity, digest });
  if (stored.acknowledgement && !supplierProvenanceMatches(stored.acknowledgement.provenance, message.provenance)) {
    fail('SUPPLIER_DELIVERY_RECORD_CONFLICT', 'Domain acknowledgement must preserve original message provenance.');
  }
  return immutable({ kind: 'EXACT_DUPLICATE' as const, identity, digest, original: stored });
}

/** No observation, including a reservation claim, proves usable or exclusive capacity here. */
export function assessUntrustedSupplierAvailability(queryInput: unknown, observationInput: unknown, now: string, maximumAgeMs: number) {
  const query = immutable(SupplierAvailabilityQuerySchema.parse(queryInput));
  const observation = observationInput === null ? null : immutable(UntrustedSupplierAvailabilityObservationSchema.parse(observationInput));
  const at = milliseconds(now);
  if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 0 || maximumAgeMs > 31_536_000_000) {
    throw new DomainError('SUPPLIER_FRESHNESS_INVALID', 422, 'A bounded maximum observation age is required.');
  }
  const base = { observation, exclusivity: 'NOT_ESTABLISHED' as const, usableCapacity: 'NOT_ESTABLISHED' as const, supplierPerformance: 'UNVERIFIED' as const };
  let reason: 'MISSING' | 'SCOPE_OR_RESOURCE_MISMATCH' | 'INTERVAL_MISMATCH' | 'UNIT_MISMATCH' | 'NOT_CURRENT' | 'STALE' | null = null;
  if (observation === null) reason = 'MISSING';
  else if (!supplierScopesMatch(query.scope, observation.scope) || !equal(query.resource, observation.resource)) reason = 'SCOPE_OR_RESOURCE_MISMATCH';
  else if (query.window.timeZone !== observation.window.timeZone || milliseconds(query.window.startsAt) < milliseconds(observation.window.startsAt) ||
      milliseconds(query.window.endsAt) > milliseconds(observation.window.endsAt)) reason = 'INTERVAL_MISMATCH';
  else if (query.quantity.quantityScale !== observation.quantity.quantityScale || query.quantity.unit !== observation.quantity.unit) reason = 'UNIT_MISMATCH';
  else if (milliseconds(observation.observedAt) > at) reason = 'NOT_CURRENT';
  else if (milliseconds(observation.expiresAt) <= at || at - milliseconds(observation.observedAt) > maximumAgeMs) reason = 'STALE';
  if (reason !== null || observation === null) return immutable({ ...base, state: 'UNAVAILABLE' as const, reason, quantity: null, reportedQuantitySufficient: null });
  return immutable({ ...base, state: 'OBSERVATION_PRESENT' as const, reason: null, quantity: observation.quantity,
    reportedQuantitySufficient: BigInt(observation.quantity.quantityBaseUnits) >= BigInt(query.quantity.quantityBaseUnits) });
}

/** Declarations can guide qualification; they are never proof of working adapter support. */
export function inspectSupplierCapability(manifestInput: unknown, capabilityInput: SupplierCapability, expectedScope: SupplierScope, now: string) {
  const capability = SupplierCapabilitySchema.parse(capabilityInput);
  const scope = SupplierScopeSchema.parse(expectedScope);
  const at = milliseconds(now);
  const parsed = UntrustedSupplierCapabilityManifestSchema.safeParse(manifestInput);
  if (!parsed.success) return immutable({ state: 'UNAVAILABLE' as const, reason: 'MISSING_OR_INVALID_MANIFEST' as const, declaration: null, manifest: null });
  const manifest = immutable(parsed.data);
  const declaration = manifest.capabilities[capability];
  if (!supplierScopesMatch(scope, manifest.scope)) return immutable({ state: 'UNAVAILABLE' as const, reason: 'SCOPE_MISMATCH' as const, declaration: null, manifest: null });
  if (milliseconds(manifest.observedAt) > at || milliseconds(manifest.expiresAt) <= at) return immutable({ state: 'UNAVAILABLE' as const, reason: 'NOT_CURRENT' as const, declaration: null, manifest: null });
  if (declaration.mode === 'UNSUPPORTED') return immutable({ state: 'UNAVAILABLE' as const, reason: 'UNSUPPORTED' as const, declaration, manifest });
  return immutable({ state: 'DECLARED_ONLY' as const, reason: null, declaration, manifest });
}

/** Preserve original lookup identity and any learned external reference across observations. */
export function snapshotSupplierEffectUpdate(previousInput: unknown, nextInput: unknown) {
  const previous = immutable(UntrustedSupplierEffectResultSchema.parse(previousInput));
  const next = immutable(UntrustedSupplierEffectResultSchema.parse(nextInput));
  if (!equal(previous.identity, next.identity)) fail('SUPPLIER_EFFECT_IDENTITY_CONFLICT', 'An uncertain effect must retain its entire original lookup identity and provenance.');
  if (previous.externalReference !== null && !equal(previous.externalReference, next.externalReference)) fail('SUPPLIER_EXTERNAL_REFERENCE_CONFLICT', 'A learned external reference cannot be dropped or replaced.');
  if (milliseconds(next.observedAt) < milliseconds(previous.observedAt)) fail('SUPPLIER_EFFECT_OBSERVATION_STALE', 'Effect observations cannot move backward.');
  return next;
}

/** Describe recovery prerequisites only. No branch authorizes retry, replacement or release. */
export function planSupplierEffectRecovery(resultInput: unknown, manifestInput: unknown, now: string) {
  const result = immutable(UntrustedSupplierEffectResultSchema.parse(resultInput));
  const at = milliseconds(now);
  const base = {
    originalIdentity: result.identity, externalReference: result.externalReference,
    blindRetryAllowed: false as const, releaseCapacityOrExposureAllowed: false as const,
    replacementEffectAllowed: false as const, authentication: 'NOT_ESTABLISHED' as const,
  };
  if (milliseconds(result.observedAt) > at) return immutable({ ...base, action: 'REVIEW_FUTURE_OBSERVATION' as const });
  if (result.state === 'succeeded') return immutable({ ...base, action: 'VERIFY_REPORTED_SUCCESS' as const });
  if (result.state === 'failed' && result.effectConfirmedAbsent) return immutable({ ...base, action: 'VERIFY_ABSENCE_AND_REVALIDATE_AUTHORITY' as const,
    absenceEvidenceRefs: result.absenceEvidenceRefs });
  const inspected = inspectSupplierCapability(manifestInput, 'status_reconciliation', result.identity.scope, now);
  const manifest = inspected.manifest;
  const matchingProvenance = manifest !== null && supplierProvenanceMatches(manifest.provenance, result.identity.provenance);
  if (inspected.state === 'DECLARED_ONLY' && matchingProvenance && inspected.declaration.accountRef === result.identity.accountRef &&
      inspected.declaration.lookup !== 'NONE' && (inspected.declaration.lookup !== 'EXTERNAL_REFERENCE' || result.externalReference !== null)) {
    return immutable({ ...base, action: 'QUALIFY_AND_RECONCILE_ORIGINAL' as const,
      lookup: inspected.declaration.lookup, declaredMode: inspected.declaration.mode,
      noEarlierThan: 'nextCheckAt' in result ? result.nextCheckAt : null,
      prerequisite: 'PRIVATE_SERVER_CONTEXT_AND_QUALIFIED_LOOKUP' as const });
  }
  if (matchingProvenance && manifest.manualResolution.mode === 'SUPPORTED' && manifest.manualResolution.accountRef === result.identity.accountRef) {
    return immutable({ ...base, action: 'SUPPORTED_MANUAL_RESOLUTION_REQUIRED' as const, procedureRef: manifest.manualResolution.procedureRef,
      prerequisite: 'PRIVATE_SERVER_CONTEXT_AND_QUALIFIED_MANUAL_PROCEDURE' as const });
  }
  return immutable({ ...base, action: 'MANUAL_RESOLUTION_UNAVAILABLE' as const });
}
