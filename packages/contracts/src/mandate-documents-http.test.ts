import { describe, expect, it } from 'vitest';
import { MandateDocumentQuerySchema, MandateDocumentReadSchema } from './mandate-documents-http';

const savedAt = '2026-11-15T01:00:00.000Z';
const fixture = () => ({
  schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: 'responsibility_a', observedAt: '2026-11-15T02:00:00.000Z',
  document: { schemaVersion: 1, id: 'document_a', version: 1, organizationId: 'org_a', environment: 'development', purpose: 'MANDATE_POLICY',
    normalization: 'NFC_LF_V1', text: '  Café\nPolicy text.\n', contentHash: 'a'.repeat(64), previousVersion: null, createdAt: savedAt, createdBy: 'author_a', hash: 'b'.repeat(64) },
  savedAgainst: { responsibility: { id: 'responsibility_a', version: 2, hash: 'c'.repeat(64), siteId: 'site_a' }, organizationEpoch: 4 },
  savedResponsibility: { id: 'responsibility_a', organizationId: 'org_a', ownerId: 'owner_a', environment: 'development', version: 2, siteId: 'site_a',
    title: 'Saved responsibility', description: '', window: { startsAt: '2026-11-16T00:00:00Z', endsAt: '2026-11-17T00:00:00Z', timeZone: 'UTC' },
    requirements: [], acceptancePolicy: 'Signed evidence.', executionState: 'READY_FOR_AUTHORIZATION', authorityState: null, coverageState: 'UNKNOWN',
    createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z' },
  saveOperation: { schemaVersion: 1, organizationId: 'org_a', responsibilityId: 'responsibility_a', kind: 'mandate.document.create',
    target: { kind: 'document', id: 'document_a', version: 1, hash: 'b'.repeat(64) }, commandHash: 'd'.repeat(64), intentHash: null, observedAt: savedAt,
    operation: { id: 'operation_a', environment: 'development', status: 'succeeded', aggregateId: 'document_a', aggregateVersion: 1, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } },
});

describe('exact mandate document read contract', () => {
  it('requires an exact database-bounded version without default/latest or coercion aliases', () => {
    for (const version of [1, 2_147_483_647, '1', '2147483647']) expect(MandateDocumentQuerySchema.parse({ version }).version).toBe(Number(version));
    for (const version of [undefined, null, 0, -1, 1.5, 2_147_483_648, '', '01', '+1', ' 1', '1 ', '1.0', '1e1', '2147483648', ['1', '2'], 'latest']) {
      expect(MandateDocumentQuerySchema.safeParse({ version }).success).toBe(false);
    }
    for (const extra of [{ hash: 'a'.repeat(64) }, { limit: 1 }, { latest: true }]) expect(MandateDocumentQuerySchema.safeParse({ version: 1, ...extra }).success).toBe(false);
  });
  it.each(['ACCEPTANCE_POLICY', 'MANDATE_POLICY'])('preserves full normalized %s content and separate historical/current observation', purpose => {
    const source = fixture(); source.document.purpose = purpose;
    const result = MandateDocumentReadSchema.parse(source);
    expect(result).toEqual(source); expect(result.document.text).toBe('  Café\nPolicy text.\n');
    expect(result.saveOperation.observedAt).not.toBe(result.observedAt);
  });
  it.each(['environment', 'organizationId', 'responsibilityId', 'saved-version', 'saved-site', 'document-target', 'document-hash', 'receipt-kind', 'receipt-environment', 'receipt-organization', 'receipt-responsibility', 'save-time', 'read-time', 'snapshot-time', 'normalization', 'text-normalization', 'previous-reference', 'document-overflow', 'snapshot-overflow', 'epoch-overflow'])
  ('rejects mismatched %s provenance', change => {
    const value: any = fixture();
    if (change === 'environment') value.environment = 'staging';
    if (change === 'organizationId') value.document.organizationId = 'foreign_org';
    if (change === 'responsibilityId') value.responsibilityId = 'foreign_responsibility';
    if (change === 'saved-version') value.savedAgainst.responsibility.version++;
    if (change === 'saved-site') value.savedAgainst.responsibility.siteId = 'site_b';
    if (change === 'document-target') value.document.id = 'other_document';
    if (change === 'document-hash') value.document.hash = 'e'.repeat(64);
    if (change === 'receipt-kind') { value.saveOperation.kind = 'mandate.propose'; value.saveOperation.target.kind = 'proposal'; }
    if (change === 'receipt-environment') value.saveOperation.operation.environment = 'staging';
    if (change === 'receipt-organization') value.saveOperation.organizationId = 'other_org';
    if (change === 'receipt-responsibility') value.saveOperation.responsibilityId = 'other_responsibility';
    if (change === 'save-time') value.saveOperation.observedAt = value.observedAt;
    if (change === 'read-time') value.observedAt = '2026-11-14T00:00:00Z';
    if (change === 'snapshot-time') value.savedResponsibility.updatedAt = value.observedAt;
    if (change === 'normalization') value.document.normalization = 'RAW';
    if (change === 'text-normalization') value.document.text = 'Cafe\u0301\r\n';
    if (change === 'previous-reference') value.document.previousVersion = { id: 'document_a', version: 1, hash: 'a'.repeat(64) };
    if (change === 'document-overflow') value.document.version = 2_147_483_648;
    if (change === 'snapshot-overflow') value.savedResponsibility.version = value.savedAgainst.responsibility.version = 2_147_483_648;
    if (change === 'epoch-overflow') value.savedAgainst.organizationEpoch = 2_147_483_648;
    expect(MandateDocumentReadSchema.safeParse(value).success).toBe(false);
  });
  it.each(['accepted', 'pending', 'failed', 'unknown', 'financial', 'evidence', 'error', 'next-check', 'intent'])('rejects a %s save receipt', change => {
    const value: any = fixture(), operation = value.saveOperation.operation;
    if (['accepted', 'pending', 'failed', 'unknown'].includes(change)) operation.status = change;
    if (change === 'financial') operation.financialState = 'FINALIZED';
    if (change === 'evidence') operation.evidenceRefs = ['private_evidence'];
    if (change === 'error') operation.error = { code: 'FAILED', retryable: false, detailRef: null };
    if (change === 'next-check') operation.nextCheckAt = value.observedAt;
    if (change === 'intent') value.saveOperation.intentHash = 'a'.repeat(64);
    expect(MandateDocumentReadSchema.safeParse(value).success).toBe(false);
  });
  it('keeps previous-version identity exact and database bounded', () => {
    const value: any = fixture(); value.document.version = value.saveOperation.target.version = value.saveOperation.operation.aggregateVersion = 2;
    value.document.previousVersion = { id: value.document.id, version: 1, hash: 'a'.repeat(64) };
    expect(MandateDocumentReadSchema.safeParse(value).success).toBe(true);
    for (const previousVersion of [null, { ...value.document.previousVersion, id: 'foreign' }, { ...value.document.previousVersion, version: 2 }, { ...value.document.previousVersion, version: 2_147_483_648 }]) {
      expect(MandateDocumentReadSchema.safeParse({ ...value, document: { ...value.document, previousVersion } }).success).toBe(false);
    }
  });
  it.each(['token', 'identity', 'evidence', 'command', 'effect_context', 'idempotencyKey'])('rejects private %s at every envelope boundary', field => {
    for (const position of ['root', 'document', 'savedAgainst', 'savedResponsibility', 'saveOperation']) {
      const value: any = fixture(); (position === 'root' ? value : value[position])[field] = 'private';
      expect(MandateDocumentReadSchema.safeParse(value).success).toBe(false);
    }
  });
});
