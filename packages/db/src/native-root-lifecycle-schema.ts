import { z } from 'zod';
import { EnvironmentSchema, IdSchema, IdempotencyKeySchema, InstantSchema } from '../../contracts/src/core';
import { NativeAdvisoryGrantSchema,NativeAdvisoryHandoffSchema,NativeDelegationArtifactReferenceSchema } from '../../contracts/src/native-delegation';
import { NativeMemoryReferenceSchema } from '../../contracts/src/native-memory';

const Version=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Counter=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Digest=z.string().regex(/^[a-f0-9]{64}$/);
const text=(maximum:number)=>z.string().min(1).max(maximum).regex(/\S/);
const Scope=z.strictObject({environment:EnvironmentSchema,organizationId:IdSchema,siteId:IdSchema});
export const NATIVE_ROOT_BLOCKED_RESULT={outcome:'blocked' as const,title:'Work needs review',summary:'The work could not be completed with current, permitted evidence.',artifacts:[],evidenceValidUntil:null};
export const NativeRootReceiptReferenceSchema=z.strictObject({receiptId:z.uuid(),digest:Digest});
export const NativeRootCheckpointSchema=z.strictObject({stage:z.enum(['planning','working','reviewing','ready']),summary:text(4000),
 steps:z.array(z.strictObject({id:IdSchema,title:text(180),state:z.enum(['planned','active','done','blocked'])})).max(32)});
export const NativeRootCheckpointCommandSchema=z.strictObject({requestKey:IdempotencyKeySchema,expectedCheckpointVersion:Counter,
 checkpoint:NativeRootCheckpointSchema,plannerState:z.string().max(65536),inputReceipts:z.array(NativeRootReceiptReferenceSchema).max(128)});
export const NativeRootYieldCommandSchema=NativeRootCheckpointCommandSchema.extend({continuation:z.enum(['continue','wait_children']),waitFor:z.array(IdSchema).max(32)});
export const NativeRootControlSchema=z.strictObject({rootTaskId:IdSchema,expectedVersion:Version,action:z.enum(['pause','resume','cancel'])});
export const NativeRootInputsCommandSchema=z.strictObject({requestKey:IdempotencyKeySchema,
 results:z.array(z.strictObject({handoffId:IdSchema,publicationDigest:Digest})).min(1).max(32)});
export const NativeRootCoverageSchema=z.array(z.strictObject({taskId:IdSchema,disposition:z.enum(['advice_ready','failed','abandoned'])})).max(32);
export const NativeRootArtifactSchema=z.strictObject({id:IdSchema,title:text(180),text:text(16000)});
export const NativeRootCompleteCommandSchema=z.strictObject({requestKey:IdempotencyKeySchema,expectedCheckpointVersion:Counter,
 inputReceipts:z.array(NativeRootReceiptReferenceSchema).max(128),coverage:NativeRootCoverageSchema,
 result:z.strictObject({outcome:z.enum(['advice_ready','blocked']),title:text(180),summary:text(8000),
  artifacts:z.array(NativeRootArtifactSchema).max(16),evidenceValidUntil:InstantSchema.nullable()})});
export const NativeRootCheckpointReceiptSchema=z.strictObject({checkpointVersion:Version,generation:Version,attempt:z.number().int().min(1).max(4),
 continuation:z.enum(['running','yielded','waiting_children']),requestKey:IdempotencyKeySchema});
export const NativeRootControlReceiptSchema=z.strictObject({scope:Scope,operationId:z.uuid(),rootTaskId:IdSchema,action:z.enum(['pause','resume','cancel']),
 controlVersion:Version,generation:Version,state:z.enum(['ready','paused','cancelled','blocked']),committedAt:InstantSchema});
export const NativeRootInputReceiptSchema=z.strictObject({receipt:NativeRootReceiptReferenceSchema,generation:Version,dataValidUntil:InstantSchema.nullable(),
 results:z.array(z.strictObject({handoffId:IdSchema,publicationDigest:Digest,outcome:z.enum(['advice_ready','failed']),
  artifacts:z.array(z.strictObject({reference:NativeDelegationArtifactReferenceSchema,body:z.record(z.string(),z.unknown())})).max(32)})).max(32)});
