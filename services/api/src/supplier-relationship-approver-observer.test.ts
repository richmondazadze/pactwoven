import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupplierRelationshipApproverObserver, assertSupplierApproversCurrent,
  type SupplierOriginalApproverPlan } from './supplier-relationship-approver-observer.js';

const sdk = vi.hoisted(() => ({ lookup: vi.fn(), session: vi.fn() }));
vi.mock('@clerk/backend', async importOriginal => ({
  ...await importOriginal<typeof import('@clerk/backend')>(),
  createClerkClient: vi.fn(() => ({ sessions: { getSession: sdk.session }, organizations: { getOrganizationMembershipList: sdk.lookup } })),
}));
const NOW = Date.parse('2026-11-16T12:00:00.000Z'), issuer = 'https://pactwoven-test.clerk.accounts.dev';
const iso = (at: number) => new Date(at).toISOString();
const scope = { environment: 'simulation' as const, buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier', supplierRelationshipId: 'relationship' };
const proposal = { id: 'relationship', version: 1, hash: 'a'.repeat(64) };
const configuration = () => ({ environment: 'simulation' as const, issuer, binding: {
  reference: { id: 'binding', version: 1, hash: 'b'.repeat(64) }, environment: 'simulation' as const, effectiveOrganizationId: 'buyer',
  verifier: { oid: 101, name: 'supplier_verifier' }, authorizer: { oid: 102, name: 'supplier_authorizer' },
  status: 'ACTIVE' as const, validFrom: iso(NOW - 3_600_000), expiresAt: iso(NOW + 3_600_000),
} });
function plan(): SupplierOriginalApproverPlan {
  return { scope, head: { scope, revision: 3, proposal, status: 'ACTIVE' }, approvers: (['buyer', 'supplier'] as const).map(party => ({
    approval: { party, proposal, actorId: `old_${party}`, membershipId: `old_${party}`, organizationId: party,
      membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0, approvedAt: iso(NOW - 5_000), expiresAt: iso(NOW + 60_000) },
    externalOrganizationId: `org_${party}`, externalMembershipId: `ext_${party}`, subject: `user_${party}`,
  })) };
}
function page(party: string, role = 'org:admin') {
  return { totalCount: 1, data: [{ id: `ext_${party}`, role,
    organization: { id: `org_${party}` }, publicUserData: { userId: `user_${party}` } }] };
}
const observer = () => createSupplierRelationshipApproverObserver({ secretKey: 'sk_test_local_fixture', issuer,
  authorizedParties: ['http://localhost:3001'] }, configuration());
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); sdk.session.mockReset();
  sdk.lookup.mockReset().mockImplementation(async ({ organizationId }: { organizationId: string }) => page(organizationId.slice(4)));
});
afterEach(() => vi.useRealTimers());

