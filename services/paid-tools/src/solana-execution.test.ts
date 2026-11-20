import { createHash } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import { PrivatePaidToolSigner,PrivatePaidToolBroadcaster,PrivatePaidToolFinalityObserver,type PaidToolCustodyRoute } from './solana-execution.js';
import { QuickNodePaidToolTransport } from './solana-transport.js';
import { transferFixture,accountFixture,now,transactionFixture } from './solana-fixtures.test-support.js';
import { PaidToolPrivateReadSchema,type PaidToolPrivateCommand } from '../../../packages/db/src/paid-tool-schema.js';
import type { PostgresPaidToolPrivateRepository } from '../../../packages/db/src/paid-tool-repository.js';
const signal=()=>new AbortController().signal;
function fixture(separatePayer=false){
 const f=transferFixture(separatePayer),r=f.intent,hash='a'.repeat(64),ref={id:'ref',version:1,hash};
 const payee={id:'payee',version:1,environment:'development',network:'solana-devnet',recipient:r.destinationAccount,assetId:'devnet_usdc',mint:r.mint,tokenProgram:r.tokenProgram,verificationRef:'verification'};
 const review={id:'review',organizationId:'org',siteId:'site',rootTaskId:'root',instructionRevision:1,quoteId:'quote',quoteHash:hash,providerId:'equipment_optimizer_v1',amountBaseUnits:r.amountBaseUnits,maximumFeeLamports:r.maximumFeeLamports,sourceAccount:r.sourceAccount,sourceOwner:r.sourceOwner,feePayer:r.feePayer,destinationAccount:r.destinationAccount,destinationOwner:r.destinationOwner,mint:r.mint,tokenProgram:r.tokenProgram,genesis:r.genesis,expiresAt:r.validUntil,reviewHash:hash};
 let record=PaidToolPrivateReadSchema.parse({snapshot:{operationId:'operation',review,version:2,status:'reserved',approvedAt:now,revokedAt:null,message:null,attempt:null,payment:null,delivery:null},quote:{providerId:'equipment_optimizer_v1',resource:ref,request:ref,allowlistPolicy:ref,deliveryPolicy:ref,challenge:{id:'quote',providerId:'equipment_optimizer_v1',resourceHash:hash,requestHash:hash,payee,amountBaseUnits:r.amountBaseUnits,expiresAt:r.validUntil,hash}},requestBody:{},resourceBody:{},wireBase64:null,receipt:null});
 const events:string[]=[];let blocked:string|null=null;let clockNow=now;
 const repository:Pick<PostgresPaidToolPrivateRepository,'read'|'apply'|'quarantine'|'observe'>={
 read:vi.fn(async()=>structuredClone(record)),
 observe:vi.fn(async value=>{events.push('observe');return value;}),
 quarantine:vi.fn(async(_id,wireBase64)=>{events.push('quarantine');if(blocked==='quarantine')throw Error('storage unavailable');record.wireBase64=wireBase64;return {wireHash:createHash('sha256').update(Buffer.from(wireBase64,'base64')).digest('hex')};}),
 apply:vi.fn(async(input:PaidToolPrivateCommand)=>{events.push(input.kind);if(blocked===input.kind)throw Error('SQL rejected');
  expect(input.operationId).toBe(record.snapshot.operationId);expect(input.expectedVersion).toBe(record.snapshot.version);
  const s=record.snapshot,previousVersion=s.version;s.version++;
  if(input.kind==='prepare_sign'){s.status='signing';s.message=input.message;}
  if(input.kind==='retain_signed'){expect(record.wireBase64).not.toBeNull();s.status='signed';s.attempt=input.attempt;}
  if(input.kind==='prepare_broadcast')s.status='submitting';if(input.kind==='mark_submitted')s.status='payment_pending';if(input.kind==='mark_unknown')s.status='outcome_unknown';if(input.kind==='confirm_payment'){s.status='payment_confirmed';s.payment=input.payment;}
  if(blocked==='delay_'+input.kind)clockNow='2026-11-19T16:00:06Z';
  return {snapshot:structuredClone(s),receipt:{commandKey:input.commandKey,commandHash:hash,previousVersion,version:s.version,recordedAt:now,status:s.status}};
 })};
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{const req=JSON.parse(String(init?.body));events.push(req.method);
  let tx=transactionFixture(f);if(record.wireBase64&&record.snapshot.attempt)tx={...tx,transaction:{...tx.transaction,signatures:[record.snapshot.attempt.signature,...f.signatures.slice(1)]}};
  const result=({getLatestBlockhash:{context:{slot:120},value:{blockhash:r.blockhash,lastValidBlockHeight:300}},getGenesisHash:r.genesis,getMultipleAccounts:accountFixture(r).result,getBlockHeight:200,getFeeForMessage:{context:{slot:120},value:Number(r.feeLamports)},simulateTransaction:{context:{slot:120},value:{err:null}},sendTransaction:record.snapshot.attempt?.signature,getSignatureStatuses:{context:{slot:130},value:[{slot:123,confirmations:null,err:null,status:{Ok:null},confirmationStatus:'finalized'}]},getTransaction:tx} as Record<string,unknown>)[req.method];
  if(blocked==='sendTransaction'&&req.method==='sendTransaction')throw Error('unknown');
  return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result}),{headers:{'content-type':'application/json'}});
 });
 const transport=new QuickNodePaidToolTransport({endpointUrl:'https://synthetic.quiknode.pro/token/',fetch:fetcher as typeof fetch,now:()=>clockNow,capture:async()=>{}});
 const route:PaidToolCustodyRoute={sourceKey:'source',feeKey:'fee',sourceAccount:r.sourceAccount,sourceOwner:r.sourceOwner,destinationAccount:r.destinationAccount,destinationOwner:r.destinationOwner,feePayer:r.feePayer,minimumSlot:r.minimumAccountSlot};
 const recordHeight=vi.fn(async()=>{events.push('height');});
 return {...f,repository,transport,route,events,fetcher,recordHeight,record:()=>record,block:(value:string)=>{blocked=value;},
 signer:()=>new PrivatePaidToolSigner(repository,repository,transport,[route],f.fixtureKeys),
 broadcaster:()=>new PrivatePaidToolBroadcaster(repository,repository,transport,[route],recordHeight),
 observer:()=>new PrivatePaidToolFinalityObserver(repository,transport,[route])};
}
describe('private paid-tool execution (in-memory repository and synthetic transport)',()=>{
 it.each([false,true])('signs one canonical transfer with exact enrolled signer(s), quarantine then retain (separate payer %s)',async separate=>{
  const f=fixture(separate);const result=await f.signer().prepareAndSign('operation',signal());expect(result.snapshot.status).toBe('signed');
  expect(f.events.indexOf('prepare_sign')).toBeLessThan(f.events.indexOf('quarantine'));expect(f.events.indexOf('quarantine')).toBeLessThan(f.events.indexOf('retain_signed'));
  expect(f.record().wireBase64).toBe(f.wire.wireBase64);expect(f.events).not.toContain('sendTransaction');
  await expect(f.signer().prepareAndSign('operation',signal())).rejects.toThrow('STATE_REQUIRES_RECONCILIATION');expect(f.repository.quarantine).toHaveBeenCalledTimes(1);
 });
 it('does not sign if the persisted current permission/fence rejects',async()=>{
  const f=fixture();f.block('prepare_sign');await expect(f.signer().prepareAndSign('operation',signal())).rejects.toThrow();expect(f.repository.quarantine).not.toHaveBeenCalled();expect(f.record().snapshot.status).toBe('reserved');
 });
 it('keeps a signing fence if quarantine fails; a new invocation cannot resign',async()=>{
  const f=fixture();f.block('quarantine');await expect(f.signer().prepareAndSign('operation',signal())).rejects.toThrow();expect(f.record().snapshot.status).toBe('signing');
  await expect(f.signer().prepareAndSign('operation',signal())).rejects.toThrow();expect(f.repository.quarantine).toHaveBeenCalledTimes(1);expect(f.events).not.toContain('sendTransaction');
 });
 it('recovers quarantined bytes after lost retention without signing again, including after expiry',async()=>{
  const f=fixture();f.block('retain_signed');await expect(f.signer().prepareAndSign('operation',signal())).rejects.toThrow();
  const original=f.record().wireBase64;f.block('');f.record().snapshot.review.expiresAt='2026-11-19T15:59:00Z';
  expect((await f.signer().recoverRetained('operation',signal())).snapshot.status).toBe('signed');expect(f.record().wireBase64).toBe(original);expect(f.repository.quarantine).toHaveBeenCalledTimes(1);
  await expect(f.signer().prepareAndSign('operation',signal())).rejects.toThrow();expect(f.events).not.toContain('sendTransaction');
 });
 it('rejects a mismatched configured key or custody route before signing',async()=>{
  const f=fixture(),other=fixture();expect(()=>new PrivatePaidToolSigner(f.repository,f.repository,f.transport,[f.route],new Map([[f.intent.sourceOwner,other.fixtureKeys.values().next().value!]]))).toThrow('CONFIGURATION_INVALID');
  const signer=new PrivatePaidToolSigner(f.repository,f.repository,f.transport,[{...f.route,destinationOwner:other.intent.sourceOwner}],f.fixtureKeys);
  await expect(signer.prepareAndSign('operation',signal())).rejects.toThrow('CONFIGURATION_INVALID');expect(f.fetcher).not.toHaveBeenCalled();
 });
 it('broadcasts retained original once only after simulation, observations, height and SQL fence; then observes finality',async()=>{
  const f=fixture();await f.signer().prepareAndSign('operation',signal());const result=await f.broadcaster().broadcast('operation',signal());expect(result.snapshot.status).toBe('payment_pending');expect(result.snapshot.payment).toBeNull();
  expect(f.events.indexOf('height')).toBeLessThan(f.events.indexOf('prepare_broadcast'));expect(f.events.indexOf('prepare_broadcast')).toBeLessThan(f.events.indexOf('sendTransaction'));
  await expect(f.broadcaster().broadcast('operation',signal())).rejects.toThrow();expect(f.events.filter(x=>x==='sendTransaction')).toHaveLength(1);
  expect((await f.observer().reconcile('operation',signal())).disposition).toBe('recorded');expect(f.record().snapshot.status).toBe('payment_confirmed');expect(f.record().snapshot.delivery).toBeNull();
 });
 it('does not send when the current dispatch fence rejects',async()=>{
  const f=fixture();await f.signer().prepareAndSign('operation',signal());f.block('prepare_broadcast');await expect(f.broadcaster().broadcast('operation',signal())).rejects.toThrow();expect(f.events).not.toContain('sendTransaction');
 });
 it('does not sign or broadcast after a slow fence response makes height evidence stale',async()=>{
  const a=fixture();a.block('delay_prepare_sign');await expect(a.signer().prepareAndSign('operation',signal())).rejects.toThrow('EXPIRED');expect(a.repository.quarantine).not.toHaveBeenCalled();expect(a.record().snapshot.status).toBe('signing');
  const b=fixture();await b.signer().prepareAndSign('operation',signal());b.block('delay_prepare_broadcast');await expect(b.broadcaster().broadcast('operation',signal())).rejects.toThrow('EXPIRED');expect(b.events).not.toContain('sendTransaction');expect(b.record().snapshot.status).toBe('submitting');
 });
 it('retains uncertain outcomes and never retries sending',async()=>{
  const f=fixture();await f.signer().prepareAndSign('operation',signal());f.block('sendTransaction');expect((await f.broadcaster().broadcast('operation',signal())).snapshot.status).toBe('outcome_unknown');
  await expect(f.broadcaster().broadcast('operation',signal())).rejects.toThrow();expect(f.events.filter(x=>x==='sendTransaction')).toHaveLength(1);
 });
 it('refuses tampered stored bytes before simulation or send',async()=>{
  const f=fixture();await f.signer().prepareAndSign('operation',signal());f.record().wireBase64=fixture().wire.wireBase64;
  await expect(f.broadcaster().broadcast('operation',signal())).rejects.toThrow();expect(f.events).not.toContain('simulateTransaction');expect(f.events).not.toContain('sendTransaction');
 });
});
