import { custodyPrivateCommand as privateCommand, custodyMessageHash, validateCustodyApiOperation, validateCustodyApiMutationResponse,
 type CustodyPublicRequest as Request } from './financial-worker-result.js';
export { validateCustodyApiOperation, validateCustodyApiMutationResponse } from './financial-worker-result.js';
import {z} from 'zod';
import {CustodyPrepareHttpSchema,CustodyChallengeHttpSchema,CustodyConfirmationHttpSchema,CustodyConfirmHttpSchema,CustodyCancelHttpSchema,
 CustodyReadSchema,CustodyRefSchema,CustodySetupSpecificationSchema,
 CustodyUuidSchema,IdSchema,CustodyApiRecoveryQuerySchema,CustodyApiMutationResponseSchema,CustodyApiReadResponseSchema,CustodyApiRecoveryResponseSchema,
 CustodyApiRecoveryContextSchema,type CustodyApiRecoveryContext,
 type CustodyApiMutationResponse,type CustodyApiReadResponse,type CustodyApiRecoveryResponse,type CustodyCommand,type CustodyResult,type CustodyRecord,type CustodySetupSpecification} from '@pactwoven/contracts';
import {CustodyAuthEvidenceSchema,CustodyPrivateRecordSchema,CustodyOriginalOperationSchema,
 type CustodySetupReaders,type CustodySetupRepository,type CustodyAuthEvidence} from '@pactwoven/db';
import {canonicalJson,commandDigest,custodyRecordHash,custodySpecificationHash,custodyWalletChallengeBytes,DomainError,type ErrorStatus} from '@pactwoven/domain';
import {CustodyApiOwnerScopeSchema,custodyApiSignatureHash,type CustodyApiOwnerScope,type CustodyApiObservation,type CustodyApiVerifier} from './custody-setup-verifier.js';

type Ref=z.infer<typeof CustodyRefSchema>;
export {CustodyApiRecoveryQuerySchema,CustodyApiMutationResponseSchema,CustodyApiReadResponseSchema,CustodyApiRecoveryResponseSchema} from '@pactwoven/contracts';
export type {CustodyApiMutationResponse,CustodyApiReadResponse,CustodyApiRecoveryResponse} from '@pactwoven/contracts';
/** Share private read inputs, but validate untrusted adapter results at this boundary. */
export interface CustodyApiReaders {
 resolveOwner(...args:Parameters<CustodySetupReaders['resolveOwner']>):Promise<unknown>;
 specification(...args:Parameters<CustodySetupReaders['specification']>):Promise<unknown>;
 record(...args:Parameters<CustodySetupReaders['record']>):Promise<unknown>;
 original(...args:Parameters<CustodySetupReaders['original']>):Promise<unknown>;
}
export type CustodyApiDependencies={verifier:CustodyApiVerifier;repository:CustodySetupRepository;readers:CustodyApiReaders;
 authentication:{append(evidence:CustodyAuthEvidence,challenge?:Extract<CustodyRecord,{kind:'wallet_challenge'}>):Promise<Ref>}};
export interface CustodySetupGateway {
 recoveryContext(token:string,responsibilityId:string,trace:string):Promise<CustodyApiRecoveryContext>;
 prepare(token:string,responsibilityId:string,input:unknown,trace:string):Promise<CustodyApiMutationResponse>;
 challenge(token:string,responsibilityId:string,setupId:string,input:unknown,trace:string):Promise<CustodyApiMutationResponse>;
 confirmation(token:string,responsibilityId:string,setupId:string,input:unknown,trace:string):Promise<CustodyApiMutationResponse>;
 confirm(token:string,responsibilityId:string,setupId:string,input:unknown,trace:string):Promise<CustodyApiMutationResponse>;
 cancel(token:string,responsibilityId:string,setupId:string,input:unknown,trace:string):Promise<CustodyApiMutationResponse>;
 get(token:string,responsibilityId:string,setupId:string,trace:string):Promise<CustodyApiReadResponse>;
 recover(token:string,responsibilityId:string,input:unknown,trace:string):Promise<CustodyApiRecoveryResponse>;
}

