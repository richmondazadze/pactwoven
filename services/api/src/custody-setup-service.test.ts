import {describe,expect,it,vi} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {z} from 'zod';
import {Hono} from 'hono';
import type {ApiEnv} from './app.js';
import {registerCustodySetupRoutes} from './custody-setup-routes.js';
import {FINANCE_DEVNET_ASSET,encodeSolanaBase58,CustodySetupSpecificationSchema,type CustodyCommand,type CustodyResult,type CustodyRecord,type CustodyRead} from '@pactwoven/contracts';
import type {CustodyAuthEvidence} from '@pactwoven/db';
import {commandDigest,custodySetupAddresses,custodySpecificationHash,custodyRecordHash,custodyCommandHash,custodyWalletChallengeBytes,DomainError} from '@pactwoven/domain';
import {createCustodyApiVerifier,type CustodyApiOwnerScope} from './custody-setup-verifier.js';
import {createCustodySetupService,validateCustodyApiMutationResponse,type CustodyApiDependencies,type CustodyApiMutationResponse} from './custody-setup-service.js';

const at=Date.parse('2026-11-15T12:00:00.000Z'),iso=(n:number)=>new Date(n).toISOString(),hash='a'.repeat(64),rid='responsibility_a',token='injected-observation',trace='synthetic_trace';
const ref=(id:string)=>({id,version:1,recordHash:hash});
/** In-memory test double only: no connection, provider, signed token or on-chain action. */
async function fixture(){
 let now=at;const keys=generateKeyPairSync('ed25519'),wallet=encodeSolanaBase58(keys.publicKey.export({format:'der',type:'spki'}).subarray(-32));
 const owner={actorId:'owner_a',membershipVersion:1,subject:'user_a',externalMembershipId:'member_a',sessionId:'session_a'};
 const scope:CustodyApiOwnerScope={environment:'development',organizationId:'org_a',externalOrganizationId:'provider_org',responsibilityId:rid,owner};
 const identity={subject:owner.subject,externalOrganizationId:scope.externalOrganizationId,externalOrganizationName:'Synthetic organization',externalMembershipId:owner.externalMembershipId,externalRole:'org:member',membershipObservedAt:iso(at-1000),sessionId:owner.sessionId,authenticatedAt:iso(at-3600000)};
 const observation={identity,observation:{issuer:'https://synthetic.invalid',tokenHash:hash,tokenIssuedAt:iso(at-10000),observedAt:iso(at-500),expiresAt:iso(at+180000)}};
 const factors={identity:structuredClone(identity),evidence:{id:crypto.randomUUID(),subject:owner.subject,externalOrganizationId:scope.externalOrganizationId,externalMembershipId:owner.externalMembershipId,sessionId:owner.sessionId,issuer:observation.observation.issuer,tokenHash:hash,tokenIssuedAt:iso(at-10000),firstFactorAgeMinutes:0,secondFactorAgeMinutes:0,verifiedAt:iso(at-70000),observedAt:iso(at),expiresAt:iso(at+180000)}};
 const observe=vi.fn(async()=>structuredClone(observation)),verifyFactors=vi.fn(async()=>structuredClone(factors));
 const verifier=createCustodyApiVerifier({observe,verifyFactors,now:()=>now});
 const program='5UaivPxV8oQypy5mxmQCzvZXHVSMkPsZ2TKJvszyebVG',orgUuid=crypto.randomUUID(),ridUuid=crypto.randomUUID(),assetKey='34ee730cf90d3d55ea2d34e911aa4ad941aafb29668bf4056cfa88c6cf0492e4';
 const addresses=await custodySetupAddresses(program,orgUuid,ridUuid,assetKey);
 const responsibility={id:rid,version:1,hash,siteId:'site_a'},authority={schemaVersion:1,environment:'development',organizationId:scope.organizationId,responsibility,generation:0,family:'none',legacyHead:null};
 const specification=CustodySetupSpecificationSchema.parse({schemaVersion:1,purpose:'INITIALIZE_EMPTY_CUSTODY',environment:'development',id:'spec_a',version:1,predecessor:null,
  organization:{id:scope.organizationId,registrationUuid:orgUuid,authorityEpoch:0},responsibility:{...responsibility,registrationUuid:ridUuid},site:{id:'site_a',generation:0,recordHash:hash,active:true},
  authority:{snapshot:authority,recordHash:await commandDigest({namespace:'pactwoven:financial-authority-fence:v1',record:authority})},owner,ownerWalletPublicKey:wallet,
  program:{id:program,loader:'BPFLoaderUpgradeab1e11111111111111111111111',programData:program,deploymentSlot:'1',sourceHash:hash,binaryHash:hash,idlHash:hash,clientHash:hash,buildManifestHash:hash,upgradePolicy:ref('policy_a')},
  config:{address:addresses.configAddress,recordHash:hash,setupIntentHash:hash,observation:ref('config_observation')},asset:{...FINANCE_DEVNET_ASSET,decimals:6,key:assetKey,registryVersion:1,registryRecordHash:hash,controlGeneration:0,controlHash:hash},
  registrationAddress:addresses.registrationAddress,vaultAddress:addresses.vaultAddress,registrar:program,rentPayer:program,setupOperationKey:addresses.setupOperationKey,
  transactionPolicy:{reference:ref('tx_policy'),instructionPlanHash:hash,maximumFeeLamports:'1000',maximumRentLamports:'1000',maximumFaucetLamports:'0',maximumTotalLamports:'2000'},issuedAt:iso(at-1000),expiresAt:iso(at+120000)});
 const specificationRef={id:specification.id,version:1,recordHash:await custodySpecificationHash(specification)};
 const records=new Map<string,CustodyRecord>(),operations=new Map<string,{command:CustodyCommand;result:CustodyResult}>(),evidence=new Map<string,CustodyAuthEvidence>();
 const recordRef=async(r:CustodyRecord)=>({id:r.id,version:r.version,recordHash:await custodyRecordHash(r)});
 const evidenceRef=async(id:string)=>({id,version:1,recordHash:await commandDigest({namespace:'pactwoven:custody-auth-evidence:v1',record:evidence.get(id)!})});
 let currentRead:CustodyRead|null=null;
 const append=vi.fn(async(e:CustodyAuthEvidence)=>{evidence.set(e.id,structuredClone(e));return evidenceRef(e.id);});
 const original=vi.fn(async(_e:string,_s:CustodyApiOwnerScope,q:{kind:string;key:string})=>structuredClone(operations.get(`${q.kind}/${q.key}`)??null));
 const resolveOwner=vi.fn(async()=>structuredClone(scope));
 const readSpec=vi.fn(async()=>structuredClone(specification));
 const readRecord=vi.fn(async(_e:string,_s:CustodyApiOwnerScope,q:{id:string})=>{const r=records.get(q.id);return r?{record:structuredClone(r),reference:await recordRef(r)}:null;});
 const mutate=vi.fn(async(identityEvidenceId:string,command:CustodyCommand):Promise<CustodyResult>=>{
  const opId=crypto.randomUUID(),setupId=command.kind==='prepare'?crypto.randomUUID():command.setupId,common={schemaVersion:1 as const,id:crypto.randomUUID(),setupId,version:1,environment:'development' as const,organizationId:scope.organizationId,responsibilityId:rid,actorId:owner.actorId,issuedAt:iso(at),expiresAt:iso(at+60000)};
  let body:CustodyRecord;
  if(command.kind==='prepare')body={...common,kind:'draft',specification:specificationRef,specificationControlGeneration:0,predecessor:null,prepareOperationId:opId};
  else{const draft=currentRead!.draft,draftRef=await recordRef(draft);
   if(command.kind==='challenge')body={...common,kind:'wallet_challenge',specification:specificationRef,draft:draftRef,owner,wallet,organizationRegistrationUuid:orgUuid,responsibilityRegistrationUuid:ridUuid,setupOperationKey:addresses.setupOperationKey,nonce:'A'.repeat(43)};
   else if(command.kind==='confirmation'){
    const proof=evidence.get(command.walletEvidenceId)!;if(proof.kind!=='wallet')throw new Error('wallet proof required');
    const intent={schemaVersion:1 as const,purpose:'custody_setup_owner_binding' as const,environment:'development' as const,organizationId:scope.organizationId,responsibilityId:rid,setupId,specification:specificationRef,challenge:proof.challenge,signatureHash:proof.signatureHash,owner,key:command.confirmationKey,nonce:'B'.repeat(42)+'A'};
    body={...common,kind:'confirmation',draft:draftRef,walletEvidence:await evidenceRef(proof.id),intent,intentHash:await commandDigest(intent),requestHash:await commandDigest({schemaVersion:1,purpose:'custody_setup_owner_binding',request:{nonce:intent.nonce,key:intent.key,intent}})};
   }else if(command.kind==='confirm'){
    const confirmation=records.get(command.confirmationId)!;if(confirmation.kind!=='confirmation')throw new Error('confirmation required');
    const prepare=Array.from(operations.values()).find(o=>o.command.kind==='prepare')!.result;
    body={...common,kind:'owner_binding',purpose:'INITIALIZE_EMPTY_CUSTODY',specification,specificationRef,specificationControlGeneration:0,draft:draftRef,challenge:confirmation.intent.challenge,confirmation:await recordRef(confirmation),identityEvidence:await evidenceRef(identityEvidenceId),walletEvidence:confirmation.walletEvidence,mfaEvidence:await evidenceRef(command.mfaEvidenceId),signatureHash:confirmation.intent.signatureHash,prepareOperation:{id:prepare.id,key:prepare.key,commandHash:prepare.commandHash},confirmOperation:{id:opId,key:command.key,commandHash:await custodyCommandHash(scope.organizationId,owner.actorId,command)},controlGeneration:1};
   }else body={...common,kind:'cancellation',draft:draftRef,previousControlGeneration:currentRead!.controlGeneration,controlGeneration:currentRead!.controlGeneration+1};
  }
  const result:CustodyResult={schemaVersion:1,id:opId,organizationId:scope.organizationId,actorId:owner.actorId,responsibilityId:rid,kind:command.kind,key:command.key,commandHash:await custodyCommandHash(scope.organizationId,owner.actorId,command),setupId,target:await recordRef(body),body,financialState:null};
  records.set(body.id,structuredClone(body));operations.set(`${command.kind}/${command.key}`,{command:structuredClone(command),result:structuredClone(result)});
  if(body.kind==='draft')currentRead={schemaVersion:1,setupId,draft:body,draftHash:result.target.recordHash,controlGeneration:0,state:'pending',binding:null};
  if(body.kind==='owner_binding')currentRead={...currentRead!,state:'confirmed',controlGeneration:1,binding:body};
  if(body.kind==='cancellation')currentRead={...currentRead!,state:'cancelled',controlGeneration:body.controlGeneration};return structuredClone(result);
 });
 const get=vi.fn(async()=>structuredClone(currentRead)),recover=vi.fn(async()=>{throw new Error('Legacy hash-based recovery must not be used by the public API');});
 const dependencies:CustodyApiDependencies={verifier,repository:{mutate,get,recover},readers:{resolveOwner,specification:readSpec,record:readRecord,original},authentication:{append}};
 const service=createCustodySetupService(dependencies);
 const prepare={schemaVersion:1,key:'prepare_original_001',reviewedSpecificationRef:specificationRef,ownerWalletPublicKey:wallet,expectedScope:{responsibilityVersion:1,responsibilityHash:hash,siteGeneration:0,siteRecordHash:hash,canonicalGeneration:0,canonicalHash:specification.authority.recordHash},previousDraft:null};
 async function prepared(){const p=await service.prepare(token,rid,prepare,trace);return{p,setupId:p.operation.setupId,expected:{schemaVersion:1,expectedSetupVersion:1,expectedSetupHash:p.operation.target.recordHash}};}
 async function challenged(){const base=await prepared(),challenge={...base.expected,key:'challenge_original_001'},c=await service.challenge(token,rid,base.setupId,challenge,trace);if(c.operation.body.kind!=='wallet_challenge')throw new Error('challenge required');const signature=sign(null,custodyWalletChallengeBytes(c.operation.body),keys.privateKey).toString('base64');
  return{...base,c,challenge,confirmation:{...base.expected,key:'confirmation_original_001',confirmationKey:'confirm_original_001',challengeId:c.operation.body.id,challengeHash:c.operation.target.recordHash,walletSignature:signature}};}
 async function confirmedChallenge(){const base=await challenged(),cf=await service.confirmation(token,rid,base.setupId,base.confirmation,trace);if(cf.operation.body.kind!=='confirmation')throw new Error('confirmation required');return{...base,cf,confirm:{...base.expected,key:'confirm_original_001',challengeId:base.confirmation.challengeId,challengeHash:base.confirmation.challengeHash,walletSignature:base.confirmation.walletSignature,confirmationId:cf.operation.body.id,confirmationNonce:cf.operation.body.intent.nonce}};}
 return{service,dependencies,verifier,observation,scope,specification,specificationRef,operations,records,evidence,append,original,resolveOwner,readSpec,readRecord,mutate,get,recover,observe,verifyFactors,prepare,prepared,challenged,confirmedChallenge,setNow:(value:number)=>{now=value;}};
}

