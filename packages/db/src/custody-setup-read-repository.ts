import type {Pool,PoolClient} from 'pg';
import {CustodyRefSchema,CustodyUuidSchema,IdSchema,CustodySetupSpecificationSchema,CustodyApiRecoveryQuerySchema,type CustodyCommand,type CustodyResult} from '@pactwoven/contracts';
import {canonicalJson,commandDigest,custodyCommandHash,custodyRecordHash,custodySpecificationHash} from '@pactwoven/domain';
import {CustodyReadObservationSchema,CustodyReadOwnerScopeSchema,CustodyPrivateRecordQuerySchema,CustodyPrivateRecordSchema,CustodyOriginalOperationSchema,
 type CustodySetupReaders,type CustodyReadObservation,type CustodyReadOwnerScope,type CustodyPrivateRecordQuery,type CustodyOriginalOperation} from './custody-setup-read-schema.js';
import {custodyTransaction,custodyOutcomeUnknown} from './custody-setup-repository.js';

function capturedPool(pool:Pool):Pool {
 const connect=pool.connect.bind(pool);
 return {connect:async()=>{const client=await connect(),query=client.query.bind(client),release=client.release.bind(client);
  return {query,release} as PoolClient;}} as Pool;
}
function one(rows:unknown[]):unknown {if(rows.length!==1||typeof rows[0]!=='object'||rows[0]===null||!('response'in rows[0]))throw custodyOutcomeUnknown();return (rows[0] as {response:unknown}).response;}
const equal=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
async function validateOriginal(input:unknown,scope:CustodyReadOwnerScope,query:{kind:string;key:string}):Promise<CustodyOriginalOperation>{
 const parsed=CustodyOriginalOperationSchema.safeParse(input);if(!parsed.success)throw custodyOutcomeUnknown();const {command:c,result:r}=parsed.data,b=r.body;
 if(r.organizationId!==scope.organizationId||r.actorId!==scope.owner.actorId||r.responsibilityId!==scope.responsibilityId||r.kind!==query.kind||r.key!==query.key||
  c.kind!==r.kind||c.key!==r.key||c.responsibilityId!==r.responsibilityId||r.commandHash!==await custodyCommandHash(r.organizationId,r.actorId,c)||
  b.organizationId!==r.organizationId||b.actorId!==r.actorId||b.responsibilityId!==r.responsibilityId||b.setupId!==r.setupId||r.target.id!==b.id||r.target.version!==b.version||r.target.recordHash!==await custodyRecordHash(b)||
  b.kind!==({prepare:'draft',challenge:'wallet_challenge',confirmation:'confirmation',confirm:'owner_binding',cancel:'cancellation'} as const)[c.kind])throw custodyOutcomeUnknown();
 if(c.kind==='prepare'){
  if(b.kind!=='draft'||b.prepareOperationId!==r.id||!equal(b.specification,c.reviewedSpecificationRef)||!equal(b.predecessor,c.previousDraft)||b.version!==(c.previousDraft?c.previousDraft.version+1:1))throw custodyOutcomeUnknown();
 }else if(b.kind==='draft'||r.setupId!==c.setupId||b.draft.version!==c.expectedSetupVersion||b.draft.recordHash!==c.expectedSetupHash)throw custodyOutcomeUnknown();
 if(c.kind==='confirmation'){
  if(b.kind!=='confirmation'||b.walletEvidence.id!==c.walletEvidenceId||b.walletEvidence.version!==1||b.intent.challenge.id!==c.challengeId||b.intent.challenge.recordHash!==c.challengeHash||b.intent.key!==c.confirmationKey||
   b.intent.setupId!==r.setupId||b.intent.organizationId!==r.organizationId||b.intent.responsibilityId!==r.responsibilityId||b.intent.owner.actorId!==r.actorId||
   b.intentHash!==await commandDigest(b.intent)||b.requestHash!==await commandDigest({schemaVersion:1,purpose:'custody_setup_owner_binding',request:{nonce:b.intent.nonce,key:b.intent.key,intent:b.intent}}))throw custodyOutcomeUnknown();
 }
 if(c.kind==='confirm'){
  if(b.kind!=='owner_binding'||b.confirmation.id!==c.confirmationId||b.mfaEvidence.id!==c.mfaEvidenceId||b.identityEvidence.version!==1||b.walletEvidence.version!==1||b.mfaEvidence.version!==1||
   !equal(b.confirmOperation,{id:r.id,key:r.key,commandHash:r.commandHash})||b.specification.organization.id!==r.organizationId||b.specification.responsibility.id!==r.responsibilityId||b.specification.owner.actorId!==r.actorId||
   !equal(b.specificationRef,{id:b.specification.id,version:b.specification.version,recordHash:await custodySpecificationHash(b.specification)}))throw custodyOutcomeUnknown();
 }
 if(c.kind==='cancel'&&(b.kind!=='cancellation'||b.previousControlGeneration!==c.expectedSetupControlGeneration||b.controlGeneration!==c.expectedSetupControlGeneration+1))throw custodyOutcomeUnknown();
 return parsed.data;
}
/** Both pools are required and captured separately; no runtime construction or credentials are inferred. */
export class PostgresCustodySetupReaders implements CustodySetupReaders {
 private readonly writer:Pool;private readonly verifier:Pool;
 constructor(writer:Pool,verifier:Pool){this.writer=capturedPool(writer);this.verifier=capturedPool(verifier);}
 async resolveOwner(input:CustodyReadObservation,responsibilityId:string,_trace:string){
  const observation=CustodyReadObservationSchema.parse(input),rid=IdSchema.parse(responsibilityId);
  return custodyTransaction(this.verifier,'verifier',async c=>{const raw=one((await c.query('SELECT pactwoven.custody_setup_resolve_owner($1::jsonb,$2) AS response',[JSON.stringify(observation),rid])).rows),parsed=CustodyReadOwnerScopeSchema.safeParse(raw);
   if(!parsed.success)throw custodyOutcomeUnknown();const scope=parsed.data,i=observation.identity;
   if(scope.responsibilityId!==rid||scope.externalOrganizationId!==i.externalOrganizationId||scope.owner.subject!==i.subject||scope.owner.externalMembershipId!==i.externalMembershipId||scope.owner.sessionId!==i.sessionId)throw custodyOutcomeUnknown();return scope;
  });
 }
 async specification(identityEvidenceId:string,scopeInput:CustodyReadOwnerScope,reference:Parameters<CustodySetupReaders['specification']>[2],_trace:string){
  const id=CustodyUuidSchema.parse(identityEvidenceId),scope=CustodyReadOwnerScopeSchema.parse(scopeInput),ref=CustodyRefSchema.parse(reference);
  return custodyTransaction(this.writer,'writer',async c=>{const raw=one((await c.query('SELECT pactwoven.custody_setup_specification_read($1,$2,$3::jsonb) AS response',[id,scope.responsibilityId,JSON.stringify(ref)])).rows);if(raw===null)return null;const parsed=CustodySetupSpecificationSchema.safeParse(raw);
   if(!parsed.success)throw custodyOutcomeUnknown();const s=parsed.data;
   if(s.organization.id!==scope.organizationId||s.responsibility.id!==scope.responsibilityId||s.owner.actorId!==scope.owner.actorId||s.id!==ref.id||s.version!==ref.version||await custodySpecificationHash(s)!==ref.recordHash)throw custodyOutcomeUnknown();return s;
  });
 }
 async record(identityEvidenceId:string,scopeInput:CustodyReadOwnerScope,input:CustodyPrivateRecordQuery,_trace:string){
  const id=CustodyUuidSchema.parse(identityEvidenceId),scope=CustodyReadOwnerScopeSchema.parse(scopeInput),q=CustodyPrivateRecordQuerySchema.parse(input);
  return custodyTransaction(this.writer,'writer',async c=>{const raw=one((await c.query('SELECT pactwoven.custody_setup_record_read($1,$2,$3,$4,$5) AS response',[id,scope.responsibilityId,q.setupId,q.id,q.kind])).rows);if(raw===null)return null;const parsed=CustodyPrivateRecordSchema.safeParse(raw);if(!parsed.success)throw custodyOutcomeUnknown();const {record:r,reference:ref}=parsed.data;
   if(r.kind!==q.kind||r.id!==q.id||r.setupId!==q.setupId||r.organizationId!==scope.organizationId||r.responsibilityId!==scope.responsibilityId||r.actorId!==scope.owner.actorId||ref.id!==r.id||ref.version!==r.version||ref.recordHash!==await custodyRecordHash(r))throw custodyOutcomeUnknown();return parsed.data;
  });
 }
 async original(identityEvidenceId:string,scopeInput:CustodyReadOwnerScope,input:Parameters<CustodySetupReaders['original']>[2],_trace:string){
  const id=CustodyUuidSchema.parse(identityEvidenceId),scope=CustodyReadOwnerScopeSchema.parse(scopeInput),q=CustodyApiRecoveryQuerySchema.parse(input);
  return custodyTransaction(this.writer,'writer',async c=>{const raw=one((await c.query('SELECT pactwoven.custody_setup_original_read($1,$2,$3,$4) AS response',[id,scope.responsibilityId,q.kind,q.key])).rows);return raw===null?null:validateOriginal(raw,scope,q);});
 }
}