describe('private original approver membership observation', () => {
  it('looks up exactly the recorded membership and preserves its full approval stamp without sessions', async () => {
    const input = plan(), result = await observer().observe(input);
    expect(sdk.lookup.mock.calls).toEqual([
      [{ organizationId: 'org_buyer', userId: ['user_buyer'], limit: 2 }],
      [{ organizationId: 'org_supplier', userId: ['user_supplier'], limit: 2 }],
    ]);
    expect(result.map(entry => entry.approval)).toEqual(input.approvers.map(entry => entry.approval));
    expect(result[0]?.observation).toEqual({ issuer, subject: 'user_buyer', externalOrganizationId: 'org_buyer', externalMembershipId: 'ext_buyer',
      externalRole: 'org:admin', status: 'ACTIVE', observedAt: iso(NOW), expiresAt: iso(NOW + 30_000) });
    expect(Object.isFrozen(result[0]?.observation)).toBe(true);
    expect(sdk.session).not.toHaveBeenCalled();
  });

  it('supports a genuinely empty plan without inventing a relationship or membership', async () => {
    expect(await observer().observe({ scope, head: null, approvers: [] })).toEqual([]);
    expect(sdk.lookup).not.toHaveBeenCalled();
  });

  it.each([
    { totalCount: 0, data: [] },
    { totalCount: 2, data: [...page('buyer').data, ...page('buyer').data] },
    { totalCount: 1, data: [{ ...page('buyer').data[0]!, id: 'replacement_member' }] },
    { totalCount: 1, data: [{ ...page('buyer').data[0]!, publicUserData: { userId: 'foreign' } }] },
    { totalCount: 1, data: [{ ...page('buyer').data[0]!, organization: { id: 'foreign' } }] },
    { totalCount: 1, data: [{ ...page('buyer').data[0]!, role: '' }] },
    null,
  ])('refuses missing, ambiguous or substituted live facts without asserting a negative gate', async result => {
    sdk.lookup.mockResolvedValue(result);
    await expect(observer().observe(plan())).rejects.toMatchObject({ code: 'SUPPLIER_APPROVER_REFUSED' });
    expect(sdk.lookup).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('PRIVATE_PROVIDER_DIAGNOSTIC'), { status: 404, body: 'PRIVATE_PROVIDER_DIAGNOSTIC' }])('treats a lookup failure as unavailable rather than invented inactive membership', async failure => {
    sdk.lookup.mockRejectedValue(failure);
    await expect(observer().observe(plan())).rejects.toMatchObject({ code: 'SUPPLIER_APPROVER_UNAVAILABLE',
      message: 'Original approver membership verification is temporarily unavailable.' });
  });

  it('retains a changed live role for SQL evaluation, rather than asserting old staff authority', async () => {
    sdk.lookup.mockResolvedValueOnce(page('buyer', 'org:member')).mockResolvedValueOnce(page('supplier'));
    expect((await observer().observe(plan()))[0]?.observation.externalRole).toBe('org:member');
  });

  it.each([20_000, 20_001])('checks the first observation again after a %i ms second lookup', async delay => {
    sdk.lookup.mockResolvedValueOnce(page('buyer')).mockImplementationOnce(async () => { vi.setSystemTime(NOW + delay); return page('supplier'); });
    const pending = observer().observe(plan());
    if (delay === 20_000) {
      const values = await pending;
      expect(values[0]?.observation.observedAt).toBe(iso(NOW));
      expect(values[1]?.observation.observedAt).toBe(iso(NOW + delay));
    } else await expect(pending).rejects.toMatchObject({ code: 'SUPPLIER_APPROVER_REFUSED' });
  });

  it('snapshots all locators before the first lookup and copies returned provider data', async () => {
    const input = structuredClone(plan()), returned = page('buyer');
    let release!: (value: ReturnType<typeof page>) => void;
    sdk.lookup.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = observer().observe(input);
    input.approvers[0]!.externalMembershipId = 'foreign'; input.approvers[1]!.subject = 'foreign';
    input.head!.revision = 99;
    release(returned);
    const values = await pending; returned.data[0]!.role = 'changed_after_return';
    expect(values[0]?.head.revision).toBe(3);
    expect(values[0]?.observation.externalRole).toBe('org:admin');
    expect(sdk.lookup.mock.calls[1]).toEqual([{ organizationId: 'org_supplier', userId: ['user_supplier'], limit: 2 }]);
  });

  it('rejects invalid private plans before any lookup', async () => {
    const input = structuredClone(plan()); input.approvers[1]!.approval.proposal = { ...input.approvers[1]!.approval.proposal, hash: 'f'.repeat(64) };
    await expect(observer().observe(input)).rejects.toMatchObject({ code: 'SUPPLIER_APPROVER_REFUSED' });
    expect(sdk.lookup).not.toHaveBeenCalled();
  });

  it('keeps binding expiry exact and refuses future or stale original observations', async () => {
    const values = await observer().observe(plan()), config = configuration();
    expect(() => assertSupplierApproversCurrent(values, config, iso(NOW + 20_000))).not.toThrow();
    expect(() => assertSupplierApproversCurrent(values, config, iso(NOW + 20_001))).toThrow();
    expect(() => assertSupplierApproversCurrent(values, config, iso(NOW - 1))).toThrow();
    config.binding.expiresAt = iso(NOW);
    expect(() => assertSupplierApproversCurrent(values, config, iso(NOW))).toThrow();
  });
});
