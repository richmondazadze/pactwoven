import { z } from 'zod';
// Direct source seam until the lead integrates the reviewed public exports.
import { NATIVE_MEMORY_MAX_GRAPH_DEPTH, NATIVE_MEMORY_MAX_GRAPH_RECORDS, NativeMemoryInventorySchema,
  NativeMemoryMutationSchema, NativeMemoryProvenanceSchema, NativeMemoryReadContextSchema, NativeMemoryRecordSchema,
  NativeMemoryReferenceSchema, NativeMemoryScopeSchema, NativeMemorySelectionReceiptSchema,
  NativeMemorySnapshotSchema, NativeMemorySourceRecordSchema, type NativeMemoryActiveRecord, type NativeMemoryInventory,
  type NativeMemoryReadContext, type NativeMemoryRecord, type NativeMemoryReference, type NativeMemoryScope,
  type NativeMemorySelection, type NativeMemorySelectionReceipt, type NativeMemorySnapshot,
  type NativeMemorySourceRecord, type NativeMemorySourceReference, type NativeMemorySourceSnapshot } from '../../contracts/src/native-memory';
import { InstantSchema } from '../../contracts/src/core';
import { canonicalJson, commandDigest } from './canonical';
import { DomainError } from './errors';

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const scope = (row: NativeMemoryScope): NativeMemoryScope => ({ environment: row.environment, organizationId: row.organizationId, siteId: row.siteId });
const key = (row: NativeMemoryScope, id: string) => canonicalJson([row.environment, row.organizationId, row.siteId, id]);
const memoryKey = (row: NativeMemoryReference | NativeMemoryRecord) => key(row, row.memoryId);
const sourceKey = (row: NativeMemorySourceReference | NativeMemorySourceRecord) => key(row, row.sourceId);
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
export const nativeMemoryLimitations = Object.freeze({ kind: 'MEMORY_DATA_ELIGIBILITY_ONLY' as const,
  authority: 'NOT_ESTABLISHED' as const, persistence: 'NOT_ESTABLISHED' as const, publicationCommitted: false as const });

export async function nativeMemoryDigest(input: unknown): Promise<string> {
  return commandDigest({ namespace: 'pactwoven/native-memory/v1', record: NativeMemoryRecordSchema.parse(input) });
}
export async function nativeMemorySourceDigest(input: unknown): Promise<string> {
  return commandDigest({ namespace: 'pactwoven/native-memory-source/v1', record: NativeMemorySourceRecordSchema.parse(input) });
}
export async function snapshotNativeMemory(input: unknown): Promise<NativeMemorySnapshot> {
  const record = NativeMemoryRecordSchema.parse(input);
  return freeze({ record, reference: { ...scope(record), memoryId: record.memoryId, revision: record.revision, digest: await nativeMemoryDigest(record) } });
}
export async function snapshotNativeMemorySource(input: unknown): Promise<NativeMemorySourceSnapshot> {
  const record = NativeMemorySourceRecordSchema.parse(input);
  return freeze({ record, reference: { ...scope(record), sourceId: record.sourceId, revision: record.revision, digest: await nativeMemorySourceDigest(record) } });
}
export async function nativeMemorySelectionDigest(input: NativeMemorySelection): Promise<string> {
  return commandDigest({ namespace: 'pactwoven/native-memory-selection/v1', selection: input });
}

type Denial = 'MALFORMED' | 'INVENTORY_INVALID' | 'INTEGRITY' | 'SCOPE' | 'READER' | 'PURPOSE' | 'NOT_CURRENT' |
  'NOT_AVAILABLE' | 'EXPIRED' | 'CONFLICT' | 'DEPENDENCY' | 'UNVERIFIED_OUTCOME' | 'SNAPSHOT_STALE';
class Ineligible extends Error { constructor(readonly reason: Denial) { super(reason); } }
function deny(reason: Denial): never { throw new Ineligible(reason); }
const rejected = (reason: Denial) => ({ ...nativeMemoryLimitations, eligible: false as const, reason });
type Evaluation = { record: NativeMemoryActiveRecord; selection: NativeMemorySelection };

