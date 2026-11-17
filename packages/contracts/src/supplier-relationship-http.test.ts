import { describe, expect, it } from 'vitest';
import {
  SupplierRelationshipHttpRequestSchema, SupplierRelationshipHttpResponseSchema, SupplierScopePolicyHttpProjectionSchema,
  SupplierRelationshipCommandHttpSchema, SupplierRelationshipRecoveryHttpSchema,
  supplierRelationshipHttpRoutes, supplierRelationshipHttpBodyLimits,
} from './supplier-relationship-http';

const H = 'a'.repeat(64), at = '2026-11-16T12:00:00.000Z', later = '2026-11-16T12:01:00.000Z';
const pair = { environment: 'simulation', buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier' };
const scope = { ...pair, supplierRelationshipId: 'relationship' };
const command = () => ({ scope, expectedVersion: 0, mandateVersion: null, authorityEpoch: 0, targetProposal: null,
  payload: { action: 'create', terms: { buyerSiteIds: ['site'], serviceCategoryIds: ['delivery'], expiresAt: later } } });
const mutation = () => ({ idempotencyKey: 'supplier_original_key', command: command() });
const head = () => ({ scope, revision: 1, proposal: { id: 'relationship', version: 1, hash: H }, status: 'PROPOSED' });
const receipt = () => ({ identity: { scope, organizationId: 'buyer', actorId: 'actor', idempotencyKey: 'supplier_original_key' },
  commandDigest: H, result: head(), recordedAt: at });
const policy = () => ({ reference: { pair, version: 1, hash: H }, predecessor: null, status: 'ACTIVE', buyerSiteIds: ['site'],
  categories: [{ id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods.', definitionHash: H }], issuedAt: at, validFrom: at, expiresAt: later });

describe('supplier HTTP contracts', () => {
  it('defines five exact routes with bounded body sizes', () => {
    expect(Object.values(supplierRelationshipHttpRoutes)).toEqual([
      '/v1/supplier-relationships/status', '/v1/supplier-relationships/commands', '/v1/supplier-relationships/recover',
      '/v1/supplier-scope-policies/read', '/v1/supplier-scope-policies/commands',
    ]);
    expect(supplierRelationshipHttpBodyLimits['policy-command']).toBe(1024 * 1024);
    expect(supplierRelationshipHttpBodyLimits['relationship-command']).toBe(64 * 1024);
    expect(Object.isFrozen(supplierRelationshipHttpRoutes)).toBe(true);
  });

  it.each(['identity', 'actor', 'binding', 'issuer', 'purpose', 'evidence', 'approvers', 'handle'])('rejects current private %s input at the body and canonical request boundary', field => {
    expect(SupplierRelationshipCommandHttpSchema.safeParse({ ...command(), [field]: {} }).success).toBe(false);
    expect(SupplierRelationshipHttpRequestSchema.safeParse({ kind: 'relationship-command', mutation: mutation(), [field]: {} }).success).toBe(false);
  });

  it('requires the exact command without a duplicate key or route identity in its body', () => {
    expect(SupplierRelationshipCommandHttpSchema.safeParse(command()).success).toBe(true);
    for (const value of [{ ...command(), idempotencyKey: 'supplier_original_key' }, { command: command() },
      { ...command(), kind: 'relationship-command' }, { ...command(), route: '/v1/supplier-relationships/commands' }]) {
      expect(SupplierRelationshipCommandHttpSchema.safeParse(value).success).toBe(false);
    }
  });

  it('retains only a historical recovery locator and copies its exact original key', () => {
    const query = { identity: receipt().identity, commandDigest: H, action: 'create' };
    const parsed = SupplierRelationshipRecoveryHttpSchema.parse(query);
    expect(parsed).toEqual(query); expect(parsed.identity).not.toBe(query.identity);
    expect(SupplierRelationshipRecoveryHttpSchema.safeParse({ ...query, currentActor: query.identity.actorId }).success).toBe(false);
    expect(SupplierRelationshipHttpRequestSchema.safeParse({ kind: 'relationship-observation-plan', query: { scope } }).success).toBe(false);
  });

  it('allowlists policy terms while refusing private issuer and provider data', () => {
    expect(SupplierScopePolicyHttpProjectionSchema.parse(policy())).toEqual(policy());
    for (const field of ['issuer', 'organizations', 'factorEvidence', 'subject', 'externalMembershipId', 'sessionId', 'commandIdentity']) {
      expect(SupplierScopePolicyHttpProjectionSchema.safeParse({ ...policy(), [field]: {} }).success).toBe(false);
    }
    const extraCategory = policy(); extraCategory.categories = [{ ...extraCategory.categories[0]!, privateContact: 'not public' } as typeof extraCategory.categories[number]];
    expect(SupplierScopePolicyHttpProjectionSchema.safeParse(extraCategory).success).toBe(false);
  });

  it('keeps finite policy validity, revocation and predecessor lineage consistent', () => {
    expect(SupplierScopePolicyHttpProjectionSchema.safeParse({ ...policy(), expiresAt: at }).success).toBe(false);
    expect(SupplierScopePolicyHttpProjectionSchema.safeParse({ ...policy(), reference: { pair, version: 2, hash: H }, predecessor: null }).success).toBe(false);
    const revoked = { ...policy(), reference: { pair, version: 2, hash: H }, predecessor: policy().reference, status: 'REVOKED', expiresAt: at };
    expect(SupplierScopePolicyHttpProjectionSchema.safeParse(revoked).success).toBe(true);
    expect(SupplierScopePolicyHttpProjectionSchema.safeParse({ ...revoked, expiresAt: later }).success).toBe(false);
    expect(SupplierScopePolicyHttpProjectionSchema.safeParse({ ...policy(), buyerSiteIds: ['site', 'site'] }).success).toBe(false);
  });

  it('preserves original replay receipts separately from the newer observed head', () => {
    const original = receipt(), currentHead = { ...head(), revision: 3, status: 'SUSPENDED' };
    const result = { kind: 'relationship-command', outcome: 'EXACT_REPLAY', receipt: original, currentHead };
    expect(SupplierRelationshipHttpResponseSchema.parse(result)).toEqual(result);
    expect(SupplierRelationshipHttpResponseSchema.safeParse({ ...result, outcome: 'APPENDED' }).success).toBe(false);
    expect(SupplierRelationshipHttpResponseSchema.safeParse({ ...result, currentHead: { ...currentHead, scope: { ...scope, supplierOrganizationId: 'foreign' } } }).success).toBe(false);
    expect(SupplierRelationshipHttpResponseSchema.safeParse({ ...result, currentHead: { ...currentHead, proposal: { ...currentHead.proposal, hash: 'f'.repeat(64) } } }).success).toBe(false);
  });

  it('rejects private result wrappers, plans, policy pins and handles', () => {
    const result = { kind: 'relationship-command', outcome: 'APPENDED', receipt: receipt(), currentHead: head() };
    for (const field of ['binding', 'record', 'observation', 'source', 'plan', 'reference']) {
      expect(SupplierRelationshipHttpResponseSchema.safeParse({ ...result, [field]: {} }).success).toBe(false);
    }
    expect(SupplierRelationshipHttpResponseSchema.safeParse({ ...result, receipt: { receipt: receipt(), policy: policy().reference } }).success).toBe(false);
    expect(SupplierRelationshipHttpResponseSchema.safeParse({ kind: 'relationship-observation-plan', plan: { scope, head: null, approvers: [] } }).success).toBe(false);
  });
});