describe('custody setup service with pure injected storage and cryptography',()=>{
 it('runs prepare, wallet challenge, confirmation, MFA binding, read and exact-key recovery',async()=>{const f=await fixture(),b=await f.confirmedChallenge(),bound=await f.service.confirm(token,rid,b.setupId,b.confirm,trace);
  expect(bound.operation.kind).toBe('confirm');expect(bound.operation.financialState).toBeNull();expect(f.verifyFactors).toHaveBeenCalledOnce();expect(f.mutate).toHaveBeenCalledTimes(4);
  const read=await f.service.get(token,rid,b.setupId,trace);expect(read.setup.state).toBe('confirmed');expect(read.review).toEqual(f.specification);
  expect((await f.service.recover(token,rid,{kind:'confirm',key:b.confirm.key},trace)).operation).toEqual(bound.operation);
  expect((await f.service.recover(token,rid,{kind:'confirm',key:'unknown_original_001'},trace)).status).toBe('not_recorded');expect(f.recover).not.toHaveBeenCalled();
 });
 it('cancels with the exact draft and control generation',async()=>{const f=await fixture(),b=await f.prepared(),input={...b.expected,key:'cancel_original_001',expectedSetupControlGeneration:0};const r=await f.service.cancel(token,rid,b.setupId,input,trace);expect(r.operation.body.kind).toBe('cancellation');expect((await f.service.get(token,rid,b.setupId,trace)).setup.state).toBe('cancelled');});
 it('replays confirmation and owner binding with their original private proof IDs after factor expiry',async()=>{const f=await fixture(),b=await f.confirmedChallenge(),bound=await f.service.confirm(token,rid,b.setupId,b.confirm,trace);const count=f.mutate.mock.calls.length;
  f.verifyFactors.mockRejectedValue(new Error('expired factors'));expect(await f.service.confirmation(token,rid,b.setupId,b.confirmation,trace)).toEqual(b.cf);expect(await f.service.confirm(token,rid,b.setupId,b.confirm,trace)).toEqual(bound);
  expect(f.mutate).toHaveBeenCalledTimes(count);expect(f.verifyFactors).toHaveBeenCalledOnce();expect([...f.evidence.values()].filter(e=>e.kind==='wallet')).toHaveLength(1);expect([...f.evidence.values()].filter(e=>e.kind==='mfa')).toHaveLength(1);
 });
 it('refuses changed same-key prepare, signature, challenge, nonce and cancellation requests',async()=>{const f=await fixture(),b=await f.confirmedChallenge();await f.service.confirm(token,rid,b.setupId,b.confirm,trace);const alternate=generateKeyPairSync('ed25519'),signature=sign(null,Buffer.from('different'),alternate.privateKey).toString('base64');
  for(const task of [()=>f.service.prepare(token,rid,{...f.prepare,previousDraft:ref('previous_draft')},trace),()=>f.service.confirmation(token,rid,b.setupId,{...b.confirmation,walletSignature:signature},trace),()=>f.service.confirm(token,rid,b.setupId,{...b.confirm,challengeId:crypto.randomUUID()},trace),()=>f.service.confirm(token,rid,b.setupId,{...b.confirm,confirmationNonce:'C'.repeat(42)+'A'},trace)])await expect(task()).rejects.toMatchObject({code:'CUSTODY_KEY_CONFLICT'});
  const cancel={...b.expected,key:'cancel_original_001',expectedSetupControlGeneration:1};await f.service.cancel(token,rid,b.setupId,cancel,trace);await expect(f.service.cancel(token,rid,b.setupId,{...cancel,expectedSetupControlGeneration:2},trace)).rejects.toMatchObject({code:'CUSTODY_KEY_CONFLICT'});
 });
 it('does not create wallet or MFA proof when original lookup is unavailable',async()=>{const f=await fixture(),b=await f.challenged();f.original.mockRejectedValue(new Error('database internals secret'));const n=f.mutate.mock.calls.length;
  await expect(f.service.confirmation(token,rid,b.setupId,b.confirmation,trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN',status:503});expect(f.mutate).toHaveBeenCalledTimes(n);expect([...f.evidence.values()].every(e=>e.kind==='identity')).toBe(true);expect(f.verifyFactors).not.toHaveBeenCalled();
 });
 it('returns an unknown outcome without automatic mutation retry after a lost commit response',async()=>{const f=await fixture(),implementation=f.mutate.getMockImplementation()!;f.mutate.mockImplementationOnce(async(...args)=>{await implementation(...args);throw new Error('lost commit response');});await expect(f.service.prepare(token,rid,f.prepare,trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN'});expect(f.mutate).toHaveBeenCalledOnce();
  const recovered=await f.service.recover(token,rid,{kind:'prepare',key:f.prepare.key},trace);expect(recovered.status).toBe('recorded');expect(f.mutate).toHaveBeenCalledOnce();
 });
 it('recovers a concurrently committed original proof after a private key conflict',async()=>{const f=await fixture(),b=await f.confirmedChallenge();const old=f.operations.get(`confirmation/${b.confirmation.key}`)!;f.operations.delete(`confirmation/${b.confirmation.key}`);
  f.mutate.mockImplementationOnce(async()=>{f.operations.set(`confirmation/${b.confirmation.key}`,old);throw new DomainError('CUSTODY_KEY_CONFLICT',409,'private command differs');});const r=await f.service.confirmation(token,rid,b.setupId,b.confirmation,trace);expect(r.operation).toEqual(old.result);expect([...f.evidence.values()].filter(e=>e.kind==='wallet')).toHaveLength(2);
 });
 it.each(['owner','original','specification','append'] as const)('stops stale verification after a %s wait',async where=>{const f=await fixture();if(where==='owner')f.resolveOwner.mockImplementationOnce(async()=>{f.setNow(at+20000);return structuredClone(f.scope);});if(where==='original')f.original.mockImplementationOnce(async()=>{f.setNow(at+20000);return null;});if(where==='specification')f.readSpec.mockImplementationOnce(async()=>{f.setNow(at+20000);return f.specification;});if(where==='append'){const save=f.append.getMockImplementation()!;f.append.mockImplementationOnce(async(...args)=>{const r=await save(...args);f.setNow(at+20000);return r;});}
  await expect(f.service.prepare(token,rid,f.prepare,trace)).rejects.toMatchObject({code:'CUSTODY_EXPIRED'});expect(f.mutate).not.toHaveBeenCalled();
 });
 it('stops an MFA wait crossing the oldest observation deadline before appending MFA or mutation',async()=>{const f=await fixture(),b=await f.confirmedChallenge(),impl=f.verifyFactors.getMockImplementation()!;f.verifyFactors.mockImplementationOnce(async()=>{f.setNow(at+20000);return impl();});await expect(f.service.confirm(token,rid,b.setupId,b.confirm,trace)).rejects.toMatchObject({code:'CUSTODY_EXPIRED'});expect([...f.evidence.values()].some(e=>e.kind==='mfa')).toBe(false);expect(f.mutate).toHaveBeenCalledTimes(3);});
 it('refuses invalid public JSON shapes before any authentication or persistence',async()=>{const f=await fixture();for(const input of [{...f.prepare,verified:true},{...f.prepare,previousDraft:undefined},{...f.prepare,ownerWalletPublicKey:'11111111111111111111111111111111'}])await expect(f.service.prepare(token,rid,input,trace)).rejects.toMatchObject({code:'CUSTODY_INPUT_INVALID',status:422});expect(f.observe).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();expect(f.mutate).not.toHaveBeenCalled();});
 it('classifies invalid private output as unavailable and strips adapter details',async()=>{const f=await fixture();f.resolveOwner.mockResolvedValueOnce({} as CustodyApiOwnerScope);await expect(f.service.prepare(token,rid,f.prepare,trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN',status:503});f.observe.mockRejectedValueOnce(new z.ZodError([]));await expect(f.service.prepare(token,rid,f.prepare,trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN',status:503});f.original.mockRejectedValueOnce(new DomainError('CUSTODY_ACCESS_DENIED',500 as never,'secret SQL text'));await expect(f.service.prepare(token,rid,f.prepare,trace)).rejects.toMatchObject({code:'CUSTODY_ACCESS_DENIED',status:403,message:'Current owner and site access are required.'});});
 it('rejects result scope, kind and record-hash substitutions',async()=>{for(const field of ['actorId','organizationId','kind','hash']){const f=await fixture(),impl=f.mutate.getMockImplementation()!;f.mutate.mockImplementationOnce(async(...args)=>{const r=await impl(...args);if(field==='actorId')r.actorId='other';if(field==='organizationId')r.body.organizationId='other';if(field==='kind')r.kind='cancel';if(field==='hash')r.target.recordHash='b'.repeat(64);return r;});await expect(f.service.prepare(token,rid,f.prepare,trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN'});}});
 it('refuses changed reviewed scope, invalid record read and evidence receipt before mutation',async()=>{const f=await fixture();await expect(f.service.prepare(token,rid,{...f.prepare,expectedScope:{...f.prepare.expectedScope,siteGeneration:1}},trace)).rejects.toMatchObject({code:'CUSTODY_SCOPE_CHANGED'});expect(f.mutate).not.toHaveBeenCalled();const b=await f.challenged();f.readRecord.mockImplementationOnce(async()=>({record:b.c.operation.body,reference:{...b.c.operation.target,recordHash:'b'.repeat(64)}}));await expect(f.service.confirmation(token,rid,b.setupId,b.confirmation,trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN'});
  f.append.mockImplementationOnce(async(e)=>({id:e.id,version:1,recordHash:'f'.repeat(64)}));await expect(f.service.get(token,rid,b.setupId,trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN'});
 });
 it('captures input, methods and observations across asynchronous boundaries',async()=>{const f=await fixture();let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),hold=new Promise<void>(r=>{release=r;});f.original.mockImplementationOnce(async(_id,scope)=>{scope.owner.actorId='changed';enter();await hold;return null;});const input=structuredClone(f.prepare),pending=f.service.prepare(token,rid,input,trace);await entered;input.ownerWalletPublicKey=f.specification.registrar;f.dependencies.repository.mutate=async()=>{throw new Error('late replacement');};f.dependencies.verifier.identityEvidence=()=>{throw new Error('late replacement');};release();expect((await pending).operation.kind).toBe('prepare');expect(f.mutate).toHaveBeenCalledOnce();expect(f.mutate.mock.calls[0]![1]).toMatchObject({ownerWalletPublicKey:f.prepare.ownerWalletPublicKey});});
 it('supports verifier methods on a class prototype',async()=>{const f=await fixture(),v=f.verifier;class BoundVerifier{observe=v.observe;assertFresh(o:Parameters<typeof v.assertFresh>[0],s:Parameters<typeof v.assertFresh>[1]){v.assertFresh(o,s);}identityEvidence=v.identityEvidence;walletEvidence=v.walletEvidence;mfaEvidence=v.mfaEvidence;}const service=createCustodySetupService({...f.dependencies,verifier:new BoundVerifier()});expect((await service.prepare(token,rid,f.prepare,trace)).operation.kind).toBe('prepare');});
 it('validates response bindings again outside the service',async()=>{const f=await fixture(),b=await f.prepared();for(const change of [(r:CustodyApiMutationResponse)=>{r.operation.actorId='other';},(r:CustodyApiMutationResponse)=>{r.operation.kind='cancel';},(r:CustodyApiMutationResponse)=>{r.review=null;}]){const r=structuredClone(b.p);change(r);await expect(validateCustodyApiMutationResponse(r,'prepare',rid,f.prepare.key,undefined,f.prepare)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN'});}});
 it('refuses forged read state and binding draft references',async()=>{const f=await fixture(),b=await f.confirmedChallenge();await f.service.confirm(token,rid,b.setupId,b.confirm,trace);const impl=f.get.getMockImplementation()!;for(const field of ['state','draft','specification']){f.get.mockImplementationOnce(async()=>{const r=(await impl())!;if(field==='state')r.state='pending';if(field==='draft')r.binding!.draft.recordHash='b'.repeat(64);if(field==='specification')r.binding!.specificationRef.recordHash='b'.repeat(64);return r;});await expect(f.service.get(token,rid,b.setupId,trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN'});}});
 it('fails closed on missing private records and on a new invalid wallet signature',async()=>{const f=await fixture(),b=await f.challenged();f.readRecord.mockResolvedValueOnce(null);await expect(f.service.confirmation(token,rid,b.setupId,b.confirmation,trace)).rejects.toMatchObject({code:'NOT_FOUND'});const other=generateKeyPairSync('ed25519'),signature=sign(null,Buffer.from('wrong message'),other.privateKey).toString('base64');await expect(f.service.confirmation(token,rid,b.setupId,{...b.confirmation,walletSignature:signature},trace)).rejects.toMatchObject({code:'CUSTODY_INPUT_INVALID'});expect(f.mutate).toHaveBeenCalledTimes(2);expect([...f.evidence.values()].some(e=>e.kind==='wallet')).toBe(false);});
});

async function rehash(r:CustodyResult){r.target.recordHash=await custodyRecordHash(r.body);return r;}
function changeBinding(r:CustodyResult,field:string){if(r.body.kind!=='owner_binding')throw new Error('binding required');const b=r.body;
 if(field==='draft')b.draft.recordHash='b'.repeat(64);
 if(field==='draft-version')b.draft.version++;
 if(field==='challenge')b.challenge.id=crypto.randomUUID();
 if(field==='challenge-hash')b.challenge.recordHash='b'.repeat(64);
 if(field==='confirmation')b.confirmation.id=crypto.randomUUID();
 if(field==='confirmation-hash')b.confirmation.recordHash='b'.repeat(64);
 if(field==='mfa')b.mfaEvidence.id=crypto.randomUUID();
 if(field==='mfa-hash')b.mfaEvidence.recordHash='b'.repeat(64);
 if(field==='wallet')b.walletEvidence.recordHash='b'.repeat(64);
 if(field==='identity')b.identityEvidence.recordHash='b'.repeat(64);
 if(field==='signature')b.signatureHash='b'.repeat(64);
 if(field==='confirm-operation')b.confirmOperation.id=crypto.randomUUID();
 if(field==='confirm-operation-key')b.confirmOperation.key='another_confirm_key';
 if(field==='confirm-operation-hash')b.confirmOperation.commandHash='b'.repeat(64);
 if(field==='prepare-operation')b.prepareOperation.id=crypto.randomUUID();
}
describe('SETUP-0B R2 independent findings',()=>{
 it('keeps cancellation before owner binding readable through the independent route gateway',async()=>{const f=await fixture(),b=await f.prepared();await f.service.cancel(token,rid,b.setupId,{...b.expected,key:'cancel_before_binding_001',expectedSetupControlGeneration:0},trace);const raw=(await f.get())!;
  const app=new Hono<ApiEnv>();registerCustodySetupRoutes(app,{...f.service,get:async()=>({schemaVersion:1,setup:raw,review:f.specification})});const response=await app.request(`/v1/responsibilities/${rid}/custody-setups/${b.setupId}`,{headers:{Authorization:'Bearer synthetic.token'}});expect(response.status).toBe(200);expect((await response.json()).setup).toMatchObject({state:'cancelled',controlGeneration:1,binding:null});
 });
 it.each(['service','route'] as const)('keeps a cancelled setup with its immutable binding readable through %s',async boundary=>{
  const f=await fixture(),b=await f.confirmedChallenge(),bound=await f.service.confirm(token,rid,b.setupId,b.confirm,trace);
  await f.service.cancel(token,rid,b.setupId,{...b.expected,key:'cancel_after_confirm_001',expectedSetupControlGeneration:1},trace);
  const raw=(await f.get())!;expect(raw).toMatchObject({state:'cancelled',controlGeneration:2,binding:bound.operation.body});
  if(boundary==='service')expect((await f.service.get(token,rid,b.setupId,trace)).setup).toEqual(raw);
  else{const app=new Hono<ApiEnv>();registerCustodySetupRoutes(app,{...f.service,get:async()=>({schemaVersion:1,setup:raw,review:f.specification})});const response=await app.request(`/v1/responsibilities/${rid}/custody-setups/${b.setupId}`,{headers:{Authorization:'Bearer synthetic.token'}});expect(response.status).toBe(200);expect((await response.json()).setup).toEqual(raw);}
  expect((await f.service.recover(token,rid,{kind:'confirm',key:b.confirm.key},trace)).operation).toEqual(bound.operation);
 });
 it.each(['draft','draft-version','challenge','challenge-hash','confirmation','confirmation-hash','mfa','mfa-hash','wallet','identity','signature','confirm-operation','confirm-operation-key','confirm-operation-hash','prepare-operation'])('rejects a first-success binding with self-consistent substituted %s',async field=>{
  const f=await fixture(),b=await f.confirmedChallenge(),impl=f.mutate.getMockImplementation()!;f.mutate.mockImplementationOnce(async(...args)=>{const r=await impl(...args);changeBinding(r,field);return rehash(r);});
  await expect(f.service.confirm(token,rid,b.setupId,b.confirm,trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN'});expect(f.mutate).toHaveBeenCalledTimes(4);
 });
 it.each(['draft','challenge','confirmation','mfa','wallet','signature','confirm-operation','prepare-operation'])('rejects original recovery with self-consistent substituted %s',async field=>{
  const f=await fixture(),b=await f.confirmedChallenge();await f.service.confirm(token,rid,b.setupId,b.confirm,trace);const old=f.operations.get(`confirm/${b.confirm.key}`)!;changeBinding(old.result,field);await rehash(old.result);
  await expect(f.service.recover(token,rid,{kind:'confirm',key:b.confirm.key},trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN'});expect(f.verifyFactors).toHaveBeenCalledOnce();expect(f.mutate).toHaveBeenCalledTimes(4);
 });
 it.each(['draft','challenge','challenge-hash','confirmation','mfa','signature','confirm-operation'])('rejects an injected route gateway with self-consistent substituted %s',async field=>{
  const f=await fixture(),b=await f.confirmedChallenge(),value=await f.service.confirm(token,rid,b.setupId,b.confirm,trace);changeBinding(value.operation,field);await rehash(value.operation);
  const app=new Hono<ApiEnv>();registerCustodySetupRoutes(app,{...f.service,confirm:async()=>value});const response=await app.request(`/v1/responsibilities/${rid}/custody-setups/${b.setupId}/confirm-owner`,{method:'POST',headers:{Authorization:'Bearer synthetic.token','Content-Type':'application/json','Idempotency-Key':b.confirm.key},body:JSON.stringify(b.confirm)});expect(response.status).toBe(503);
 });
 it.each(['prepare-operation','prepare-specification','prepare-predecessor','challenge-draft','confirmation-wallet','confirmation-challenge','confirmation-key','confirmation-signature','cancel-generation'])('binds %s for new success and recovery',async field=>{
  const f=await fixture();let stage:()=>Promise<CustodyApiMutationResponse>,operationKind:string,operationKey:string;
  if(field.startsWith('prepare-')){operationKind='prepare';operationKey=f.prepare.key;stage=()=>f.service.prepare(token,rid,f.prepare,trace);}
  else if(field==='challenge-draft'){const b=await f.prepared();operationKind='challenge';operationKey='challenge_r2_request';stage=()=>f.service.challenge(token,rid,b.setupId,{...b.expected,key:operationKey},trace);}
  else if(field.startsWith('confirmation-')){const b=await f.challenged();operationKind='confirmation';operationKey=b.confirmation.key;stage=()=>f.service.confirmation(token,rid,b.setupId,b.confirmation,trace);}
  else{const b=await f.prepared();operationKind='cancel';operationKey='cancel_r2_request';stage=()=>f.service.cancel(token,rid,b.setupId,{...b.expected,key:operationKey,expectedSetupControlGeneration:0},trace);}
  const impl=f.mutate.getMockImplementation()!;f.mutate.mockImplementationOnce(async(...args)=>{const r=await impl(...args),body=r.body;
   if(field==='prepare-operation'&&body.kind==='draft')body.prepareOperationId=crypto.randomUUID();
   if(field==='prepare-specification'&&body.kind==='draft')body.specification.recordHash='b'.repeat(64);
   if(field==='prepare-predecessor'&&body.kind==='draft'){body.predecessor=ref('substitute_previous');body.version=2;r.target.version=2;}
   if(field==='challenge-draft'&&body.kind==='wallet_challenge')body.draft.recordHash='b'.repeat(64);
   if(body.kind==='confirmation'){if(field==='confirmation-wallet')body.walletEvidence.id=crypto.randomUUID();if(field==='confirmation-challenge')body.intent.challenge.id=crypto.randomUUID();if(field==='confirmation-key')body.intent.key='wrong_confirmation_key';if(field==='confirmation-signature')body.intent.signatureHash='b'.repeat(64);body.intentHash=await commandDigest(body.intent);body.requestHash=await commandDigest({schemaVersion:1,purpose:'custody_setup_owner_binding',request:{nonce:body.intent.nonce,key:body.intent.key,intent:body.intent}});}
   if(field==='cancel-generation'&&body.kind==='cancellation'){body.previousControlGeneration=1;body.controlGeneration=2;}
   await rehash(r);f.operations.get(`${operationKind}/${operationKey}`)!.result=structuredClone(r);return r;
  });await expect(stage()).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN'});await expect(f.service.recover(token,rid,{kind:operationKind,key:operationKey},trace)).rejects.toMatchObject({code:'CUSTODY_OUTCOME_UNKNOWN'});
 });
 it.each(['membership','identity','factor-membership','factor-evidence'])('rejects future %s before its evidence or mutation',async field=>{const f=await fixture();
  if(field==='membership'||field==='identity'){if(field==='membership')f.observation.identity.membershipObservedAt=iso(at+1000);else f.observation.observation.observedAt=iso(at+1000);await expect(f.service.prepare(token,rid,f.prepare,trace)).rejects.toMatchObject({code:'CUSTODY_EXPIRED'});expect(f.append).not.toHaveBeenCalled();expect(f.mutate).not.toHaveBeenCalled();}
  else{const b=await f.confirmedChallenge(),impl=f.verifyFactors.getMockImplementation()!;f.verifyFactors.mockImplementationOnce(async()=>{const v=await impl();if(field==='factor-membership')v.identity.membershipObservedAt=iso(at+1000);else v.evidence.observedAt=iso(at+1000);return v;});await expect(f.service.confirm(token,rid,b.setupId,b.confirm,trace)).rejects.toMatchObject({code:'CUSTODY_EXPIRED'});expect([...f.evidence.values()].some(e=>e.kind==='mfa')).toBe(false);expect(f.mutate).toHaveBeenCalledTimes(3);}
 });
 it('replays the expired binding under a newly observed session without new wallet/MFA proof',async()=>{const f=await fixture(),b=await f.confirmedChallenge(),bound=await f.service.confirm(token,rid,b.setupId,b.confirm,trace),current=at+240000,count=f.mutate.mock.calls.length;
  f.setNow(current);f.observation.identity.membershipObservedAt=iso(current-1000);f.observation.identity.sessionId='new_session';f.scope.owner.sessionId='new_session';f.observation.observation.observedAt=iso(current-500);f.observation.observation.tokenIssuedAt=iso(current-10000);f.observation.observation.expiresAt=iso(current+180000);f.verifyFactors.mockRejectedValue(new Error('Do not renew historical MFA'));
  expect(await f.service.confirm(token,rid,b.setupId,b.confirm,trace)).toEqual(bound);expect((await f.service.recover(token,rid,{kind:'confirm',key:b.confirm.key},trace)).operation).toEqual(bound.operation);expect(f.verifyFactors).toHaveBeenCalledOnce();expect(f.mutate).toHaveBeenCalledTimes(count);expect([...f.evidence.values()].filter(e=>e.kind==='wallet')).toHaveLength(1);
 });
 it('preserves the original public expectation when the gateway mutates its argument',async()=>{const f=await fixture(),b=await f.confirmedChallenge(),value=await f.service.confirm(token,rid,b.setupId,b.confirm,trace);changeBinding(value.operation,'challenge');await rehash(value.operation);
  const app=new Hono<ApiEnv>();registerCustodySetupRoutes(app,{...f.service,confirm:async(_t,_r,_s,input)=>{if(value.operation.body.kind!=='owner_binding')throw new Error('binding required');(input as {challengeId:string}).challengeId=value.operation.body.challenge.id;return value;}});
  expect((await app.request(`/v1/responsibilities/${rid}/custody-setups/${b.setupId}/confirm-owner`,{method:'POST',headers:{Authorization:'Bearer synthetic.token','Content-Type':'application/json','Idempotency-Key':b.confirm.key},body:JSON.stringify(b.confirm)})).status).toBe(503);
 });
 it('rejects a self-consistent substituted confirm-operation through the recovery route',async()=>{const f=await fixture(),b=await f.confirmedChallenge(),value=await f.service.confirm(token,rid,b.setupId,b.confirm,trace);changeBinding(value.operation,'confirm-operation');await rehash(value.operation);const app=new Hono<ApiEnv>();registerCustodySetupRoutes(app,{...f.service,recover:async()=>({schemaVersion:1,organizationId:f.scope.organizationId,actorId:f.scope.owner.actorId,responsibilityId:rid,kind:'confirm',key:b.confirm.key,status:'recorded',operation:value.operation})});
  expect((await app.request(`/v1/responsibilities/${rid}/custody-setups/operations/${b.confirm.key}?kind=confirm`,{headers:{Authorization:'Bearer synthetic.token'}})).status).toBe(503);
 });
});