async function evaluate(reference: NativeMemoryReference, context: NativeMemoryReadContext, inventory: NativeMemoryInventory, at: number): Promise<Evaluation> {
  if (!same(scope(reference), scope(context))) deny('SCOPE');
  const memories = new Map<string, NativeMemorySnapshot>(), sources = new Map<string, NativeMemorySourceSnapshot>();
  for (const row of inventory.memories) {
    if (!same(scope(row.record), scope(context)) || !same(scope(row.reference), scope(context))) deny('SCOPE');
    if (memories.has(memoryKey(row.record))) deny('INVENTORY_INVALID');
    memories.set(memoryKey(row.record), row);
  }
  for (const row of inventory.sources) {
    if (!same(scope(row.record), scope(context)) || !same(scope(row.reference), scope(context))) deny('SCOPE');
    if (sources.has(sourceKey(row.record))) deny('INVENTORY_INVALID');
    sources.set(sourceKey(row.record), row);
  }
  const selectedMemories = new Map<string, NativeMemoryReference>(), selectedSources = new Map<string, NativeMemorySourceReference>();
  const checked = new Map<string, { verified: boolean; outcome: boolean; height: number }>(), visiting = new Set<string>();
  let end = Infinity;
  const scoped = (row: NativeMemoryScope) => { if (!same(scope(row), scope(context))) deny('SCOPE'); };
  const readable = (row: NativeMemoryActiveRecord | NativeMemorySourceRecord, observedAt: string) => {
    scoped(row);
    if (!row.access.readers.some(reader => same(reader, context.reader))) deny('READER');
    if (!row.access.purposes.includes(context.purpose)) deny('PURPOSE');
    if (Date.parse(observedAt) > at || Date.parse(row.validFrom) > at) deny('NOT_CURRENT');
    if (Date.parse(row.validUntil) <= at) deny('EXPIRED');
    if (row.conflict !== 'clear') deny('CONFLICT');
    end = Math.min(end, Date.parse(row.validUntil));
  };
  const count = () => { if (selectedMemories.size + selectedSources.size > NATIVE_MEMORY_MAX_GRAPH_RECORDS) deny('DEPENDENCY'); };
  async function visitSource(ref: NativeMemorySourceReference) {
    scoped(ref);
    const found = sources.get(sourceKey(ref));
    if (!found) deny('DEPENDENCY');
    if (!same(found.reference, ref)) deny('NOT_CURRENT');
    if (!same((await snapshotNativeMemorySource(found.record)).reference, ref)) deny('INTEGRITY');
    if (found.record.status !== 'active') deny('NOT_AVAILABLE');
    readable(found.record, found.record.observedAt);
    selectedSources.set(sourceKey(ref), ref); count();
    return { verified: found.record.verification === 'verified', outcome: found.record.kind === 'verified_outcome', height: 0 };
  }
  async function visit(ref: NativeMemoryReference, depth: number): Promise<{ verified: boolean; outcome: boolean; height: number }> {
    scoped(ref);
    if (depth > NATIVE_MEMORY_MAX_GRAPH_DEPTH || visiting.has(memoryKey(ref))) deny('DEPENDENCY');
    const found = memories.get(memoryKey(ref));
    if (!found) deny('DEPENDENCY');
    if (!same(found.reference, ref)) deny('NOT_CURRENT');
    if (!same((await snapshotNativeMemory(found.record)).reference, ref)) deny('INTEGRITY');
    if (found.record.state !== 'active') deny('NOT_AVAILABLE');
    readable(found.record, found.record.recordedAt);
    const cached = checked.get(memoryKey(ref));
    if (cached) {
      if (depth + cached.height - 1 > NATIVE_MEMORY_MAX_GRAPH_DEPTH) deny('DEPENDENCY');
      return cached;
    }
    selectedMemories.set(memoryKey(ref), ref); count(); visiting.add(memoryKey(ref));
    const children = [];
    for (const source of found.record.inputs.sources) children.push(await visitSource(source));
    for (const memory of found.record.inputs.memories) children.push(await visit(memory, depth + 1));
    const evidence = { verified: children.every(child => child.verified), outcome: children.some(child => child.outcome),
      height: 1 + Math.max(0, ...children.map(child => child.height)) };
    if (depth + evidence.height - 1 > NATIVE_MEMORY_MAX_GRAPH_DEPTH) deny('DEPENDENCY');
    if (found.record.subject.kind === 'verified_outcome' && (!evidence.verified || !evidence.outcome)) deny('UNVERIFIED_OUTCOME');
    visiting.delete(memoryKey(ref)); checked.set(memoryKey(ref), evidence);
    return evidence;
  }
  await visit(reference, 1);
  const record = memories.get(memoryKey(reference))!.record;
  if (record.state !== 'active' || !Number.isFinite(end) || selectedSources.size === 0) deny('DEPENDENCY');
  const sorted = <T>(rows: T[]) => rows.sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
  return { record, selection: { schemaVersion: 1, context, root: reference, memories: sorted([...selectedMemories.values()]),
    sources: sorted([...selectedSources.values()]), selectedAt: new Date(at).toISOString(), validUntil: new Date(end).toISOString() } };
}

/** Selected records are untrusted data, never instructions or a capability.
 * Call only with an authoritative current-head inventory and independently
 * authenticated context. Pure checks cannot establish those prerequisites. */
