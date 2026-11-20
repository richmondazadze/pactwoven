import { describe, expect, it } from 'vitest';
import {
  SupplierRelationshipApprovalSchema, SupplierRelationshipCommandSchema, SupplierRelationshipHeadSchema,
  SupplierRelationshipMutationSchema, SupplierRelationshipProjectionSchema, SupplierRelationshipProposalSchema,
  SupplierRelationshipReceiptSchema, SupplierRelationshipSnapshotSchema, SupplierRelationshipTermsSchema,
} from './supplier-relationships';

const at = '2026-11-15T10:00:00Z';
const expiry = '2026-11-15T11:00:00Z';
const scope = { environment: 'simulation', buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier', supplierRelationshipId: 'relationship' };
const terms = () => ({ buyerSiteIds: ['site_one'], serviceCategoryIds: ['logistics'], expiresAt: expiry });
const administrator = (party = 'buyer') => ({ actorId: `${party}_admin`, organizationId: party, membershipId: `${party}_membership`, membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0 });
const reference = () => ({ id: 'relationship', version: 1, hash: 'a'.repeat(64) });
const proposal = () => ({ schemaVersion: 1, scope, version: 1, previousVersionHash: null, terms: terms(), createdBy: administrator(), createdAt: at });
const approval = (party = 'buyer') => ({ ...administrator(party), party, proposal: reference(), approvedAt: at, expiresAt: expiry });
const snapshot = () => ({ schemaVersion: 1, revision: 3, proposal: proposal(), proposalHash: reference().hash, status: 'ACTIVE',
  approvals: { buyer: approval(), supplier: approval('supplier') }, changedBy: administrator('supplier'), updatedAt: at });
const command = () => ({ scope, expectedVersion: 0, mandateVersion: null, authorityEpoch: 0, targetProposal: null, payload: { action: 'create', terms: terms() } });
const head = () => ({ scope, revision: 3, proposal: reference(), status: 'ACTIVE' });
const projection = () => ({ kind: 'RELATIONSHIP_STATUS_ONLY', ...head(), expiresAt: expiry, viewerParty: 'buyer', current: true,
  approvalsRecorded: { buyer: true, supplier: true }, relationshipGate: 'SATISFIED', gateReason: null,
  authentication: 'NOT_ESTABLISHED', businessVerification: 'NOT_ESTABLISHED', payeeVerification: 'NOT_ESTABLISHED',
  bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false });

describe('supplier relationship scope and proposal contracts', () => {
  it('requires distinct organizations, explicit bounded scope and expiry', () => {
    expect(SupplierRelationshipProposalSchema.parse(proposal())).toEqual(proposal());
    expect(SupplierRelationshipProposalSchema.safeParse({ ...proposal(), scope: { ...scope, supplierOrganizationId: 'buyer' } }).success).toBe(false);
    for (const changed of [
      { ...terms(), buyerSiteIds: [] }, { ...terms(), buyerSiteIds: ['site_one', 'site_one'] },
      { ...terms(), serviceCategoryIds: [] }, { ...terms(), serviceCategoryIds: Array(101).fill('category') },
      { ...terms(), payee: 'recipient' },
    ]) expect(SupplierRelationshipTermsSchema.safeParse(changed).success).toBe(false);
    expect(SupplierRelationshipProposalSchema.safeParse({ ...proposal(), terms: { ...terms(), expiresAt: at } }).success).toBe(false);
  });
  it('requires a predecessor for every later proposal and a participant author', () => {
    for (const changed of [
      { ...proposal(), version: 2 }, { ...proposal(), previousVersionHash: 'b'.repeat(64) },
      { ...proposal(), createdBy: administrator('competitor') }, { ...proposal(), version: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect(SupplierRelationshipProposalSchema.safeParse(changed).success).toBe(false);
    expect(SupplierRelationshipProposalSchema.safeParse({ ...proposal(), version: 2, previousVersionHash: 'b'.repeat(64) }).success).toBe(true);
  });
  it('does not accept public authentication or commercial verification flags', () => {
    for (const extra of [{ verified: true }, { authenticated: true }, { paymentAuthority: true }, { credential: 'private' }]) {
      expect(SupplierRelationshipProposalSchema.safeParse({ ...proposal(), ...extra }).success).toBe(false);
      expect(SupplierRelationshipCommandSchema.safeParse({ ...command(), ...extra }).success).toBe(false);
    }
  });
});

describe('exact two-party approval contracts', () => {
  it('allows only both exact proposal approvals to be recorded ACTIVE', () => {
    expect(SupplierRelationshipSnapshotSchema.parse(snapshot())).toEqual(snapshot());
    for (const changed of [
      { ...snapshot(), approvals: { buyer: approval(), supplier: null } },
      { ...snapshot(), approvals: { buyer: approval(), supplier: approval() } },
      { ...snapshot(), approvals: { buyer: approval(), supplier: { ...approval('supplier'), proposal: { ...reference(), version: 2 } } } },
      { ...snapshot(), approvals: { buyer: approval(), supplier: { ...approval('supplier'), proposal: { ...reference(), hash: 'b'.repeat(64) } } } },
      { ...snapshot(), approvals: { buyer: approval(), supplier: { ...approval('supplier'), organizationId: 'competitor' } } },
    ]) expect(SupplierRelationshipSnapshotSchema.safeParse(changed).success).toBe(false);
  });
  it('cannot retain approvals after suspension/revocation or hide a fully approved ACTIVE state', () => {
    for (const status of ['PROPOSED', 'SUSPENDED', 'REVOKED']) expect(SupplierRelationshipSnapshotSchema.safeParse({ ...snapshot(), status }).success).toBe(false);
    for (const status of ['SUSPENDED', 'REVOKED']) expect(SupplierRelationshipSnapshotSchema.safeParse({ ...snapshot(), status, approvals: { buyer: null, supplier: null } }).success).toBe(true);
  });
  it('rejects impossible approval intervals and aggregate/proposal version combinations', () => {
    expect(SupplierRelationshipApprovalSchema.safeParse({ ...approval(), expiresAt: at }).success).toBe(false);
    expect(SupplierRelationshipSnapshotSchema.safeParse({ ...snapshot(), approvals: { buyer: { ...approval(), expiresAt: '2026-11-16T10:00:00Z' }, supplier: approval('supplier') } }).success).toBe(false);
    expect(SupplierRelationshipSnapshotSchema.safeParse({ ...snapshot(), updatedAt: '2026-11-15T09:59:59Z' }).success).toBe(false);
    expect(SupplierRelationshipHeadSchema.safeParse({ ...head(), revision: 1, proposal: { ...reference(), version: 2 } }).success).toBe(false);
  });
});

describe('relationship command, receipt and minimal projection contracts', () => {
  it('fences creation and later mutations by both aggregate and proposal', () => {
    expect(SupplierRelationshipMutationSchema.safeParse({ idempotencyKey: 'create_relationship_1', command: command() }).success).toBe(true);
    for (const changed of [
      { ...command(), expectedVersion: 1 }, { ...command(), targetProposal: reference() },
      { ...command(), payload: { action: 'approve', expiresAt: expiry } },
      { ...command(), expectedVersion: '0' }, { ...command(), mandateVersion: 1 },
      { ...command(), expectedVersion: 3, targetProposal: { ...reference(), id: 'other' }, payload: { action: 'revoke' } },
    ]) expect(SupplierRelationshipCommandSchema.safeParse(changed).success).toBe(false);
    expect(SupplierRelationshipMutationSchema.safeParse({ idempotencyKey: 'short', command: command() }).success).toBe(false);
  });
  it('binds receipt result to the same environment, parties and relationship', () => {
    const receipt = { identity: { scope, actorId: 'buyer_admin', organizationId: 'buyer', idempotencyKey: 'create_relationship_1' }, commandDigest: 'b'.repeat(64), result: head(), recordedAt: at };
    expect(SupplierRelationshipReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(SupplierRelationshipReceiptSchema.safeParse({ ...receipt, result: { ...head(), scope: { ...scope, environment: 'production' } } }).success).toBe(false);
  });
  it('cannot smuggle private content or effect authority into the status projection', () => {
    expect(SupplierRelationshipProjectionSchema.safeParse(projection()).success).toBe(true);
    for (const extra of [{ contacts: [] }, { buyerSiteIds: [] }, { budgets: [] }, { staff: [] }, { payee: 'new' }, { paymentAuthority: true }, { bookingAuthority: true }, { authentication: 'VERIFIED' }]) {
      expect(SupplierRelationshipProjectionSchema.safeParse({ ...projection(), ...extra }).success).toBe(false);
    }
  });
});
