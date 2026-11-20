import type { Pool } from 'pg';
import { z } from 'zod';
import { ActorContextSchema,EnvironmentSchema,IdempotencyKeySchema,IdSchema,InstantSchema,type ActorContext,type Environment } from '../../contracts/src/core';
import { NativeMemoryNoteCommandSchema,NativeMemoryNoteDetailSchema,NativeMemoryNoteQuerySchema,NativeMemoryNoteScopeSchema,
 NativeMemoryNoteSummarySchema,NativeMemoryNotePageSchema,NativeMemoryNoteResponseSchema,NativeMemoryNoteOperationSchema,
 type NativeMemoryNotesRepository,type NativeMemoryNoteCommand,type NativeMemoryNoteQuery,type NativeMemoryNotePage,type NativeMemoryNoteResponse,type NativeMemoryNoteOperation } from '../../contracts/src/native-memory-http';
import { DomainError } from '@pactwoven/domain';
const afterSchema=z.strictObject({createdAt:InstantSchema,id:IdSchema});
const cursorSchema=z.strictObject({v:z.literal(1),scope:NativeMemoryNoteScopeSchema,actorId:IdSchema,status:NativeMemoryNoteQuerySchema.shape.status,after:afterSchema});
const databasePage=z.strictObject({scope:NativeMemoryNoteScopeSchema,items:z.array(NativeMemoryNoteSummarySchema).max(50),next:afterSchema.nullable()});
const scope=(actor:ActorContext,siteId:string)=>({environment:actor.environment,organizationId:actor.organizationId,siteId});
function errorResult(error:unknown):never {
 if(error instanceof DomainError)throw error;
 const code=typeof error==='object'&&error!==null&&'code' in error?error.code:null;
 const known={NM001:['FORBIDDEN',403,'Current note access is required.'],ND001:['FORBIDDEN',403,'Current note access is required.'],
  NM002:['NOT_FOUND',404,'This note is unavailable.'],NM003:['IDEMPOTENCY_CONFLICT',409,'This saved update belongs to another request.'],
  NM004:['VALIDATION_FAILED',422,'Check the note details.'],NM005:['VERSION_CONFLICT',409,'This note changed. Review the current version before updating.'],
  NM006:['MEMORY_UNAVAILABLE',409,'This note is unavailable for future work.'],NM007:['MEMORY_LIMIT',409,'The note service reached its current limit.'],
  NM008:['EVIDENCE_STALE',409,'Check current access and the review deadline before continuing.'],NM009:['MEMORY_INTEGRITY',409,'The note could not be verified.']} as const;
 if(typeof code==='string'&&Object.hasOwn(known,code)){const [name,status,message]=known[code as keyof typeof known];throw new DomainError(name,status,message);}
 throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The saved update has not been confirmed. Check the original request before starting another.');
}
export class PostgresNativeMemoryNotesRepository implements NativeMemoryNotesRepository {
 constructor(private readonly pool:Pool,private readonly environment:Environment){EnvironmentSchema.parse(environment);}
 private actor(input:ActorContext,siteId:string){
  const actor=ActorContextSchema.parse(input);IdSchema.parse(siteId);
  if(actor.environment!==this.environment||actor.principalKind!=='human'||!actor.siteIds.includes(siteId))throw new DomainError('FORBIDDEN',403,'Current note access is required.');
  return actor;
 }
 private async call<T>(sql:string,values:unknown[],schema:z.ZodType<T>):Promise<T>{
  try{const r=await this.pool.query<{response:unknown}>(sql,values);if(r.rows.length!==1)throw new Error('Missing note result');return schema.parse(r.rows[0]?.response);}catch(error){return errorResult(error);}
 }
 private checkScope(actual:unknown,actor:ActorContext,siteId:string){
  if(JSON.stringify(NativeMemoryNoteScopeSchema.parse(actual))!==JSON.stringify(scope(actor,siteId)))throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The note response could not be confirmed.');
 }
 async list(inputActor:ActorContext,input:NativeMemoryNoteQuery):Promise<NativeMemoryNotePage>{
  const q=NativeMemoryNoteQuerySchema.parse(input),actor=this.actor(inputActor,q.siteId);let after:z.infer<typeof afterSchema>|null=null;
  if(q.cursor){try{
   const bytes=Buffer.from(q.cursor,'base64url');if(bytes.toString('base64url')!==q.cursor)throw new Error();
   const cursor=cursorSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
   this.checkScope(cursor.scope,actor,q.siteId);if(cursor.actorId!==actor.actorId||cursor.status!==q.status)throw new Error();after=cursor.after;
  }catch{throw new DomainError('VALIDATION_FAILED',422,'Refresh the note list to continue.');}}
  const page=await this.call('SELECT pactwoven.native_memory_notes_list($1::jsonb,$2::jsonb) AS response',
   [JSON.stringify(actor),JSON.stringify({siteId:q.siteId,status:q.status,limit:q.limit,after})],databasePage);
  this.checkScope(page.scope,actor,q.siteId);
  if(page.items.length>q.limit||new Set(page.items.map(n=>n.id)).size!==page.items.length||page.next&&after&&page.next.id===after.id)throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The note page could not be confirmed.');
  const nextCursor=page.next===null?null:Buffer.from(JSON.stringify({v:1,scope:page.scope,actorId:actor.actorId,status:q.status,after:page.next})).toString('base64url');
  return NativeMemoryNotePageSchema.parse({scope:page.scope,items:page.items,nextCursor});
 }
 async get(inputActor:ActorContext,siteId:string,noteId:string):Promise<NativeMemoryNoteResponse>{
  const actor=this.actor(inputActor,siteId),id=IdSchema.parse(noteId);
  const result=await this.call('SELECT pactwoven.native_memory_notes_get($1::jsonb,$2,$3) AS response',[JSON.stringify(actor),siteId,id],NativeMemoryNoteResponseSchema);
  this.checkScope(result.scope,actor,siteId);if(result.note.id!==id)throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The note response could not be confirmed.');return result;
 }
 async command(inputActor:ActorContext,key:string,input:NativeMemoryNoteCommand):Promise<NativeMemoryNoteOperation>{
  const command=NativeMemoryNoteCommandSchema.parse(input),actor=this.actor(inputActor,command.siteId);
  const result=await this.call('SELECT pactwoven.native_memory_notes_command($1::jsonb,$2,$3::jsonb) AS response',
   [JSON.stringify(actor),IdempotencyKeySchema.parse(key),JSON.stringify(command)],NativeMemoryNoteOperationSchema);
  this.checkScope(result.scope,actor,command.siteId);
  if(result.action!==command.kind||(command.kind!=='remember'&&result.noteId!==command.noteId)||(result.current!==null&&result.current.id!==result.noteId))
   throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The saved update could not be confirmed.');return result;
 }
 async recover(inputActor:ActorContext,siteId:string,key:string):Promise<NativeMemoryNoteOperation|null>{
  const actor=this.actor(inputActor,siteId);const result=await this.call('SELECT pactwoven.native_memory_notes_recover($1::jsonb,$2,$3) AS response',
   [JSON.stringify(actor),siteId,IdempotencyKeySchema.parse(key)],NativeMemoryNoteOperationSchema.nullable());
  if(result!==null){this.checkScope(result.scope,actor,siteId);if(result.current!==null&&result.current.id!==result.noteId)throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The saved update could not be confirmed.');}return result;
 }
}