export async function assessNativeMemoryRetrieval(referenceInput: unknown, contextInput: unknown, inventoryInput: unknown, now: string) {
  const reference = NativeMemoryReferenceSchema.safeParse(referenceInput), context = NativeMemoryReadContextSchema.safeParse(contextInput);
  const inventory = NativeMemoryInventorySchema.safeParse(inventoryInput), time = InstantSchema.safeParse(now);
  if (!reference.success || !context.success || !inventory.success || !time.success) return rejected('MALFORMED');
  try {
    const result = await evaluate(reference.data, context.data, inventory.data, Date.parse(time.data));
    const receipt = { selection: result.selection, digest: await nativeMemorySelectionDigest(result.selection) };
    return freeze({ ...nativeMemoryLimitations, eligible: true as const, receipt, memory: {
      reference: reference.data, content: result.record.content, confidence: result.record.confidence, provenance: result.record.provenance,
    } });
  } catch (error) { if (error instanceof Ineligible) return rejected(error.reason); throw error; }
}

/** Revalidate immediately at the protected publication boundary. The eventual
 * persistence transaction must lock every current head and ACL/source fence;
 * a valid selection digest alone never authorizes or commits publication. */
export async function assessNativeMemoryPublication(receiptInput: unknown, contextInput: unknown, inventoryInput: unknown, now: string) {
  const receipt = NativeMemorySelectionReceiptSchema.safeParse(receiptInput), context = NativeMemoryReadContextSchema.safeParse(contextInput);
  const inventory = NativeMemoryInventorySchema.safeParse(inventoryInput), time = InstantSchema.safeParse(now);
  if (!receipt.success || !context.success || !inventory.success || !time.success) return rejected('MALFORMED');
  const { selection, digest } = receipt.data, at = Date.parse(time.data);
  if (digest !== await nativeMemorySelectionDigest(selection)) return rejected('INTEGRITY');
  if (!same(selection.context, context.data)) return rejected('SCOPE');
  if (Date.parse(selection.selectedAt) > at || Date.parse(selection.validUntil) <= at) return rejected('SNAPSHOT_STALE');
  try {
    const fresh = await evaluate(selection.root, context.data, inventory.data, at);
    if (!same(selection, { ...fresh.selection, selectedAt: selection.selectedAt })) return rejected('SNAPSHOT_STALE');
    return freeze({ ...nativeMemoryLimitations, eligible: true as const, receipt: receipt.data });
  } catch (error) { if (error instanceof Ineligible) return rejected(error.reason); throw error; }
}

const writerSchema = NativeMemoryScopeSchema.extend({ provenance: NativeMemoryProvenanceSchema });
function fail(code: string, message: string): never { throw new DomainError(code, 409, message); }
/** Proposes an append only. The caller separately establishes write permission;
 * current=null must be a locked authoritative absence, including tombstones. */
export async function planNativeMemoryMutation(mutationInput: unknown, currentInput: unknown, writerInput: unknown, now: string) {
  const mutation = NativeMemoryMutationSchema.parse(mutationInput), writer = writerSchema.parse(writerInput);
  const current = currentInput === null ? null : NativeMemorySnapshotSchema.parse(currentInput);
  const at = Date.parse(InstantSchema.parse(now)), record = mutation.record;
  if (!same(scope(record), scope(writer)) || !same(record.provenance, writer.provenance)) fail('MEMORY_WRITER_MISMATCH', 'The record must match its independently authenticated writer and scope.');
  if (Date.parse(record.recordedAt) !== at) fail('MEMORY_TIME_MISMATCH', 'The new revision must use the operation observation time.');
  if (mutation.kind === 'create') {
    if (current !== null || record.state !== 'active' || record.revision !== 1 || record.previous !== null)
      fail('MEMORY_STALE', 'Creation requires an unused memory identity.');
  } else {
    if (current === null || !same(current.reference, mutation.expected) || !same((await snapshotNativeMemory(current.record)).reference, current.reference))
      fail('MEMORY_STALE', 'The exact current revision is required.');
    if (current.record.state === 'tombstone') fail('MEMORY_DELETED', 'A deleted memory identity cannot be restored.');
    const previous = current.record;
    if (current.record.revision === Number.MAX_SAFE_INTEGER || record.revision !== current.record.revision + 1 || !same(record.previous, current.reference) ||
        memoryKey(record) !== memoryKey(current.record) || !same(record.subject, current.record.subject) || record.key !== current.record.key ||
        Date.parse(current.record.recordedAt) > at || (mutation.kind === 'delete') !== (record.state === 'tombstone'))
      fail('MEMORY_STALE', 'A mutation must advance and preserve the exact memory identity.');
    if (writer.provenance.kind === 'agent') {
      if (current.record.provenance.kind === 'user') fail('MEMORY_USER_CONTROL', 'An agent cannot overwrite or delete user-authored memory.');
      if (record.state === 'active' && (record.access.readers.some(reader => !previous.access.readers.some(old => same(old, reader))) ||
          record.access.purposes.some(purpose => !previous.access.purposes.includes(purpose))))
        fail('MEMORY_SCOPE_EXPANSION', 'An agent correction cannot broaden memory readership or purpose.');
    }
  }
  const proposed = await snapshotNativeMemory(record);
  return freeze({ ...nativeMemoryLimitations, mutation: mutation.kind, expected: mutation.expected, proposed });
}
