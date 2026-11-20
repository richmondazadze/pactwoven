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
  let clock=at;const service=new NativePaidQuoteService(roots as never,human as never,{sourceKey:'fixed_source',feeKey:'fixed_fee'},()=>clock);
  return {session,quote,discovery,review,snapshot,roots,human,service,setNow:(next:string)=>{clock=next;},approval:{quoteId:'quote',reviewId:'review',reviewHash:review.reviewHash,commandKey:'original_approval'}};
}
describe('independent exact quote freshness and recovery',()=>{
 it('rejects quote that expires during quote-read await',async()=>{const f=await fixture();f.roots.quote.mockImplementationOnce(async()=>{f.setNow(later);return f.quote;});await expect(f.service.discover(f.session,'root','site')).rejects.toThrow();});
 it('does not approve when original source expires during inert review await',async()=>{const f=await fixture();f.discovery.attachment.dataValidUntil='2026-11-19T16:00:30Z';f.human.review.mockImplementationOnce(async()=>{f.setNow('2026-11-19T16:00:31Z');return f.review;});await expect(f.service.approve(f.session,'root','site',f.approval)).rejects.toThrow();expect(f.human.approve).not.toHaveBeenCalled();});
 it('rejects forged catalogue under original resource hash before review',async()=>{const f=await fixture();f.quote.resourceBody.offers[0]!.label='Forged reference';await expect(f.service.review(f.session,'root','site','quote','review')).rejects.toThrow();expect(f.human.review).not.toHaveBeenCalled();});
 it('never recreates payment during receipt recovery after scope loses write access',async()=>{const f=await fixture();f.session.actor.roles=['auditor'];f.session.actor.actionSiteIds=[];f.snapshot.evidenceAvailable=false;const {quoteId:_,...input}=f.approval;const result=await f.service.recover(f.session,'root','site',input);expect(result.purchase?.operationId).toBe('operation');expect(result.purchase?.resultApplicability).toBe('unavailable');expect(f.human.approve).not.toHaveBeenCalled();expect(f.human.review).not.toHaveBeenCalled();expect(f.roots.quote).not.toHaveBeenCalled();});
 it('rejects another root in recovered original receipt',async()=>{const f=await fixture();f.snapshot.review.rootTaskId='other';const {quoteId:_,...input}=f.approval;await expect(f.service.recover(f.session,'root','site',input)).rejects.toThrow();});
});
