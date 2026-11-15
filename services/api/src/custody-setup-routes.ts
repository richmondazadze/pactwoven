import type {Context,Hono} from 'hono';
import {CustodyPrepareHttpSchema,CustodyChallengeHttpSchema,CustodyConfirmationHttpSchema,CustodyConfirmHttpSchema,CustodyCancelHttpSchema,
 custodyHttpBodyLimits,CustodyUuidSchema,IdSchema,IdempotencyKeySchema} from '@pactwoven/contracts';
import {custodyRecordHash,custodySpecificationHash,canonicalJson,DomainError} from '@pactwoven/domain';
import type {ApiEnv} from './app.js';
import {CustodyApiReadResponseSchema,CustodyApiRecoveryQuerySchema,CustodyApiRecoveryResponseSchema,
 safeCustodyApiError,validateCustodyApiOperation,validateCustodyApiMutationResponse,type CustodySetupGateway} from './custody-setup-service.js';

const parsedBodies=new WeakMap<object,number>();
const bodyDeadlineMs=5000;
const invalid=()=>new DomainError('CUSTODY_INPUT_INVALID',422,'A strict JSON object is required.');
/** The root app must choose this reader before its generic body reader consumes the stream. */
export function custodySetupBodyLimit(method:string,path:string):number|undefined {
 if(method!=='POST')return undefined;
 if(/^\/v1\/responsibilities\/[^/]+\/custody-setups$/.test(path))return custodyHttpBodyLimits.prepare;
 const suffix=/^\/v1\/responsibilities\/[^/]+\/custody-setups\/[^/]+\/(owner-challenge|owner-confirmation-challenge|confirm-owner|cancel)$/.exec(path)?.[1];
 return suffix==='owner-challenge'?custodyHttpBodyLimits.challenge:suffix==='owner-confirmation-challenge'?custodyHttpBodyLimits.confirmation:suffix==='confirm-owner'?custodyHttpBodyLimits.confirm:suffix==='cancel'?custodyHttpBodyLimits.cancel:undefined;
}
/** Walk JSON syntax without losing duplicate keys (including escaped aliases) to JSON.parse. */
function strictObject(text:string):object {
 let at=0,tokens=0;
 const whitespace=()=>{while(at<text.length&&/[\u0020\t\r\n]/.test(text[at]!))at++;};
 function string():string {const start=at;if(text[at++]!=='"')throw invalid();let escaped=false;
  while(at<text.length){const c=text[at++]!;if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c==='"'){try{return JSON.parse(text.slice(start,at)) as string;}catch{throw invalid();}}}throw invalid();}
 function value(depth:number):void {
  if(depth>16||++tokens>256)throw invalid();whitespace();const c=text[at];
  if(c==='{'){at++;whitespace();const keys=new Set<string>();if(text[at]==='}'){at++;return;}
   for(;;){whitespace();const key=string();if(keys.has(key)||keys.size>=64)throw invalid();keys.add(key);whitespace();if(text[at++]!==':')throw invalid();value(depth+1);whitespace();if(text[at]==='}'){at++;return;}if(text[at++]!==',')throw invalid();}
  }
  if(c==='['){at++;whitespace();let count=0;if(text[at]===']'){at++;return;}for(;;){if(++count>64)throw invalid();value(depth+1);whitespace();if(text[at]===']'){at++;return;}if(text[at++]!==',')throw invalid();}}
  if(c==='"'){string();return;}
  for(const literal of ['true','false','null'])if(text.startsWith(literal,at)){at+=literal.length;return;}
  const number=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
  if(!number||number.index!==0||!Number.isFinite(Number(number[0])))throw invalid();at+=number[0].length;
 }
 value(0);whitespace();if(at!==text.length)throw invalid();let parsed:unknown;try{parsed=JSON.parse(text);}catch{throw invalid();}
 if(typeof parsed!=='object'||parsed===null||Array.isArray(parsed))throw invalid();return parsed;
}
export async function readCustodySetupJson(request:Request,maximumBytes:number):Promise<unknown> {
 if(!(Object.values(custodyHttpBodyLimits) as number[]).includes(maximumBytes))throw new DomainError('SETUP_REQUIRED',503,'Custody body limits are not configured.');
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get('content-type')??'')||
  !['','identity'].includes((request.headers.get('content-encoding')??'').toLowerCase()))throw new DomainError('UNSUPPORTED_MEDIA_TYPE',415,'Send uncompressed UTF-8 JSON.');
 const length=request.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>maximumBytes))throw new DomainError('BODY_TOO_LARGE',413,'The setup request exceeds its size limit.');
 const reader=request.body?.getReader();if(!reader)throw invalid();let bytes=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DomainError('REQUEST_TIMEOUT',408,'The setup body took too long.')),bodyDeadlineMs);});
 try{for(;;){const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done)break;if(!(chunk.value instanceof Uint8Array))throw invalid();bytes+=chunk.value.byteLength;if(bytes>maximumBytes)throw new DomainError('BODY_TOO_LARGE',413,'The setup request exceeds its size limit.');text+=decoder.decode(chunk.value,{stream:true});}
  text+=decoder.decode();const parsed=strictObject(text);parsedBodies.set(parsed,bytes);return parsed;
 }catch(error){void reader.cancel().catch(()=>{});if(error instanceof DomainError)throw error;throw invalid();}
 finally{clearTimeout(timer);reader.releaseLock();}
}
const token=(value:string|undefined)=>{const parsed=/^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(value??'')?.[1];if(!parsed)throw new DomainError('AUTH_REQUIRED',401,'Sign in again.');return parsed;};
function noQuery(url:string){if(new URL(url).search)throw invalid();}
function trace(c:Context<ApiEnv>){return c.get('correlationId')??crypto.randomUUID();}
async function body(c:Context<ApiEnv>,maximum:number){const input=c.get('requestBody');
 if(input===undefined&&!c.req.raw.bodyUsed)return readCustodySetupJson(c.req.raw,maximum);
 if(typeof input!=='object'||input===null||!parsedBodies.has(input))throw new DomainError('SETUP_REQUIRED',503,'The custody body reader must run before generic JSON parsing.');
 if(parsedBodies.get(input)!>maximum)throw new DomainError('BODY_TOO_LARGE',413,'The setup request exceeds its size limit.');return input;
}
export function registerCustodySetupRoutes(app:Hono<ApiEnv>,gateway:CustodySetupGateway|undefined):void {
 const service=()=>{if(!gateway)throw new DomainError('SETUP_REQUIRED',503,'Custody setup is not configured.');return gateway;};
 const invoke=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work();}catch(error){if(error instanceof DomainError)throw error;throw new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'The private setup response was not verified.');}};
 const run=(work:(c:Context<ApiEnv>)=>Promise<Response>)=>async(c:Context<ApiEnv>)=>{c.header('Cache-Control','private, no-store');c.header('Referrer-Policy','no-referrer');
  try{return await work(c);}catch(error){const safe=safeCustodyApiError(error);return c.json({error:{code:safe.code,message:safe.message,correlationId:trace(c)}},safe.status);}};
 const root='/v1/responsibilities/:id/custody-setups';
 const actions=[['prepare','',CustodyPrepareHttpSchema],['challenge','/:setupId/owner-challenge',CustodyChallengeHttpSchema],
  ['confirmation','/:setupId/owner-confirmation-challenge',CustodyConfirmationHttpSchema],['confirm','/:setupId/confirm-owner',CustodyConfirmHttpSchema],
  ['cancel','/:setupId/cancel',CustodyCancelHttpSchema]] as const;
 for(const [kind,suffix,schema] of actions)app.all(root+suffix,run(async c=>{
  if(c.req.method!=='POST')throw new DomainError('NOT_FOUND',404,'Resource not found.');noQuery(c.req.url);
  const responsibilityId=IdSchema.parse(c.req.param('id')),setupId=kind==='prepare'?undefined:CustodyUuidSchema.parse(c.req.param('setupId'));
  const input=schema.parse(await body(c,custodyHttpBodyLimits[kind])),key=IdempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
  if(key!==input.key)throw invalid();const bearer=token(c.req.header('Authorization')),s=service();
  const raw=await invoke(()=>kind==='prepare'?s.prepare(bearer,responsibilityId,structuredClone(input),trace(c)):s[kind](bearer,responsibilityId,setupId!,structuredClone(input),trace(c)));
  const value=await validateCustodyApiMutationResponse(raw,kind,responsibilityId,key,setupId,input);return c.json(value,kind==='prepare'?201:200);
 }));
 app.all(root+'/operations/:key',run(async c=>{
  if(c.req.method!=='GET')throw new DomainError('NOT_FOUND',404,'Resource not found.');const responsibilityId=IdSchema.parse(c.req.param('id')),key=IdempotencyKeySchema.parse(c.req.param('key'));
  const entries=[...new URL(c.req.url).searchParams];if(entries.length!==1||entries[0]?.[0]!=='kind')throw invalid();
  const query=CustodyApiRecoveryQuerySchema.parse({key,kind:entries[0][1]});const parsed=CustodyApiRecoveryResponseSchema.safeParse(await invoke(()=>service().recover(token(c.req.header('Authorization')),responsibilityId,query,trace(c))));
  if(!parsed.success)throw new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'Recovery was not verified.');const value=parsed.data;
  if(value.responsibilityId!==responsibilityId||value.kind!==query.kind||value.key!==key||(value.status==='recorded')!==(value.operation!==null))throw new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'Recovery was not verified.');
  const operation=value.operation;if(operation&&(operation.organizationId!==value.organizationId||operation.actorId!==value.actorId||operation.responsibilityId!==responsibilityId||operation.kind!==query.kind||operation.key!==key||
   operation.target.recordHash!==await custodyRecordHash(operation.body)||operation.target.id!==operation.body.id||operation.target.version!==operation.body.version||operation.body.setupId!==operation.setupId||
   operation.body.organizationId!==value.organizationId||operation.body.actorId!==value.actorId||operation.body.responsibilityId!==responsibilityId))throw new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'Recovery was not verified.');
  if(operation&&operation.body.kind!==({prepare:'draft',challenge:'wallet_challenge',confirmation:'confirmation',confirm:'owner_binding',cancel:'cancellation'} as const)[operation.kind])throw new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'Recovery was not verified.');
  if(operation)await validateCustodyApiOperation(operation);
  return c.json(value);
 }));
 app.all(root+'/:setupId',run(async c=>{
  if(c.req.method!=='GET')throw new DomainError('NOT_FOUND',404,'Resource not found.');noQuery(c.req.url);const responsibilityId=IdSchema.parse(c.req.param('id')),setupId=CustodyUuidSchema.parse(c.req.param('setupId'));
  const parsed=CustodyApiReadResponseSchema.safeParse(await invoke(()=>service().get(token(c.req.header('Authorization')),responsibilityId,setupId,trace(c))));
  if(!parsed.success)throw new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'The setup read was not verified.');const value=parsed.data,d=value.setup.draft;
  if(value.setup.setupId!==setupId||d.setupId!==setupId||d.responsibilityId!==responsibilityId||value.review.responsibility.id!==responsibilityId||value.review.organization.id!==d.organizationId||
   value.review.owner.actorId!==d.actorId||value.setup.draftHash!==await custodyRecordHash(d)||canonicalJson(d.specification)!==canonicalJson({id:value.review.id,version:value.review.version,recordHash:await custodySpecificationHash(value.review)}))throw new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'The setup read was not verified.');
  const binding=value.setup.binding;if(binding&&(binding.setupId!==setupId||binding.organizationId!==d.organizationId||binding.actorId!==d.actorId||binding.responsibilityId!==responsibilityId||
   canonicalJson(binding.draft)!==canonicalJson({id:d.id,version:d.version,recordHash:value.setup.draftHash})||canonicalJson(binding.specification)!==canonicalJson(value.review)||canonicalJson(binding.specificationRef)!==canonicalJson(d.specification)))throw new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'The setup binding was not verified.');
  if((value.setup.state==='confirmed'&&!binding)||(value.setup.state==='pending'&&binding))throw new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'The setup state was not verified.');
  return c.json(value);
 }));
}