type Context={observation:CustodyApiObservation;scope:CustodyApiOwnerScope;identityEvidenceId:string;identityEvidence:Ref};
const unknown=()=>new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'The original setup result could not be confirmed. Check the same request key.');
const conflict=()=>new DomainError('CUSTODY_KEY_CONFLICT',409,'This key belongs to a different setup request. Preserve its original result.');
const changed=()=>new DomainError('CUSTODY_SCOPE_CHANGED',409,'The setup review changed. Refresh its exact original record.');
const notFound=()=>new DomainError('NOT_FOUND',404,'The setup record was not found.');
const safeErrors:Record<string,[ErrorStatus,string]>={
 AUTH_REQUIRED:[401,'Sign in again to continue.'],FORBIDDEN:[403,'Current access is required.'],STEP_UP_REQUIRED:[403,'Fresh verification of both factors is required.'],
 IDENTITY_UNAVAILABLE:[503,'Identity verification is temporarily unavailable.'],SETUP_REQUIRED:[503,'Custody setup is not configured.'],
 CUSTODY_ACCESS_DENIED:[403,'Current owner and site access are required.'],CUSTODY_SCOPE_CHANGED:[409,'The exact setup scope changed.'],
 CUSTODY_EXPIRED:[409,'The setup verification expired. Check the original request.'],CUSTODY_KEY_CONFLICT:[409,'The key is bound to another exact request.'],
 CUSTODY_INPUT_INVALID:[422,'Check the exact custody setup request.'],CUSTODY_OUTCOME_UNKNOWN:[503,'The original setup result is unconfirmed. Check the same request key.'],
 UNSAFE_DATABASE_ROLE:[503,'Custody setup is temporarily unavailable.'],NOT_FOUND:[404,'Resource not found.'],BODY_TOO_LARGE:[413,'The setup request exceeds its size limit.'],
 UNSUPPORTED_MEDIA_TYPE:[415,'Send an uncompressed JSON request.'],REQUEST_TIMEOUT:[408,'The setup request body took too long.'],VALIDATION_FAILED:[422,'Check the custody setup request.'],
};
export function safeCustodyApiError(error:unknown):DomainError {
 if(error instanceof z.ZodError)return new DomainError('CUSTODY_INPUT_INVALID',422,'Check the custody setup request.');
 if(error instanceof DomainError&&safeErrors[error.code]){const [status,message]=safeErrors[error.code]!;return new DomainError(error.code,status,message);}
 return unknown();
}

async function result(input:unknown,scope:CustodyApiOwnerScope,command:CustodyCommand):Promise<CustodyResult>{
 const r=await validateCustodyApiOperation(input,command);
 if(r.organizationId!==scope.organizationId||r.actorId!==scope.owner.actorId||r.responsibilityId!==scope.responsibilityId)throw unknown();return r;
}

