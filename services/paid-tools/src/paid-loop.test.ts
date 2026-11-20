import {describe,it,expect,vi} from 'vitest';
import {PaidToolOperationDriver,type PaidToolLoopPorts} from './paid-loop.js';
import {PaidToolPrivateReadSchema} from '../../../packages/db/src/paid-tool-schema.js';
import {transferFixture,now} from './solana-fixtures.test-support.js';
function fixture(){
 const f=transferFixture(),r=f.intent,hash='a'.repeat(64),ref={id:'ref',version:1,hash};
 const review={id:'review',organizationId:'org',siteId:'site',rootTaskId:'root',instructionRevision:0,quoteId:'quote',quoteHash:hash,providerId:'equipment_optimizer_v1',amountBaseUnits:r.amountBaseUnits,maximumFeeLamports:r.maximumFeeLamports,sourceAccount:r.sourceAccount,sourceOwner:r.sourceOwner,feePayer:r.feePayer,destinationAccount:r.destinationAccount,destinationOwner:r.destinationOwner,mint:r.mint,tokenProgram:r.tokenProgram,genesis:r.genesis,expiresAt:r.validUntil,reviewHash:hash};
 const record=PaidToolPrivateReadSchema.parse({snapshot:{operationId:'operation',review,version:1,status:'authorized',approvedAt:now,revokedAt:null,message:null,attempt:null,payment:null,delivery:null},quote:{providerId:'equipment_optimizer_v1',resource:ref,request:ref,allowlistPolicy:ref,deliveryPolicy:ref,challenge:{id:'quote',providerId:'equipment_optimizer_v1',resourceHash:hash,requestHash:hash,payee:{id:'payee',version:1,environment:'development',network:'solana-devnet',recipient:r.destinationOwner,assetId:'devnet_usdc',mint:r.mint,tokenProgram:r.tokenProgram,verificationRef:'proof'},amountBaseUnits:r.amountBaseUnits,expiresAt:r.validUntil,hash}},requestBody:{},resourceBody:{},wireBase64:null,receipt:null});
 const change=(status:typeof record.snapshot.status)=>{record.snapshot.status=status;record.snapshot.version++;};
 const ports:PaidToolLoopPorts={read:vi.fn(async()=>structuredClone(record)),fundAndReserve:vi.fn(async()=>change('reserved')),sign:vi.fn(async()=>change('signed')),recoverSigned:vi.fn(async()=>change('signed')),broadcast:vi.fn(async()=>change('payment_pending')),reconcile:vi.fn(async()=>change('payment_confirmed')),deliver:vi.fn(async()=>change('completed'))};
 return {record,ports,driver:new PaidToolOperationDriver(ports,()=>Date.parse(now)),change,f};
}
const signal=()=>new AbortController().signal;
describe('durable paid loop dispatch',()=>{
 it('advances one stored stage per wake and stops at completed',async()=>{
  const f=fixture();for(const status of ['reserved','signed','payment_pending','payment_confirmed','completed'])expect((await f.driver.advance('operation',signal())).status).toBe(status);
  expect((await f.driver.advance('operation',signal())).disposition).toBe('completed');for(const key of ['fundAndReserve','sign','broadcast','reconcile','deliver'] as const)expect(f.ports[key]).toHaveBeenCalledTimes(1);
  expect(f.ports.recoverSigned).not.toHaveBeenCalled();
 });
 it('recovers quarantined original signing result and never creates a second signature',async()=>{
  const f=fixture();f.change('signing');expect((await f.driver.advance('operation',signal())).status).toBe('signed');expect(f.ports.recoverSigned).toHaveBeenCalledTimes(1);expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it('keeps unknown unsigned output held without automatic repeated signing',async()=>{
  const f=fixture();f.change('outcome_unknown');f.ports.recoverSigned=vi.fn(async()=>{throw Error('no retained wire');});
  const result=await f.driver.advance('operation',signal());expect(result).toMatchObject({status:'outcome_unknown',disposition:'reconciliation_required',nextWakeAfterMs:null});expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.broadcast).not.toHaveBeenCalled();
 });
 it('only observes finality for unknown signed outcomes, with a bounded wake hint',async()=>{
  const f=fixture();f.change('outcome_unknown');f.record.snapshot.attempt={id:'attempt',messageHash:f.f.wire.messageHash,wireHash:f.f.wire.wireHash,signature:f.f.wire.signature,blockhash:f.f.intent.blockhash,lastValidBlockHeight:'300'};
  f.ports.reconcile=vi.fn(async()=>({disposition:'unknown'}));expect(await f.driver.advance('operation',signal())).toMatchObject({disposition:'waiting',nextWakeAfterMs:4000});expect(f.ports.broadcast).not.toHaveBeenCalled();expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it('preserves progress committed before a lost response instead of retrying the action',async()=>{
  const f=fixture();f.change('reserved');f.ports.sign=vi.fn(async()=>{f.change('signing');throw Error('lost response');});
  expect(await f.driver.advance('operation',signal())).toMatchObject({status:'signing',disposition:'progressed',nextWakeAfterMs:null});expect(f.ports.sign).toHaveBeenCalledTimes(1);expect(f.ports.broadcast).not.toHaveBeenCalled();
 });
 it('rejects changed root/revision/approval when re-reading after a stage',async()=>{
  const f=fixture();f.ports.fundAndReserve=vi.fn(async()=>{f.change('reserved');f.record.snapshot.review.instructionRevision=1;});
  expect(await f.driver.advance('operation',signal())).toMatchObject({status:'authorized',disposition:'reconciliation_required'});
 });
 it('does not initiate an expired reserved operation or schedule effect retries',async()=>{const f=fixture();f.change('reserved');f.record.snapshot.review.expiresAt=now;expect(await f.driver.advance('operation',signal())).toMatchObject({disposition:'reconciliation_required',nextWakeAfterMs:null});expect(f.ports.sign).not.toHaveBeenCalled();});
 it('returns no raw error text or wire and never acts for cancelled/aborted work',async()=>{
  const f=fixture();f.change('cancelled');expect((await f.driver.advance('operation',signal())).disposition).toBe('cancelled');const c=new AbortController();c.abort();expect((await f.driver.advance('operation',c.signal)).disposition).toBe('interrupted');expect(f.ports.fundAndReserve).not.toHaveBeenCalled();
 });
});
