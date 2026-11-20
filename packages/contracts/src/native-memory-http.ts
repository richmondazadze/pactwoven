import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdSchema, InstantSchema } from './core';
const text = (max:number) => z.string().min(1).max(max).refine(value=>value.length<=max&&value.trim().length>0,'Enter a readable value.');
const reviewBy = InstantSchema.refine(value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value),'Use at most millisecond precision.');
const fields = { title:text(180),text:text(8000),purpose:text(1000),reviewBy };
const version = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeMemoryNoteCommandSchema = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('remember'),siteId:IdSchema,...fields}),
  z.strictObject({kind:z.literal('correct'),siteId:IdSchema,noteId:IdSchema,expected:version,...fields}),
  z.strictObject({kind:z.literal('remove'),siteId:IdSchema,noteId:IdSchema,expected:version}),
]);
export const NativeMemoryNoteQuerySchema = z.strictObject({siteId:IdSchema,status:z.enum(['all','available','needs_review','removed']).default('all'),
  limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().min(1).max(2048).optional()});
export const NativeMemoryNoteScopeSchema=z.strictObject({environment:EnvironmentSchema,organizationId:IdSchema,siteId:IdSchema});
export const NativeMemoryNoteStatusSchema=z.enum(['available','needs_review','removed']);
export const NativeMemoryNoteSummarySchema=z.strictObject({id:IdSchema,title:text(180),siteName:z.string().min(1).max(180),suppliedBy:z.string().min(1).max(180),
  updatedAt:InstantSchema,reviewBy:InstantSchema.nullable(),status:NativeMemoryNoteStatusSchema});
export const NativeMemoryNoteDetailSchema=NativeMemoryNoteSummarySchema.extend({text:z.string().max(8000).nullable(),purpose:z.string().max(1000).nullable(),
  editToken:version.nullable(),sourceLabel:z.enum(['Human statement — not independently verified','Source attribution needs review']),
  usageLabel:z.literal('For permitted work at this site'),removalLabel:z.literal('Remove from future work'),historyRetained:z.literal(true)}).superRefine((value,ctx)=>{
  if(value.status==='removed'&&(value.title!=='Removed note'||value.text!==null||value.purpose!==null||value.reviewBy!==null||value.editToken!==null))
    ctx.addIssue({code:'custom',message:'Removed notes must have content-free current projections.'});
  if(value.status!=='removed'&&(value.text===null||value.purpose===null||value.reviewBy===null))
    ctx.addIssue({code:'custom',message:'Current maintenance projections require readable content and a review deadline.'});
  if(value.status==='available'&&value.sourceLabel==='Source attribution needs review')
    ctx.addIssue({code:'custom',message:'Unresolved source attribution requires review.'});
});
export const NativeMemoryNotePageSchema=z.strictObject({scope:NativeMemoryNoteScopeSchema,items:z.array(NativeMemoryNoteSummarySchema).max(50),nextCursor:z.string().min(1).max(2048).nullable()});
export const NativeMemoryNoteResponseSchema=z.strictObject({scope:NativeMemoryNoteScopeSchema,note:NativeMemoryNoteDetailSchema});
export const NativeMemoryNoteOperationSchema=z.strictObject({scope:NativeMemoryNoteScopeSchema,operationId:IdSchema,noteId:IdSchema,
  action:z.enum(['remember','correct','remove']),committedAt:InstantSchema,current:NativeMemoryNoteDetailSchema.nullable()});
export type NativeMemoryNoteCommand=z.infer<typeof NativeMemoryNoteCommandSchema>;
export type NativeMemoryNoteQuery=z.infer<typeof NativeMemoryNoteQuerySchema>;
export type NativeMemoryNoteDetail=z.infer<typeof NativeMemoryNoteDetailSchema>;
export type NativeMemoryNotePage=z.infer<typeof NativeMemoryNotePageSchema>;
export type NativeMemoryNoteResponse=z.infer<typeof NativeMemoryNoteResponseSchema>;
export type NativeMemoryNoteOperation=z.infer<typeof NativeMemoryNoteOperationSchema>;
export interface NativeMemoryNotesRepository {
 list(actor:z.infer<typeof ActorContextSchema>,query:NativeMemoryNoteQuery):Promise<NativeMemoryNotePage>;
 get(actor:z.infer<typeof ActorContextSchema>,siteId:string,noteId:string):Promise<NativeMemoryNoteResponse>;
 command(actor:z.infer<typeof ActorContextSchema>,key:string,input:NativeMemoryNoteCommand):Promise<NativeMemoryNoteOperation>;
 recover(actor:z.infer<typeof ActorContextSchema>,siteId:string,key:string):Promise<NativeMemoryNoteOperation|null>;
}
