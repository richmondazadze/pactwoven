import { z } from 'zod';
import { IdSchema, InstantSchema } from '../../contracts/src/core';
import { NativeMemoryRecordSchema, NativeMemorySourceRecordSchema, NativeMemoryReferenceSchema,
  NativeMemorySourceReferenceSchema, NativeMemorySelectionReceiptSchema, NativeMemoryRevisionSchema,
  NativeMemoryActiveRecordSchema } from '../../contracts/src/native-memory';

// The persistence boundary intentionally accepts millisecond-or-coarser ISO
// instants. It never rounds a caller's reference/hash or a validity deadline.
const storageInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const boundedInstants = (r: Record<string, unknown>) => ['recordedAt','observedAt','validFrom','validUntil']
  .every(k => r[k] === undefined || typeof r[k] === 'string' && storageInstant.test(r[k]));
const memoryRecord = NativeMemoryRecordSchema.refine(boundedInstants,'Persistence requires ISO instants with at most millisecond precision.');
const sourceRecord = NativeMemorySourceRecordSchema.refine(boundedInstants,'Persistence requires ISO instants with at most millisecond precision.');
export const NativeMemoryWriteSchema = z.strictObject({ kind:z.enum(['create','correct','delete']),
  expected:NativeMemoryReferenceSchema.nullable(),record:memoryRecord });
export const NativeMemorySourceWriteSchema = z.strictObject({ kind:z.enum(['create','correct','delete']),
  expected:NativeMemorySourceReferenceSchema.nullable(),record:sourceRecord });
export const NativeMemoryHumanReadSchema = z.strictObject({ reference:NativeMemoryReferenceSchema,requestId:IdSchema,purpose:z.enum(['human_review','audit']) });
export const NativeMemoryTaskSelectorSchema = z.strictObject({ organizationId:IdSchema,taskId:IdSchema,
  generation:NativeMemoryRevisionSchema,handoffId:IdSchema,leaseToken:z.uuid() });
export const NativeMemoryReadResultSchema = z.strictObject({ usageId:z.uuid(),receipt:NativeMemorySelectionReceiptSchema,
  memory:z.strictObject({ reference:NativeMemoryReferenceSchema,content:NativeMemoryActiveRecordSchema.shape.content,
    confidence:NativeMemoryActiveRecordSchema.shape.confidence,provenance:NativeMemoryActiveRecordSchema.shape.provenance }),
  observedAt:InstantSchema,validUntil:InstantSchema });
const recoveryFields = { availability:z.enum(['current','superseded','unavailable']) };
export const NativeMemoryRecoverySchema = z.discriminatedUnion('kind',[
  z.strictObject({ kind:z.literal('memory'),originalReference:NativeMemoryReferenceSchema,currentReference:NativeMemoryReferenceSchema.nullable(),...recoveryFields }),
  z.strictObject({ kind:z.literal('source'),originalReference:NativeMemorySourceReferenceSchema,currentReference:NativeMemorySourceReferenceSchema.nullable(),...recoveryFields }),
]);
export type NativeMemoryWrite = z.infer<typeof NativeMemoryWriteSchema>;
export type NativeMemorySourceWrite = z.infer<typeof NativeMemorySourceWriteSchema>;
export type NativeMemoryHumanRead = z.infer<typeof NativeMemoryHumanReadSchema>;
export type NativeMemoryTaskSelector = z.infer<typeof NativeMemoryTaskSelectorSchema>;
export type NativeMemoryReadResult = z.infer<typeof NativeMemoryReadResultSchema>;
export type NativeMemoryRecovery = z.infer<typeof NativeMemoryRecoverySchema>;
