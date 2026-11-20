import { describe, expect, it } from 'vitest';
import { CreateMandateDocumentRequestSchema, MandateCollectionQuerySchema, MandateEffectiveAuthoritySchema,
  MandateOperationQuerySchema, MandateOperationResultSchema, MandateReviewQuerySchema } from './mandate-http';

const hash = 'a'.repeat(64);
const operation = { id: 'operation_a', environment: 'development', status: 'succeeded', aggregateId: 'mandate_a', aggregateVersion: 4,
  financialState: null, evidenceRefs: [], nextCheckAt: null, error: null };
describe('strict mandate transport contracts', () => {
  it('requires an explicit exact review version and bounded integer page queries', () => {
    expect(MandateReviewQuerySchema.parse({ version: '2' })).toEqual({ version: 2 });
    expect(MandateCollectionQuerySchema.parse({})).toEqual({ limit: 25 });
    for (const version of [undefined, null, true, false, '', '01', '1.0', '1e2', 0, 1.2, '2147483648']) {
      expect(MandateReviewQuerySchema.safeParse({ version }).success).toBe(false);
    }
    for (const query of [{ limit: true }, { limit: '26' }, { limit: 0 }, { cursor: '' }, { includeProof: true }]) {
      expect(MandateCollectionQuerySchema.safeParse(query).success).toBe(false);
    }
  });
  it('binds policy creation to current responsibility/epoch without accepting identity or proof assertions', () => {
    const request = { responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, expectedOrganizationEpoch: 2,
      command: { documentId: 'document_a', expectedVersion: 0, previousVersion: null, purpose: 'MANDATE_POLICY', text: 'Advise only.' } };
    expect(CreateMandateDocumentRequestSchema.safeParse(request).success).toBe(true);
    for (const extra of [{ actor: {} }, { evidence: {} }, { nonce: 'client_nonce' }, { requesterId: 'owner_a' }]) {
      expect(CreateMandateDocumentRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    expect(CreateMandateDocumentRequestSchema.safeParse({ ...request, command: { ...request.command, createdBy: 'owner_a' } }).success).toBe(false);
  });
  it('keeps head epoch, target record, operation and financial truth aligned', () => {
    const result = { schemaVersion: 1, organizationId: 'org_a', operation, kind: 'mandate.pause', responsibilityId: 'responsibility_a',
      target: { kind: 'authority', id: 'mandate_a', version: 4, hash }, commandHash: hash, intentHash: hash, observedAt: '2026-11-14T12:00:00.000Z' };
    expect(MandateOperationResultSchema.safeParse(result).success).toBe(true);
    for (const changed of [
      { ...result, operation: { ...operation, financialState: 'FINALIZED' } }, { ...result, target: { ...result.target, version: 1 } },
      { ...result, target: { ...result.target, id: 'other_mandate' } }, { ...result, kind: 'mandate.authorize' }, { ...result, intentHash: null },
      { ...result, evidence: { token: 'sensitive' } }, { ...result, kind: 'pay_supplier' },
    ]) expect(MandateOperationResultSchema.safeParse(changed).success).toBe(false);
    expect(MandateOperationQuerySchema.safeParse({ kind: 'mandate.pause', key: 'original_key_012345' }).success).toBe(true);
    expect(MandateOperationQuerySchema.safeParse({ kind: 'member.grant', key: 'original_key_012345' }).success).toBe(false);
  });
  it('does not present blocked authority as usable or conceal an inactive reason', () => {
    expect(MandateEffectiveAuthoritySchema.safeParse({ state: 'ACTIVE', blockers: ['ORGANIZATION_CHANGED'] }).success).toBe(false);
    expect(MandateEffectiveAuthoritySchema.safeParse({ state: 'EXPIRED', blockers: [] }).success).toBe(false);
    expect(MandateEffectiveAuthoritySchema.parse({ state: 'STALE', blockers: ['RESPONSIBILITY_CHANGED'] }).state).toBe('STALE');
  });
});
