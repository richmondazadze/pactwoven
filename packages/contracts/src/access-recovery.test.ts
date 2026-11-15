import { describe, expect, it } from 'vitest';
import { AccessRecoveryQuerySchema, AccessRecoveryResultSchema, CloseAccessRecoveryIntentSchema, CloseAccessRecoveryResultSchema } from './access-recovery';

const intent = { schemaVersion: 1, kind: 'grant', reason: 'original_input_unavailable', expectedEnvironment: 'development',
  expectedOrganizationId: 'org_a', expectedActorId: 'owner_a', expectedExternalMembershipId: 'orgmem_a', expectedAuthorityEpoch: 4 };
const envelope = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', externalOrganizationId: 'external_a',
  kind: 'grant', key: 'original_key_012345', observedAt: '2026-11-15T07:00:01.000Z',
  reviewer: { actorId: 'owner_a', externalMembershipId: 'orgmem_a', authorityEpoch: 4 } };
const operation = { id: 'operation_a', environment: 'development', status: 'succeeded', aggregateId: 'member_a', aggregateVersion: 2,
  financialState: null, evidenceRefs: [], nextCheckAt: null, error: null };
const fence = { id: 'fence_a', closedAt: '2026-11-15T07:00:00.000Z' };

describe('member access recovery boundary', () => {
  it.each(['grant', 'revise', 'revoke'])('retains the exact %s namespace and permits no lookup assertions', kind => {
    const query = { kind, key: 'original_key_012345' };
    expect(AccessRecoveryQuerySchema.parse(query)).toEqual(query);
    for (const extra of [{ target: 'member_a' }, { actorId: 'owner_a' }, { cancelled: true }, { commandHash: 'a'.repeat(64) }]) {
      expect(AccessRecoveryQuerySchema.safeParse({ ...query, ...extra }).success).toBe(false);
    }
  });
  it('rejects malformed namespaces without normalizing key bytes', () => {
    for (const kind of ['', 'member.grant', 'mandate.revoke', undefined, null, 1]) {
      expect(AccessRecoveryQuerySchema.safeParse({ kind, key: envelope.key }).success).toBe(false);
    }
    for (const key of ['', 'short', ' original_key_012345', 'original_key_012345 ', 'a'.repeat(129), null, undefined, 42]) {
      expect(AccessRecoveryQuerySchema.safeParse({ kind: 'grant', key }).success).toBe(false);
    }
  });
  it('requires every current review pin and a bounded noncoerced epoch', () => {
    expect(CloseAccessRecoveryIntentSchema.parse(intent)).toEqual(intent);
    for (const field of Object.keys(intent)) {
      const incomplete = { ...intent } as Record<string, unknown>;
      delete incomplete[field];
      expect(CloseAccessRecoveryIntentSchema.safeParse(incomplete).success).toBe(false);
      expect(CloseAccessRecoveryIntentSchema.safeParse({ ...intent, [field]: null }).success).toBe(false);
    }
    for (const expectedAuthorityEpoch of [-1, 0.5, '4', true, 2_147_483_648, Infinity]) {
      expect(CloseAccessRecoveryIntentSchema.safeParse({ ...intent, expectedAuthorityEpoch }).success).toBe(false);
    }
  });
  it('forbids fabricated original input and client-supplied authentication', () => {
    for (const extra of [{ key: envelope.key }, { target: 'member_a' }, { originalActorId: 'owner_a' }, { command: {} },
      { commandHash: 'a'.repeat(64) }, { evidence: {} }, { token: 'bearer' }, { firstFactor: true }, { nonce: 'a' }, { purpose: 'member_access' }]) {
      expect(CloseAccessRecoveryIntentSchema.safeParse({ ...intent, ...extra }).success).toBe(false);
    }
    for (const reason of ['cancel', 'original_request_failed', '', 'original_input_unavailable ']) {
      expect(CloseAccessRecoveryIntentSchema.safeParse({ ...intent, reason }).success).toBe(false);
    }
  });
  it('distinguishes absence from a successful closure and retains nonterminal recorded operations', () => {
    const missing = { ...envelope, disposition: 'not_recorded' };
    expect(AccessRecoveryResultSchema.parse(missing)).toEqual(missing);
    expect(CloseAccessRecoveryResultSchema.safeParse(missing).success).toBe(false);
    for (const status of ['accepted', 'pending', 'succeeded', 'failed', 'unknown']) {
      const result = { ...envelope, disposition: 'recorded', operation: { ...operation, status } };
      expect(AccessRecoveryResultSchema.parse(result)).toEqual(result);
      expect(CloseAccessRecoveryResultSchema.parse(result)).toEqual(result);
    }
    const result = { ...envelope, disposition: 'fenced', fence };
    expect(CloseAccessRecoveryResultSchema.parse(result)).toEqual(result);
  });
  it('rejects mixed dispositions, financial claims and cross-environment operations', () => {
    for (const result of [
      { ...envelope, disposition: 'recorded', operation, fence }, { ...envelope, disposition: 'fenced', operation, fence },
      { ...envelope, disposition: 'not_recorded', fence }, { ...envelope, disposition: 'not_recorded', operation },
      { ...envelope, disposition: 'cancelled' }, { ...envelope, disposition: 'recorded', operation: { ...operation, environment: 'production' } },
      { ...envelope, disposition: 'recorded', operation: { ...operation, financialState: 'FINALIZED' } },
      { ...envelope, disposition: 'fenced', fence: { ...fence, closedAt: '2026-11-15T08:00:00.000Z' } },
    ]) expect(AccessRecoveryResultSchema.safeParse(result).success).toBe(false);
  });
  it('keeps private closure evidence and invented historical identity out of the public receipt', () => {
    for (const extra of [{ evidence: {} }, { tokenHash: 'a'.repeat(64) }, { sessionId: 'session_a' }, { originalActorId: 'owner_a' },
      { originalTarget: 'member_a' }, { closeIntentHash: 'a'.repeat(64) }]) {
      expect(AccessRecoveryResultSchema.safeParse({ ...envelope, disposition: 'fenced', fence: { ...fence, ...extra } }).success).toBe(false);
      expect(AccessRecoveryResultSchema.safeParse({ ...envelope, disposition: 'fenced', fence, ...extra }).success).toBe(false);
    }
  });
});