export const NativeRootCompleteReceiptSchema=z.strictObject({kind:z.enum(['accepted','duplicate']),publicationDigest:Digest,rootTaskId:IdSchema,
 execution:z.enum(['advisory_only','none']),domainCompletion:z.literal(false)});
export const NativeRootViewSchema=z.strictObject({scope:Scope,id:IdSchema,title:text(180),prompt:text(12000),controlVersion:Version,
 updatedAt:InstantSchema,expiresAt:InstantSchema,evidenceUnavailable:z.boolean(),
 state:z.enum(['ready','running','yielded','waiting_children','paused','cancelled','completed','blocked']),reason:z.enum(['none','manual_pause','authority','attempts_exhausted','continuation_limit','reconciliation']),
 checkpointVersion:Counter,checkpoint:NativeRootCheckpointSchema.nullable(),checkpointHistorical:z.boolean(),
 attempt:z.number().int().min(1).max(4),attemptLimit:z.number().int().min(1).max(4),generation:Version,
 coverage:NativeRootCoverageSchema,result:NativeRootCompleteCommandSchema.shape.result.nullable(),domainCompletion:z.literal(false)});
export const NativeRootRecoverySchema=z.array(z.strictObject({rootTaskId:IdSchema,generation:Version,
 action:z.enum(['redelivered','recovered','blocked']),attempt:z.number().int().min(1).max(4)})).max(20);
export const NativeRootAssignmentSchema=z.strictObject({schemaVersion:z.literal(1),stepId:IdSchema,title:text(180),brief:text(8000),
 role:z.enum(['research','planning','escalation']),memoryReferences:z.array(NativeMemoryReferenceSchema).max(32)});
export const NativeRootHandoffCommandSchema=z.strictObject({requestKey:IdempotencyKeySchema,handoff:NativeAdvisoryHandoffSchema,assignment:NativeRootAssignmentSchema});
export const NativeRootBindNotesCommandSchema=z.strictObject({rootTaskId:IdSchema,selections:z.array(z.strictObject({noteId:IdSchema,expected:Digest})).max(32)});
export const NativeRootWorkSchema=z.strictObject({title:text(180),prompt:text(12000),siteId:IdSchema,grant:NativeAdvisoryGrantSchema,
 checkpointVersion:Counter,checkpoint:NativeRootCheckpointSchema.nullable(),plannerState:z.string().max(65536).nullable(),historical:z.boolean(),
 children:z.array(z.strictObject({taskId:IdSchema,handoffId:IdSchema,generation:Version,assignmentVersion:Version,state:z.enum(['ready','running','paused','cancelled','settled']),
  publicationDigest:Digest.nullable(),outcome:z.enum(['advice_ready','failed']).nullable(),assignment:NativeRootAssignmentSchema.nullable()})).max(32),
 inputReceipts:z.array(NativeRootReceiptReferenceSchema).max(128),memoryReferences:z.array(NativeMemoryReferenceSchema).max(32)});
export const NativeRootMaterialsSchema=z.strictObject({actorId:IdSchema,rootTitle:text(180),rootPrompt:text(12000),assignment:NativeRootAssignmentSchema,
 inputArtifacts:z.array(z.strictObject({reference:NativeDelegationArtifactReferenceSchema,body:z.record(z.string(),z.unknown())})).max(32)});
export type NativeRootCheckpointCommand=z.infer<typeof NativeRootCheckpointCommandSchema>;
export type NativeRootYieldCommand=z.infer<typeof NativeRootYieldCommandSchema>;
export type NativeRootControl=z.infer<typeof NativeRootControlSchema>;
export type NativeRootInputsCommand=z.infer<typeof NativeRootInputsCommandSchema>;
export type NativeRootCompleteCommand=z.infer<typeof NativeRootCompleteCommandSchema>;

/** Mirrored into the additive SQL boundary. Relational/CAS, ordered receipt,
 * deadline, scope and authorization checks remain authoritative in PostgreSQL. */
export const nativeRootCommandSchemas={checkpoint:NativeRootCheckpointCommandSchema,yield:NativeRootYieldCommandSchema,
 control:NativeRootControlSchema,inputs:NativeRootInputsCommandSchema,complete:NativeRootCompleteCommandSchema,
 handoff:NativeRootHandoffCommandSchema,bind_notes:NativeRootBindNotesCommandSchema};
