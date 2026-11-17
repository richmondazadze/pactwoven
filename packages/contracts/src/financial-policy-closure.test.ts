import { describe, expect, it } from 'vitest';
import { commandDigest } from './canonical';
import { FinancialPolicyHttpReceiptSchema, FinancialPolicyHttpMutationResponseSchema } from './financial-policy-responses';
import { FinancialPolicyOriginalClosureRequestSchema, FinancialPolicyOriginalClosureReceiptSchema,
  FinancialPolicyOriginalStatusResponseSchema, FinancialPolicyOriginalClosureResponseSchema,
  financialPolicyOriginalClosureReceiptHash, financialPolicyOriginalClosureRoute } from './financial-policy-closure';

const hash = 'a'.repeat(64);
const locator = { responsibilityId: null, kind: 'save_document', key: 'original_key_12345', targetId: 'document_a', publicRequestHash: hash };
const expected = { environment: 'development', organizationId: 'org_a', actor: { actorId: 'actor_a', membershipVersion: 2 }, organizationEpoch: 3, draftScope: null };
const input = { schemaVersion: 1, purpose: 'financial_policy_original_close', reason: 'original_input_unavailable', locator, expected };
const receipt = { schemaVersion: 1, id: '00000000-0000-4000-8000-000000000001', environment: 'development', organizationId: 'org_a',
  actor: expected.actor, locator, reason: input.reason, expected, closedAt: '2026-11-17T12:00:00.000Z', recordHash: hash, effectiveAuthority: false, financialState: null };
const envelope = { schemaVersion: 1, scope: { ...expected, draftScope: undefined, roles: ['owner'], siteIds: [], actionSiteIds: [] },
  observation: { observedAt: '2026-11-17T12:00:00.000Z', expiresAt: '2026-11-17T12:00:20.000Z' }, effectiveAuthority: false, financialState: null };
delete (envelope.scope as Record<string, unknown>).draftScope;
describe('distinct immutable original request closure contracts', () => {
  it('has exact original route and never becomes a policy receipt or mutation', () => {
    expect(FinancialPolicyOriginalClosureRequestSchema.safeParse(input).success).toBe(true);
    expect(FinancialPolicyOriginalClosureReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(financialPolicyOriginalClosureRoute(locator)).toBe('/v1/financial-governance/operations/original_key_12345/close');
    expect(FinancialPolicyHttpReceiptSchema.safeParse(receipt).success).toBe(false);
    expect(FinancialPolicyHttpMutationResponseSchema.safeParse({ ...envelope, status: 'closed', receipt }).success).toBe(false);
  });
  it.each(['environment', 'organizationId', 'actor', 'organizationEpoch', 'draftScope'])('requires reviewed %s pins', field => {
    const v = structuredClone(input); delete (v.expected as Record<string, unknown>)[field];
    expect(FinancialPolicyOriginalClosureRequestSchema.safeParse(v).success).toBe(false);
  });
  it.each(['withdraw_draft', 'propose_governance', 'accept_governance', 'reject_governance'])('does not close unsupported %s commands', kind => {
    expect(FinancialPolicyOriginalClosureRequestSchema.safeParse({ ...input, locator: { ...locator, kind } }).success).toBe(false);
  });
  it.each(['actor', 'evidence', 'sessionId', 'subject', 'financialState', 'force'])('rejects caller private/extra %s fields', field => {
    expect(FinancialPolicyOriginalClosureRequestSchema.safeParse({ ...input, [field]: 'untrusted' }).success).toBe(false);
  });
  it('requires non-null exact reviewed responsibility basis', () => {
    expect(FinancialPolicyOriginalClosureRequestSchema.safeParse({ ...input, locator: { ...locator, responsibilityId: 'responsibility_a' } }).success).toBe(false);
  });
  it('hashes the full historical expected pins in the exact namespace while excluding recordHash', async () => {
    const { recordHash: _, ...record } = receipt;
    const value = await commandDigest({ namespace: 'pactwoven:financial-policy-request-closure:v1', record });
    expect(await financialPolicyOriginalClosureReceiptHash(receipt)).toBe(value);
    expect(await financialPolicyOriginalClosureReceiptHash(record)).toBe(value);
    expect(await financialPolicyOriginalClosureReceiptHash({ ...receipt, recordHash: 'b'.repeat(64) })).toBe(value);
    expect(await financialPolicyOriginalClosureReceiptHash({ ...receipt, expected: { ...expected, organizationEpoch: 4 } })).not.toBe(value);
  });
  it('keeps three GET states and two POST states with disjoint receipt fields', () => {
    const closed = { ...envelope, ...locator, status: 'closed', receipt: null, closure: receipt };
    const absent = { ...envelope, ...locator, status: 'not_recorded', receipt: null, closure: null };
    expect(FinancialPolicyOriginalStatusResponseSchema.safeParse(closed).success).toBe(true);
    expect(FinancialPolicyOriginalClosureResponseSchema.safeParse(closed).success).toBe(true);
    expect(FinancialPolicyOriginalStatusResponseSchema.safeParse(absent).success).toBe(true);
    expect(FinancialPolicyOriginalClosureResponseSchema.safeParse(absent).success).toBe(false);
    expect(FinancialPolicyOriginalStatusResponseSchema.safeParse({ ...closed, receipt }).success).toBe(false);
    expect(FinancialPolicyOriginalStatusResponseSchema.safeParse({ ...closed, key: 'other_original_key' }).success).toBe(false);
    expect(FinancialPolicyOriginalStatusResponseSchema.safeParse({ ...closed, financialState: 'CONFIRMED' }).success).toBe(false);
  });
  it('accepts historical closure pins under fresh scope with the same stable actor', () => {
    const scope = { ...envelope.scope, actor: { ...expected.actor, membershipVersion: 8 }, organizationEpoch: 12 };
    expect(FinancialPolicyOriginalStatusResponseSchema.safeParse({ ...envelope, scope, ...locator, status: 'closed', receipt: null, closure: receipt }).success).toBe(true);
    scope.actor.actorId = 'another_actor';
    expect(FinancialPolicyOriginalStatusResponseSchema.safeParse({ ...envelope, scope, ...locator, status: 'closed', receipt: null, closure: receipt }).success).toBe(false);
  });
});
