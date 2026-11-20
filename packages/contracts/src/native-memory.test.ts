import { describe, expect, it } from 'vitest';
import { NativeMemoryAccessSchema, NativeMemoryContentSchema, NativeMemoryInventorySchema, NativeMemoryProvenanceSchema,
  NativeMemoryReadContextSchema, NativeMemoryRecordSchema, NativeMemoryReferenceSchema, NativeMemorySourceRecordSchema } from './native-memory';

const scope = { environment: 'development' as const, organizationId: 'org_a', siteId: 'site_a' };
const reference = { ...scope, memoryId: 'memory_a', revision: 1, digest: 'a'.repeat(64) };
const access = { readers: [{ kind: 'user' as const, id: 'human_a' }], purposes: ['task_context' as const] };
const source = { ...scope, sourceId: 'source_a', revision: 1, digest: 'b'.repeat(64) };
const record = { schemaVersion: 1 as const, ...scope, memoryId: 'memory_a', revision: 1, previous: null,
  subject: { kind: 'preference' as const, id: 'chair' }, key: 'color', recordedAt: '2026-11-18T10:00:00Z',
  provenance: { kind: 'user' as const, actorId: 'human_a' }, state: 'active' as const,
  content: { title: 'Chair color', summary: 'Use blue chairs.', attributes: { color: 'blue', count: 3, recycled: true, unknown: null } },
  access, validFrom: '2026-11-18T09:00:00Z', validUntil: '2026-11-19T10:00:00Z', confidence: 'high' as const,
  conflict: 'clear' as const, inputs: { sources: [source], memories: [] } };

describe('versioned native memory contracts', () => {
  it('accepts structured data and exact user provenance without treating it as authority', () => {
    expect(NativeMemoryRecordSchema.parse(record)).toEqual(record);
    expect(NativeMemoryRecordSchema.safeParse({ ...record, delegated: true, allowedToSpend: true }).success).toBe(false);
  });
  it('requires distinct agent provenance including a task and handoff', () => {
    expect(NativeMemoryProvenanceSchema.safeParse({ kind: 'agent', agentId: 'agent_a', taskId: 'task_a', handoffId: 'handoff_a' }).success).toBe(true);
    expect(NativeMemoryProvenanceSchema.safeParse({ kind: 'agent', actorId: 'human_a' }).success).toBe(false);
    expect(NativeMemoryProvenanceSchema.safeParse({ kind: 'user', actorId: 'human_a', agentId: 'agent_a' }).success).toBe(false);
  });
  it('requires exact usage attribution without accepting an authority grant', () => {
    const context = { ...scope, reader: { kind: 'agent', id: 'agent_a' }, purpose: 'task_context',
      usage: { kind: 'task', taskId: 'task_a', generation: 1, handoffId: 'handoff_a' } };
    expect(NativeMemoryReadContextSchema.safeParse(context).success).toBe(true);
    expect(NativeMemoryReadContextSchema.safeParse({ ...context, usage: { ...context.usage, handoffId: null } }).success).toBe(false);
    expect(NativeMemoryReadContextSchema.safeParse({ ...context, usage: { kind: 'request', requestId: 'request_a' } }).success).toBe(false);
    expect(NativeMemoryReadContextSchema.safeParse({ ...context, grantId: 'grant_a' }).success).toBe(false);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('rejects unsafe revision %s', revision => {
    expect(NativeMemoryReferenceSchema.safeParse({ ...reference, revision }).success).toBe(false);
  });
  it('rejects ambiguous digest, unknown purpose and duplicate reader/purpose entries', () => {
    expect(NativeMemoryReferenceSchema.safeParse({ ...reference, digest: 'A'.repeat(64) }).success).toBe(false);
    expect(NativeMemoryAccessSchema.safeParse({ ...access, purposes: ['execute_payment'] }).success).toBe(false);
    expect(NativeMemoryAccessSchema.safeParse({ ...access, readers: [...access.readers, ...access.readers] }).success).toBe(false);
    expect(NativeMemoryAccessSchema.safeParse({ ...access, purposes: ['task_context', 'task_context'] }).success).toBe(false);
  });
  it('rejects missing, skipped or cross-scope predecessors', () => {
    expect(NativeMemoryRecordSchema.safeParse({ ...record, revision: 2 }).success).toBe(false);
    expect(NativeMemoryRecordSchema.safeParse({ ...record, revision: 3, previous: reference }).success).toBe(false);
    expect(NativeMemoryRecordSchema.safeParse({ ...record, revision: 2, previous: { ...reference, siteId: 'other' } }).success).toBe(false);
    expect(NativeMemoryRecordSchema.safeParse({ ...record, revision: 2, previous: reference }).success).toBe(true);
  });
  it('keeps tombstones content-free with an exact predecessor', () => {
    const { content, access: _, validFrom, validUntil, confidence, conflict, inputs, ...identity } = record;
    const tombstone = { ...identity, state: 'tombstone', revision: 2, previous: reference, reason: 'deleted' };
    expect(NativeMemoryRecordSchema.safeParse(tombstone).success).toBe(true);
    expect(NativeMemoryRecordSchema.safeParse({ ...tombstone, content }).success).toBe(false);
    expect(NativeMemoryRecordSchema.safeParse({ ...tombstone, revision: 1, previous: null }).success).toBe(false);
  });
  it('requires finite ordered validity and source provenance', () => {
    for (const validUntil of [record.validFrom, record.recordedAt, 'not-a-time'])
      expect(NativeMemoryRecordSchema.safeParse({ ...record, validUntil }).success).toBe(false);
    expect(NativeMemoryRecordSchema.safeParse({ ...record, inputs: { sources: [], memories: [] } }).success).toBe(false);
  });
  it('rejects duplicate or cross-scope dependencies before any retrieval', () => {
    for (const sources of [[source, source], [source, { ...source, revision: 2 }], [{ ...source, organizationId: 'other' }]])
      expect(NativeMemoryRecordSchema.safeParse({ ...record, inputs: { sources, memories: [] } }).success).toBe(false);
  });
  it('bounds graph/metadata and preserves exact decimal strings', () => {
    expect(NativeMemoryContentSchema.parse({ ...record.content, attributes: { amount: '18446744073709551615' } }).attributes.amount).toBe('18446744073709551615');
    for (const attributes of [{ decimal: 0.1 }, { unsafe: Number.MAX_SAFE_INTEGER + 1 }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`field_${i}`, 'x']))])
      expect(NativeMemoryContentSchema.safeParse({ ...record.content, attributes }).success).toBe(false);
    expect(NativeMemoryInventorySchema.safeParse({ memories: Array.from({ length: 129 }, () => ({ record, reference })), sources: [] }).success).toBe(false);
  });
  it('source descriptors cannot smuggle raw documents or URLs into this contract', () => {
    const sourceRecord = { schemaVersion: 1, ...scope, sourceId: 'source_a', revision: 1, kind: 'document', status: 'active',
      contentDigest: 'c'.repeat(64), provenance: record.provenance, observedAt: record.recordedAt,
      validFrom: record.validFrom, validUntil: record.validUntil, access, conflict: 'clear', verification: 'unverified' };
    expect(NativeMemorySourceRecordSchema.safeParse(sourceRecord).success).toBe(true);
    expect(NativeMemorySourceRecordSchema.safeParse({ ...sourceRecord, fetchUrl: 'http://169.254.169.254/' }).success).toBe(false);
  });
});
