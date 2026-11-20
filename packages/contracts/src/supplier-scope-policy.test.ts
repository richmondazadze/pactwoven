import { describe, expect, it } from 'vitest';
import {
  SUPPLIER_SCOPE_POLICY_MAX_VALIDITY_MS, SupplierScopeCategoryInputSchema, SupplierScopePolicyMutationSchema,
  SupplierScopePolicySnapshotSchema, SupplierScopePolicyReceiptSchema, SupplierRelationshipPolicyBindingSchema,
} from './supplier-scope-policy';
import { SupplierRelationshipProposalSchema } from './supplier-relationships';

const hash = 'a'.repeat(64), now = '2026-11-16T10:00:00.000Z';
const pair = { environment: 'simulation', buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier' };
const category = { id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods between selected buyer sites.' };
const terms = { buyerSiteIds: ['site_one'], categories: [category], requestedValidityMs: 1 };
const request = () => ({ idempotencyKey: 'scope_issue_request_001', command: {
  pair, expectedVersion: 0, predecessor: null, buyerOrganizationVersion: 1, authorityEpoch: 0,
  payload: { action: 'issue', terms },
} });
const snapshot = () => ({
  policy: { schemaVersion: 1, pair, version: 1, predecessor: null, status: 'ACTIVE',
    buyerSiteIds: ['site_one'], categories: [{ ...category, definitionHash: hash }],
    issuedAt: now, validFrom: now, expiresAt: '2026-11-16T10:00:00.001Z',
    organizations: { buyer: { externalOrganizationId: 'org_buyer', version: 1, authorityEpoch: 0 },
      supplier: { externalOrganizationId: 'org_supplier', version: 1, authorityEpoch: 0 } },
    issuer: { actorId: 'owner', organizationId: 'buyer', membershipId: 'member', membershipVersion: 1,
      organizationVersion: 1, organizationEpoch: 0, subject: 'user_owner', externalOrganizationId: 'org_buyer',
      externalMembershipId: 'external_member', sessionId: 'session_owner', factorEvidence: { id: 'evidence', version: 1, hash } },
    commandIdentity: { pair, organizationId: 'buyer', actorId: 'owner', idempotencyKey: 'scope_issue_request_001' }, commandDigest: hash },
  policyHash: hash,
});

describe('bounded private supplier scope-policy contracts', () => {
  it('accepts one millisecond through thirty days without a one-day minimum', () => {
    for (const requestedValidityMs of [1, 999, 60_000, SUPPLIER_SCOPE_POLICY_MAX_VALIDITY_MS]) {
      expect(SupplierScopePolicyMutationSchema.safeParse({ ...request(), command: { ...request().command,
        payload: { action: 'issue', terms: { ...terms, requestedValidityMs } } } }).success).toBe(true);
    }
    for (const requestedValidityMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, SUPPLIER_SCOPE_POLICY_MAX_VALIDITY_MS + 1]) {
      expect(SupplierScopePolicyMutationSchema.safeParse({ ...request(), command: { ...request().command,
        payload: { action: 'issue', terms: { ...terms, requestedValidityMs } } } }).success).toBe(false);
    }
  });
  it('requires exact predecessor and ordered-pair identity for replace and revoke', () => {
    const predecessor = { pair, version: 1, hash };
    for (const action of ['replace', 'revoke']) {
      const payload = action === 'replace' ? { action, terms } : { action };
      const command = { ...request().command, expectedVersion: 1, predecessor, payload };
      expect(SupplierScopePolicyMutationSchema.safeParse({ ...request(), command }).success).toBe(true);
      for (const change of [{ expectedVersion: 0 }, { predecessor: null }, { predecessor: { ...predecessor, version: 2 } },
        { predecessor: { ...predecessor, pair: { ...pair, supplierOrganizationId: 'other' } } }]) {
        expect(SupplierScopePolicyMutationSchema.safeParse({ ...request(), command: { ...command, ...change } }).success).toBe(false);
      }
    }
    expect(SupplierScopePolicyMutationSchema.safeParse({ ...request(), command: { ...request().command, predecessor } }).success).toBe(false);
    expect(SupplierScopePolicyMutationSchema.safeParse({ ...request(), command: { ...request().command, pair: { ...pair, supplierOrganizationId: 'buyer' } } }).success).toBe(false);
  });
  it('bounds and deduplicates sites, categories and normalized meanings', () => {
    const hundred = Array.from({ length: 100 }, (_, index) => 'site_' + index);
    expect(SupplierScopePolicyMutationSchema.safeParse({ ...request(), command: { ...request().command,
      payload: { action: 'issue', terms: { ...terms, buyerSiteIds: hundred } } } }).success).toBe(true);
    for (const change of [{ buyerSiteIds: [] }, { buyerSiteIds: [...hundred, 'extra'] }, { buyerSiteIds: ['same', 'same'] },
      { categories: [] }, { categories: [category, category] }, { categories: Array.from({ length: 101 }, (_, index) => ({ ...category, id: 'category_' + index })) }]) {
      expect(SupplierScopePolicyMutationSchema.safeParse({ ...request(), command: { ...request().command,
        payload: { action: 'issue', terms: { ...terms, ...change } } } }).success).toBe(false);
    }
    expect(SupplierScopeCategoryInputSchema.parse({ ...category, label: '  Cafe\u0301  ', definition: '  Meaning\nretains interior whitespace.  ' }))
      .toEqual({ id: category.id, label: 'Café', definition: 'Meaning\nretains interior whitespace.' });
    for (const change of [{ label: '' }, { label: ' '.repeat(20) }, { label: 'x'.repeat(121) }, { definition: '' }, { definition: 'x'.repeat(2001) }]) {
      expect(SupplierScopeCategoryInputSchema.safeParse({ ...category, ...change }).success).toBe(false);
    }
  });
  it('rejects client clocks, hashes, roles, grants and authority assertions in commands', () => {
    for (const extra of [{ issuedAt: now }, { validFrom: now }, { expiresAt: now }, { role: 'owner' }, { factorEvidence: {} }, { verified: true }, { grants: [] }]) {
      expect(SupplierScopePolicyMutationSchema.safeParse({ ...request(), command: { ...request().command, ...extra } }).success).toBe(false);
    }
    expect(SupplierScopePolicyMutationSchema.safeParse({ ...request(), command: { ...request().command,
      payload: { action: 'issue', terms: { ...terms, categories: [{ ...category, definitionHash: hash }] } } } }).success).toBe(false);
  });
  it('retains exact immutable version, issuer and finite interval structure', () => {
    const state = snapshot();
    expect(SupplierScopePolicySnapshotSchema.safeParse(state).success).toBe(true);
    for (const change of [{ version: 2 }, { validFrom: '2026-11-16T10:00:01Z' }, { expiresAt: null },
      { expiresAt: now }, { expiresAt: '2026-12-17T10:00:00Z' }, { status: 'REVOKED' },
      { categories: [{ ...state.policy.categories[0], label: ' Delivery ' }] },
      { categories: [{ ...state.policy.categories[0], label: 'Cafe\u0301' }] },
      { issuer: { ...state.policy.issuer, membershipVersion: 0 } },
      { issuer: { ...state.policy.issuer, organizationId: 'supplier' } },
      { issuer: { ...state.policy.issuer, organizationVersion: 2 } }]) {
      expect(SupplierScopePolicySnapshotSchema.safeParse({ ...state, policy: { ...state.policy, ...change } }).success).toBe(false);
    }
    const revoked = { ...state.policy, version: 2, predecessor: { pair, version: 1, hash }, status: 'REVOKED', expiresAt: now };
    expect(SupplierScopePolicySnapshotSchema.safeParse({ ...state, policy: revoked }).success).toBe(true);
  });
  it('reciprocally binds receipt identity, digest, result and recorded time', () => {
    const result = snapshot();
    const receipt = { identity: result.policy.commandIdentity, commandDigest: hash, result, recordedAt: now };
    expect(SupplierScopePolicyReceiptSchema.safeParse(receipt).success).toBe(true);
    for (const change of [{ commandDigest: 'b'.repeat(64) }, { recordedAt: '2026-11-16T10:00:01Z' },
      { identity: { ...receipt.identity, actorId: 'other' } }, { identity: { ...receipt.identity, idempotencyKey: 'another_original_key' } },
      { identity: { ...receipt.identity, pair: { ...pair, supplierOrganizationId: 'other' } } }]) {
      expect(SupplierScopePolicyReceiptSchema.safeParse({ ...receipt, ...change }).success).toBe(false);
    }
  });
  it('keeps the policy pin private and bound to the exact producing receipt', () => {
    const scope = { ...pair, supplierRelationshipId: 'relationship' };
    const proposal = { schemaVersion: 1, scope, version: 1, previousVersionHash: null,
      terms: { buyerSiteIds: ['site_one'], serviceCategoryIds: ['delivery'], expiresAt: '2026-11-16T11:00:00Z' },
      createdBy: { actorId: 'owner', organizationId: 'buyer', membershipId: 'member', membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0 },
      createdAt: now };
    expect(SupplierRelationshipProposalSchema.safeParse(proposal).success).toBe(true);
    expect(SupplierRelationshipProposalSchema.safeParse({ ...proposal, scopePolicy: { pair, version: 1, hash } }).success).toBe(false);
    const proposalRef = { id: 'relationship', version: 1, hash };
    const producingReceipt = { identity: { scope, actorId: 'owner', organizationId: 'buyer', idempotencyKey: 'relationship_create_001' },
      commandDigest: hash, result: { scope, revision: 1, proposal: proposalRef, status: 'PROPOSED' }, recordedAt: now };
    const binding = { schemaVersion: 1, scope, proposal: proposalRef, policy: { pair, version: 1, hash }, producingReceipt };
    expect(SupplierRelationshipPolicyBindingSchema.safeParse(binding).success).toBe(true);
    for (const change of [{ policy: { pair: { ...pair, supplierOrganizationId: 'other' }, version: 1, hash } },
      { proposal: { ...proposalRef, version: 2 } }, { producingReceipt: { ...producingReceipt, result: { ...producingReceipt.result, status: 'ACTIVE' } } }]) {
      expect(SupplierRelationshipPolicyBindingSchema.safeParse({ ...binding, ...change }).success).toBe(false);
    }
  });
});
