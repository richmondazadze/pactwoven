import { describe, expect, it } from 'vitest';
import { ApprovalPolicySchema, AuthorityBindingSchema, FinancialComponentSchema, HashSchema } from './index.js';

describe('financial contract input bounds', () => {
  it('rejects unsafe epochs, floating amounts and caller authority fields', () => {
    const binding = { organizationId: 'org_a', environment: 'development', organizationEpoch: 0, mandateId: 'mandate_a', mandateVersion: 1, mandateEpoch: 1 };
    expect(AuthorityBindingSchema.safeParse(binding).success).toBe(true);
    expect(AuthorityBindingSchema.safeParse({ ...binding, mandateEpoch: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    const component = { id: 'line_a', economicPortionId: 'portion_a', assetId: 'test_asset', category: 'supplier_principal', amountBaseUnits: '10' };
    for (const amountBaseUnits of ['1.1', '-1', '1e3', '01', '18446744073709551616']) {
      expect(FinancialComponentSchema.safeParse({ ...component, amountBaseUnits }).success).toBe(false);
    }
    expect(FinancialComponentSchema.safeParse({ ...component, actorId: 'attacker' }).success).toBe(false);
    expect(HashSchema.safeParse('arbitrary unbound payload').success).toBe(false);
  });
  it('does not offer a policy flag that permits financial self-approval', () => {
    const policy = { reference: { id: 'policy', version: 1, hash: 'a'.repeat(64) }, organizationId: 'org_a', environment: 'development',
      eligibleRoles: ['finance'], independentApprover: false, maximumStepUpAgeMs: 300000, maximumApprovalAgeMs: 300000, expiresAt: '2026-11-14T13:00:00.000Z' };
    expect(ApprovalPolicySchema.safeParse(policy).success).toBe(false);
  });
  it('permits policies to narrow only the baseline buyer financial approval roles', () => {
    const policy = { reference: { id: 'policy', version: 1, hash: 'a'.repeat(64) }, organizationId: 'org_a', environment: 'development',
      independentApprover: true, maximumStepUpAgeMs: 300000, maximumApprovalAgeMs: 300000, expiresAt: '2026-11-14T13:00:00.000Z' };
    for (const role of ['owner', 'finance', 'operations']) expect(ApprovalPolicySchema.safeParse({ ...policy, eligibleRoles: [role] }).success).toBe(true);
    for (const role of ['auditor', 'supplier_admin', 'supplier_dispatcher', 'receiver', 'support', 'service']) {
      expect(ApprovalPolicySchema.safeParse({ ...policy, eligibleRoles: [role] }).success).toBe(false);
      expect(ApprovalPolicySchema.safeParse({ ...policy, eligibleRoles: ['finance', role] }).success).toBe(false);
    }
  });
});