export function createCustodySetupService(dependencies:CustodyApiDependencies):CustodySetupGateway {
 const verifier:CustodyApiVerifier={observe:dependencies.verifier.observe.bind(dependencies.verifier),assertFresh:dependencies.verifier.assertFresh.bind(dependencies.verifier),
  identityEvidence:dependencies.verifier.identityEvidence.bind(dependencies.verifier),walletEvidence:dependencies.verifier.walletEvidence.bind(dependencies.verifier),mfaEvidence:dependencies.verifier.mfaEvidence.bind(dependencies.verifier)};
 const repository={mutate:dependencies.repository.mutate.bind(dependencies.repository),get:dependencies.repository.get.bind(dependencies.repository),recover:dependencies.repository.recover.bind(dependencies.repository)};
 const readers={resolveOwner:dependencies.readers.resolveOwner.bind(dependencies.readers),specification:dependencies.readers.specification.bind(dependencies.readers),record:dependencies.readers.record.bind(dependencies.readers),original:dependencies.readers.original.bind(dependencies.readers)};
 const authentication={append:dependencies.authentication.append.bind(dependencies.authentication)};
 const fresh=(c:Pick<Context,'observation'|'scope'>)=>verifier.assertFresh(structuredClone(c.observation),structuredClone(c.scope));
 async function append(evidence:CustodyAuthEvidence,c:Pick<Context,'observation'|'scope'>,challenge?:Extract<CustodyRecord,{kind:'wallet_challenge'}>):Promise<Ref>{
  const snapshot=CustodyAuthEvidenceSchema.parse(evidence),hash=await commandDigest({namespace:'pactwoven:custody-auth-evidence:v1',record:snapshot}),id=snapshot.id;
  fresh(c);const r=CustodyRefSchema.safeParse(await authentication.append(structuredClone(snapshot),challenge?structuredClone(challenge):undefined));fresh(c);if(!r.success||r.data.id!==id||r.data.version!==1||r.data.recordHash!==hash)throw unknown();return r.data;
 }
 async function ownerContext(token:string,responsibilityId:string,trace:string):Promise<Pick<Context,'observation'|'scope'>>{
  const observation=structuredClone(await verifier.observe(token)),parsed=CustodyApiOwnerScopeSchema.safeParse(await readers.resolveOwner(structuredClone(observation),responsibilityId,trace));if(!parsed.success)throw unknown();const scope=parsed.data;
  if(scope.responsibilityId!==responsibilityId||scope.externalOrganizationId!==observation.identity.externalOrganizationId)throw unknown();const c={observation,scope};fresh(c);
  return c;
 }
 async function context(token:string,responsibilityId:string,trace:string):Promise<Context>{
  const c=await ownerContext(token,responsibilityId,trace);
  const evidence=verifier.identityEvidence(structuredClone(c.observation),structuredClone(c.scope)),stored=await append(evidence,c);return {...c,identityEvidenceId:stored.id,identityEvidence:stored};
 }
 async function specification(c:Context,reference:Ref,trace:string):Promise<CustodySetupSpecification>{
  fresh(c);const raw=await readers.specification(c.identityEvidenceId,structuredClone(c.scope),structuredClone(reference),trace);fresh(c);if(raw===null)throw notFound();const s=CustodySetupSpecificationSchema.safeParse(raw);
  if(!s.success||s.data.organization.id!==c.scope.organizationId||s.data.responsibility.id!==c.scope.responsibilityId||s.data.owner.actorId!==c.scope.owner.actorId||
   s.data.id!==reference.id||s.data.version!==reference.version||await custodySpecificationHash(s.data)!==reference.recordHash)throw unknown();return s.data;
 }
 async function record(c:Context,setupId:string,id:string,kind:'wallet_challenge'|'confirmation',trace:string){
  fresh(c);const raw=await readers.record(c.identityEvidenceId,structuredClone(c.scope),{setupId,id,kind},trace);fresh(c);if(raw===null)throw notFound();
  const parsed=CustodyPrivateRecordSchema.safeParse(raw);if(!parsed.success)throw unknown();const r=parsed.data;
  if(r.record.id!==id||r.record.kind!==kind||r.record.setupId!==setupId||r.record.organizationId!==c.scope.organizationId||r.record.responsibilityId!==c.scope.responsibilityId||
   r.record.actorId!==c.scope.owner.actorId||r.reference.id!==id||r.reference.version!==r.record.version||r.reference.recordHash!==await custodyRecordHash(r.record))throw unknown();return r;
 }
 async function original(c:Context,kind:Request['kind'],key:string,trace:string){
  fresh(c);const raw=await readers.original(c.identityEvidenceId,structuredClone(c.scope),{kind,key},trace);fresh(c);if(raw===null)return null;
  const parsed=CustodyOriginalOperationSchema.safeParse(raw);if(!parsed.success)throw unknown();const r=await result(parsed.data.result,c.scope,parsed.data.command);
  if(r.kind!==kind||r.key!==key||parsed.data.command.responsibilityId!==c.scope.responsibilityId)throw unknown();await linkedResult(c,parsed.data.command,r,trace);return {command:parsed.data.command,result:r};
 }
 async function linkedResult(c:Context,command:CustodyCommand,r:CustodyResult,trace:string):Promise<void>{
  const b=r.body;
  if(command.kind==='confirmation'&&b.kind==='confirmation'){
   const stored=await record(c,r.setupId,b.id,'confirmation',trace);if(canonicalJson(stored.record)!==canonicalJson(b))throw unknown();
   const ch=await record(c,r.setupId,command.challengeId,'wallet_challenge',trace);if(ch.record.kind!=='wallet_challenge')throw unknown();
   if(canonicalJson(b.draft)!==canonicalJson(ch.record.draft)||canonicalJson(b.intent.challenge)!==canonicalJson(ch.reference)||
    canonicalJson(b.intent.specification)!==canonicalJson(ch.record.specification)||canonicalJson(b.intent.owner)!==canonicalJson(ch.record.owner))throw unknown();
  }
  if(command.kind==='confirm'&&b.kind==='owner_binding'){
   const cf=await record(c,r.setupId,command.confirmationId,'confirmation',trace);if(cf.record.kind!=='confirmation')throw unknown();const confirmation=cf.record;
   if(confirmation.intent.key!==command.key||confirmation.intent.nonce!==command.confirmationNonce||canonicalJson(b.confirmation)!==canonicalJson(cf.reference)||
    canonicalJson(b.draft)!==canonicalJson(confirmation.draft)||canonicalJson(b.challenge)!==canonicalJson(confirmation.intent.challenge)||
    canonicalJson(b.walletEvidence)!==canonicalJson(confirmation.walletEvidence)||b.signatureHash!==confirmation.intent.signatureHash||
    canonicalJson(b.specificationRef)!==canonicalJson(confirmation.intent.specification)||canonicalJson(b.specification.owner)!==canonicalJson(confirmation.intent.owner))throw unknown();
   const prep=await original(c,'prepare',b.prepareOperation.key,trace);
   if(!prep||prep.result.setupId!==r.setupId||prep.result.body.kind!=='draft'||canonicalJson(b.draft)!==canonicalJson(prep.result.target)||
    canonicalJson(b.prepareOperation)!==canonicalJson({id:prep.result.id,key:prep.result.key,commandHash:prep.result.commandHash})||
    canonicalJson(b.specificationRef)!==canonicalJson(prep.result.body.specification)||b.specificationControlGeneration!==prep.result.body.specificationControlGeneration)throw unknown();
  }
 }
 function matchesPublic(request:Request,old:{command:CustodyCommand;result:CustodyResult}){
  const proofId=old.command.kind==='confirmation'?old.command.walletEvidenceId:old.command.kind==='confirm'?old.command.mfaEvidenceId:undefined;
  if(canonicalJson(privateCommand(request,proofId))!==canonicalJson(old.command))throw conflict();
  if(request.kind==='confirmation'){
   if(old.result.body.kind!=='confirmation'||old.result.body.intent.signatureHash!==custodyApiSignatureHash(request.body.walletSignature)||
    old.result.body.intent.challenge.id!==request.body.challengeId||old.result.body.intent.challenge.recordHash!==request.body.challengeHash||
    old.result.body.walletEvidence.id!==proofId)throw conflict();
  }
  if(request.kind==='confirm'){
   if(old.result.body.kind!=='owner_binding'||old.result.body.signatureHash!==custodyApiSignatureHash(request.body.walletSignature)||old.result.body.challenge.id!==request.body.challengeId||
    old.result.body.challenge.recordHash!==request.body.challengeHash||old.result.body.confirmation.id!==request.body.confirmationId||old.result.body.mfaEvidence.id!==proofId)throw conflict();
  }
 }
 async function response(c:Context,r:CustodyResult,request:Request,trace:string):Promise<CustodyApiMutationResponse>{
  const review=r.body.kind==='draft'||r.body.kind==='wallet_challenge'?await specification(c,r.body.specification,trace):null;
  const bytes=r.body.kind==='wallet_challenge'?Buffer.from(custodyWalletChallengeBytes(r.body)):null;
  return validateCustodyApiMutationResponse({schemaVersion:1,operation:r,review,message:bytes?{bytes:bytes.toString('base64'),messageHash:custodyMessageHash(bytes)}:null},r.kind,r.responsibilityId,r.key,r.setupId,request.body);
 }
 async function mutate(token:string,request:Request,trace:string):Promise<CustodyApiMutationResponse>{
  const c=await context(token,request.responsibilityId,trace),old=await original(c,request.kind,request.body.key,trace);
  if(old){matchesPublic(request,old);return response(c,old.result,request,trace);}
  let mutation:CustodyCommand,appendedProof:Ref|undefined;
  if(request.kind==='confirmation'||request.kind==='confirm'){
   const ch=await record(c,request.setupId,request.body.challengeId,'wallet_challenge',trace);if(ch.record.kind!=='wallet_challenge')throw unknown();
   if(ch.reference.recordHash!==request.body.challengeHash||ch.record.draft.version!==request.body.expectedSetupVersion||ch.record.draft.recordHash!==request.body.expectedSetupHash)throw changed();
   const wallet=await verifier.walletEvidence(structuredClone(c.observation),structuredClone(c.scope),structuredClone(ch.record),request.body.walletSignature);fresh(c);
   if(request.kind==='confirmation'){const ref=await append(wallet,c,ch.record);appendedProof=ref;mutation=privateCommand(request,ref.id);}
   else{
    const cf=await record(c,request.setupId,request.body.confirmationId,'confirmation',trace);if(cf.record.kind!=='confirmation')throw unknown();
    if(canonicalJson(cf.record.intent.challenge)!==canonicalJson(ch.reference)||cf.record.intent.signatureHash!==wallet.signatureHash||cf.record.intent.key!==request.body.key||cf.record.intent.nonce!==request.body.confirmationNonce||
     cf.record.draft.version!==request.body.expectedSetupVersion||cf.record.draft.recordHash!==request.body.expectedSetupHash)throw changed();
    const mfa=await verifier.mfaEvidence(token,structuredClone(c.observation),structuredClone(c.scope),structuredClone(cf.record));fresh(c);
    const ref=await append(mfa,c);appendedProof=ref;mutation=privateCommand(request,ref.id);
   }
  }else {
   if(request.kind==='prepare'){const s=await specification(c,request.body.reviewedSpecificationRef,trace);
    const expected={responsibilityVersion:s.responsibility.version,responsibilityHash:s.responsibility.hash,siteGeneration:s.site.generation,siteRecordHash:s.site.recordHash,canonicalGeneration:s.authority.snapshot.generation,canonicalHash:s.authority.recordHash};
    if(canonicalJson(s.owner)!==canonicalJson(c.scope.owner)||s.ownerWalletPublicKey!==request.body.ownerWalletPublicKey||canonicalJson(expected)!==canonicalJson(request.body.expectedScope))throw changed();}
   mutation=privateCommand(request);
  }
  fresh(c);
  try{
   const r=await result(await repository.mutate(c.identityEvidenceId,structuredClone(mutation)),c.scope,mutation);
   if(r.body.kind==='confirmation'&&canonicalJson(r.body.walletEvidence)!==canonicalJson(appendedProof))throw unknown();
   if(r.body.kind==='owner_binding'&&(canonicalJson(r.body.mfaEvidence)!==canonicalJson(appendedProof)||canonicalJson(r.body.identityEvidence)!==canonicalJson(c.identityEvidence)))throw unknown();
   await linkedResult(c,mutation,r,trace);return await response(c,r,request,trace);
  }
  catch(error){
   // Concurrent public duplicates may have created different unused proofs. Recover the committed original; never replace its IDs.
   if(error instanceof DomainError&&error.code==='CUSTODY_KEY_CONFLICT'){
    const winner=await original(c,request.kind,request.body.key,trace);if(winner){matchesPublic(request,winner);return response(c,winner.result,request,trace);}
   }
   throw error;
  }
 }
 const guarded=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work();}catch(error){throw error instanceof z.ZodError?unknown():safeCustodyApiError(error);}};
 const parseInput=<T>(schema:z.ZodType<T>,value:unknown):T=>{const parsed=schema.safeParse(value);if(!parsed.success)throw new DomainError('CUSTODY_INPUT_INVALID',422,'Check the custody setup request.');return parsed.data;};
 const id=(v:string)=>parseInput(IdSchema,v),sid=(v:string)=>parseInput(CustodyUuidSchema,v);
 return {
  recoveryContext:(token,rid,trace)=>guarded(async()=>{
   const c=await ownerContext(token,id(rid),trace);
   const observedAt=new Date(Math.min(Date.parse(c.observation.observation.observedAt),Date.parse(c.observation.identity.membershipObservedAt))).toISOString();
   const expiresAt=new Date(Math.min(Date.parse(c.observation.observation.expiresAt),Date.parse(observedAt)+20000)).toISOString();
   const response=CustodyApiRecoveryContextSchema.parse({schemaVersion:1,...c.scope,observedAt,expiresAt});
   fresh(c);return response;
  }),
  prepare:(token,rid,input,trace)=>guarded(()=>mutate(token,{kind:'prepare',responsibilityId:id(rid),body:parseInput(CustodyPrepareHttpSchema,input)},trace)),
  challenge:(token,rid,setupId,input,trace)=>guarded(()=>mutate(token,{kind:'challenge',responsibilityId:id(rid),setupId:sid(setupId),body:parseInput(CustodyChallengeHttpSchema,input)},trace)),
  confirmation:(token,rid,setupId,input,trace)=>guarded(()=>mutate(token,{kind:'confirmation',responsibilityId:id(rid),setupId:sid(setupId),body:parseInput(CustodyConfirmationHttpSchema,input)},trace)),
  confirm:(token,rid,setupId,input,trace)=>guarded(()=>mutate(token,{kind:'confirm',responsibilityId:id(rid),setupId:sid(setupId),body:parseInput(CustodyConfirmHttpSchema,input)},trace)),
  cancel:(token,rid,setupId,input,trace)=>guarded(()=>mutate(token,{kind:'cancel',responsibilityId:id(rid),setupId:sid(setupId),body:parseInput(CustodyCancelHttpSchema,input)},trace)),
  get:(token,rid,setupId,trace)=>guarded(async()=>{const responsibilityId=id(rid),setup=sid(setupId),c=await context(token,responsibilityId,trace),raw=await repository.get(c.identityEvidenceId,responsibilityId,setup);fresh(c);if(raw===null)throw notFound();const parsed=CustodyReadSchema.safeParse(raw);if(!parsed.success)throw unknown();const r=parsed.data;
   if(r.setupId!==setup||r.draft.setupId!==setup||r.draft.organizationId!==c.scope.organizationId||r.draft.actorId!==c.scope.owner.actorId||r.draft.responsibilityId!==responsibilityId||r.draftHash!==await custodyRecordHash(r.draft)||
    (r.binding&&(r.binding.setupId!==setup||r.binding.organizationId!==c.scope.organizationId||r.binding.actorId!==c.scope.owner.actorId||r.binding.responsibilityId!==responsibilityId)))throw unknown();
   const review=await specification(c,r.draft.specification,trace);
   if(r.binding&&(canonicalJson(r.binding.draft)!==canonicalJson({id:r.draft.id,version:r.draft.version,recordHash:r.draftHash})||canonicalJson(r.binding.specification)!==canonicalJson(review)||canonicalJson(r.binding.specificationRef)!==canonicalJson(r.draft.specification)))throw unknown();
   if((r.state==='confirmed'&&!r.binding)||(r.state==='pending'&&r.binding))throw unknown();
   return CustodyApiReadResponseSchema.parse({schemaVersion:1,setup:r,review});
  }),
  recover:(token,rid,input,trace)=>guarded(async()=>{const responsibilityId=id(rid),query=parseInput(CustodyApiRecoveryQuerySchema,input),c=await context(token,responsibilityId,trace),old=await original(c,query.kind,query.key,trace);
   return CustodyApiRecoveryResponseSchema.parse({schemaVersion:1,organizationId:c.scope.organizationId,actorId:c.scope.owner.actorId,responsibilityId,...query,status:old?'recorded':'not_recorded',operation:old?.result??null});
  }),
 };
}
