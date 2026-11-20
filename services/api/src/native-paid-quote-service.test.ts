import { describe, it, expect, vi } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import { commandDigest } from '../../../packages/contracts/src/canonical';
import { FINANCE_DEVNET_ASSET,encodeSolanaBase58 } from '../../../packages/contracts/src/finance-provenance';
import { equipmentRequestHash,equipmentResourceHash } from '../../paid-tools/src/equipment-optimizer';
import { paidToolChallengeHash } from '../../paid-tools/src/quote-binding';
import { NativePaidQuoteService } from './native-paid-quote-service';
const at='2026-11-19T16:00:00Z',later='2026-11-19T16:05:00Z',address=(n:number)=>encodeSolanaBase58(new Uint8Array(32).fill(n));
async function fixture(){
  const session:Session={actor:{actorId:'human',principalKind:'human',organizationId:'org',environment:'development',roles:['owner'],siteIds:['site'],actionSiteIds:['site'],sessionId:'session',authenticatedAt:at,correlationId:'test'},organization:{id:'org',name:'Company',authorityEpoch:1},sites:[{id:'site',name:'Site',timeZone:'America/Chicago'}]};
  const request={seats:20,microphones:0,projectors:0,budgetMinor:10000};
  const catalogue={version:1,currency:'USD' as const,provenance:'controlled_demo_catalogue' as const,offers:[{id:'seats',label:'Twenty seats',seats:20,microphones:0,projectors:0,priceMinor:5000}]};
  const requestHash=await equipmentRequestHash(request),resourceHash=await equipmentResourceHash(catalogue);
  const payee={id:'payee',version:1,environment:'development' as const,network:'solana-devnet',recipient:address(4),assetId:'devnet_usdc',mint:FINANCE_DEVNET_ASSET.mint,tokenProgram:FINANCE_DEVNET_ASSET.tokenProgram,verificationRef:'fixed_payee'};
  const challenge={id:'quote',providerId:'equipment_optimizer_v1',resourceHash,requestHash,payee,amountBaseUnits:'10000',expiresAt:later};
  const ref={id:'policy',version:1,hash:'a'.repeat(64)};
  const quote={rootTaskId:'root',quoteId:'quote',instructionRevision:0,quote:{providerId:'equipment_optimizer_v1',resource:{...ref,hash:resourceHash},request:{...ref,hash:requestHash},challenge:{...challenge,hash:await paidToolChallengeHash(challenge)},allowlistPolicy:ref,deliveryPolicy:ref},requestBody:request,resourceBody:catalogue,reason:'Find a seating package.',assumptions:[]};
  const discovery={rootTaskId:'root',instructionRevision:0,evidenceAvailable:true,policy:{enabled:true,rootTaskId:'root',instructionRevision:0,maximumComputationBaseUnits:'10000',maximumFeeLamports:'10000',authorization:'separate_quote_required'},attachment:{quoteId:'quote',operationId:null,paymentStatus:null,status:'waiting',dataValidUntil:later}};
  const body={id:'review',organizationId:'org',siteId:'site',rootTaskId:'root',instructionRevision:0,quoteId:'quote',quoteHash:quote.quote.challenge.hash,providerId:'equipment_optimizer_v1',amountBaseUnits:'10000',maximumFeeLamports:'10000',sourceAccount:address(1),sourceOwner:address(2),feePayer:address(2),destinationAccount:address(3),destinationOwner:address(4),...FINANCE_DEVNET_ASSET,expiresAt:later};
  const review={...body,reviewHash:await commandDigest(body)};
  const snapshot={operationId:'operation',version:1,status:'authorized',approvedAt:at,revokedAt:null,review,message:null,attempt:null,payment:null,delivery:null,currentInstructionRevision:0,evidenceAvailable:true};
  const roots={discover:vi.fn(async()=>discovery),quote:vi.fn(async()=>quote)};
  const human={review:vi.fn(async()=>review),approve:vi.fn(async()=>snapshot),recover:vi.fn(async()=>({snapshot,receipt:null}))};
  const service=new NativePaidQuoteService(roots as never,human as never,{sourceKey:'fixed_source',feeKey:'fixed_fee'},()=>at);
  return {session,quote,discovery,review,snapshot,roots,human,service,approval:{quoteId:'quote',reviewId:'review',reviewHash:review.reviewHash,commandKey:'original_approval'}};
}
describe('exact human equipment quote review',()=>{
  it('returns useful scoped demand and catalogue with exact test price',async()=>{
    const f=await fixture(),result=await f.service.discover(f.session,'root','site');expect(result.state).toBe('awaiting_review');
    expect(result.quote?.request.seats).toBe(20);expect(result.quote?.amount.baseUnits).toBe('10000');expect(result.quote?.catalogue.provenance).toBe('controlled_demo_catalogue');
    expect(f.human.review).not.toHaveBeenCalled();expect(f.human.approve).not.toHaveBeenCalled();
  });
  it('creates only an inert review using enrolled server account selectors',async()=>{
    const f=await fixture(),r=await f.service.review(f.session,'root','site','quote','review');expect(r.reviewHash).toBe(f.review.reviewHash);
    expect(f.human.review).toHaveBeenCalledExactlyOnceWith(f.session.actor,{id:'review',quoteId:'quote',sourceKey:'fixed_source',feeKey:'fixed_fee',maximumFeeLamports:'10000'});expect(f.human.approve).not.toHaveBeenCalled();
  });
  it('only explicitly approves the same reviewed hash and operation',async()=>{
    const f=await fixture(),r=await f.service.approve(f.session,'root','site',f.approval);expect(r.purchase.state).toBe('authorized');expect(r.purchase.transaction).toBeNull();
    expect(f.human.approve).toHaveBeenCalledExactlyOnceWith(f.session.actor,'review','original_approval',f.review.reviewHash);
  });
  it.each(['scope','revision','demand','catalogue','amount','challenge','expired'])('rejects changed %s before a review or approval',async kind=>{
    const f=await fixture();if(kind==='scope')f.quote.rootTaskId='another';if(kind==='revision')f.quote.instructionRevision=1;if(kind==='demand')f.quote.requestBody.seats=21;
    if(kind==='catalogue')f.quote.resourceBody.offers[0]!.priceMinor=1;if(kind==='amount')f.quote.quote.challenge.amountBaseUnits='10001';if(kind==='challenge')f.quote.quote.challenge.hash='b'.repeat(64);if(kind==='expired')f.discovery.attachment.dataValidUntil=at;
    await expect(f.service.approve(f.session,'root','site',f.approval)).rejects.toThrow();expect(f.human.review).not.toHaveBeenCalled();expect(f.human.approve).not.toHaveBeenCalled();
  });
  it('withholds unavailable data while retaining the reference for receipt recovery',async()=>{
    const f=await fixture();f.discovery.evidenceAvailable=false;const r=await f.service.discover(f.session,'root','site');expect(r.state).toBe('unavailable');expect(r.quote).toBeNull();expect(f.roots.quote).not.toHaveBeenCalled();
  });
  it('rejects tampered review facts and a substituted approval response',async()=>{
    const f=await fixture();f.review.maximumFeeLamports='9999';await expect(f.service.approve(f.session,'root','site',f.approval)).rejects.toThrow();expect(f.human.approve).not.toHaveBeenCalled();
    const g=await fixture();g.human.approve.mockResolvedValueOnce({...g.snapshot,review:{...g.review,id:'another'}});await expect(g.service.approve(g.session,'root','site',g.approval)).rejects.toThrow('Recover');
  });
  it('rejects a human-selected wrong hash before approval',async()=>{
    const f=await fixture();await expect(f.service.approve(f.session,'root','site',{...f.approval,reviewHash:'d'.repeat(64)})).rejects.toThrow();expect(f.human.approve).not.toHaveBeenCalled();
  });
  it('recovers the original financial receipt without recreating a review or requiring current quote data',async()=>{
    const f=await fixture();f.session.actor.actionSiteIds=[];f.discovery.evidenceAvailable=false;
    const {quoteId:_,...input}=f.approval;const r=await f.service.recover(f.session,'root','site',input);expect(r.purchase?.operationId).toBe('operation');
    expect(f.roots.discover).not.toHaveBeenCalled();expect(f.roots.quote).not.toHaveBeenCalled();expect(f.human.review).not.toHaveBeenCalled();expect(f.human.approve).not.toHaveBeenCalled();
  });
  it('rejects unavailable write scope before accessing storage',async()=>{
    const f=await fixture();f.session.actor.actionSiteIds=[];await expect(f.service.review(f.session,'root','site','quote','review')).rejects.toThrow();expect(f.roots.discover).not.toHaveBeenCalled();
  });
});
