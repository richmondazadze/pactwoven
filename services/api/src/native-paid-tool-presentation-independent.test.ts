import {describe,expect,it} from 'vitest';
import type {Session} from '@pactwoven/contracts';
import {FINANCE_DEVNET_ASSET,encodeSolanaBase58} from '../../../packages/contracts/src/finance-provenance';
import type {PaidToolSnapshot} from '../../../packages/db/src/paid-tool-schema';
import {commandDigest} from '../../../packages/domain/src/canonical';
import {projectNativePaidTool} from './native-paid-tool-presentation';

const before='2026-11-19T16:00:00.000Z',now='2026-11-19T16:01:00.000Z',hash='a'.repeat(64),key=(n:number)=>encodeSolanaBase58(new Uint8Array(32).fill(n)),signature=encodeSolanaBase58(new Uint8Array(64).fill(9));
const session:Session={actor:{actorId:'human',principalKind:'human',organizationId:'org',environment:'development',roles:['owner'],siteIds:['site'],actionSiteIds:['site'],sessionId:'session',authenticatedAt:before,correlationId:'correlation'},organization:{id:'org',name:'QA',authorityEpoch:1},sites:[{id:'site',name:'Site',timeZone:'America/Chicago'}]};
function fixture():PaidToolSnapshot{return{operationId:'operation',version:1,status:'authorized',approvedAt:before,revokedAt:null,review:{id:'review',organizationId:'org',siteId:'site',rootTaskId:'root',instructionRevision:0,quoteId:'quote',quoteHash:hash,providerId:'equipment_optimizer_v1',amountBaseUnits:'10000',maximumFeeLamports:'15000',sourceAccount:key(1),sourceOwner:key(2),feePayer:key(2),destinationAccount:key(3),destinationOwner:key(4),...FINANCE_DEVNET_ASSET,expiresAt:'2026-11-19T16:05:00.000Z',reviewHash:hash},message:null,attempt:null,payment:null,delivery:null};}
const view=(value:PaidToolSnapshot,actor=session,context={currentInstructionRevision:0,evidenceAvailable:true})=>projectNativePaidTool(actor,'root','site',value,now,context);
async function delivered(){const value=fixture();value.status='completed';value.message={messageHash:hash,messageBase64:'private-wire',blockhash:key(5),lastValidBlockHeight:'100',currentBlockHeight:'50',heightObservedAt:before,heightEvidenceRef:'private-height',heightEvidenceHash:hash,feeLamports:'5000',sourceObservationId:'private-source',feeObservationId:'private-fees'};
value.attempt={id:'private-attempt',messageHash:hash,wireHash:hash,signature,blockhash:key(5),lastValidBlockHeight:'100'};
value.payment={status:'finalized_transfer',signature,slot:'100',observedAt:now,...FINANCE_DEVNET_ASSET,sourceAccount:key(1),sourceOwner:key(2),destinationAccount:key(3),destinationOwner:key(4),amountBaseUnits:'10000',feeLamports:'5000',messageHash:hash,transactionEvidenceRef:'private-transaction',transactionEvidenceHash:hash,statusEvidenceRef:'private-status',statusEvidenceHash:hash};
const result={service:'equipment_optimizer_v1',provenance:'controlled_demo_catalogue',currency:'USD',status:'feasible',selectedOfferIds:['package_a'],totalMinor:25000,supplied:{seats:20,microphones:1,projectors:1},evaluatedPackages:7,requestHash:hash,catalogueHash:hash};
value.delivery={artifactRef:'private-artifact',resultHash:await commandDigest({namespace:'pactwoven.paid-tools.delivery.v1',result}),requestHash:hash,resourceHash:await commandDigest({namespace:'pactwoven.paid-tools.resource.v1',service:'equipment_optimizer_v1',computation:'minimum_total_then_fewest_offers_then_sorted_ids',oneOfEachOffer:true,catalogueHash:hash}),paymentSignature:signature,verifiedAt:now,resultBody:result};return value;}
describe('independent paid-tool public projection review',()=>{
  it('does not advertise mutation controls to a read-only human',async()=>{
    const reader=structuredClone(session);reader.actor.actionSiteIds=[];reader.actor.roles=['auditor'];
    expect((await view(fixture(),reader)).actions).toEqual(['check']);
  });
  it('rejects signing without its retained message',async()=>{
    await expect(view({...fixture(),status:'signing'})).rejects.toMatchObject({code:'EVIDENCE_STALE'});
  });
  it('does not accept a changed catalogue merely because its output hash is recomputed',async()=>{
    const value=await delivered();value.delivery!.resultBody.catalogueHash='b'.repeat(64);value.delivery!.resultHash=await commandDigest({namespace:'pactwoven.paid-tools.delivery.v1',result:value.delivery!.resultBody});
    await expect(view(value)).rejects.toMatchObject({code:'EVIDENCE_STALE'});
  });
  it('keeps historical results distinct and hides unavailable content while retaining the payment receipt',async()=>{
    const value=await delivered(),historical=await view(value,session,{currentInstructionRevision:1,evidenceAvailable:true}),hidden=await view(value,session,{currentInstructionRevision:1,evidenceAvailable:false});
    expect(historical.resultApplicability).toBe('historical');expect(historical.delivery).not.toBeNull();expect(historical.notice).toContain('earlier task instructions');
    expect(hidden.delivery).toBeNull();expect(hidden.transaction?.state).toBe('finalized');expect(hidden.allowance.spent.baseUnits).toBe('10000');expect(JSON.stringify(hidden)).not.toContain('private-');
  });
  it('labels cancelled allocation as unallocated rather than refunded or available wallet funds',async()=>{
    const value=await view({...fixture(),status:'cancelled'});
    expect(value.allowance.held.baseUnits).toBe('0');expect(value.allowance.spent.baseUnits).toBe('0');expect(value.allowance.unallocated.baseUnits).toBe('10000');expect(value.actions).toEqual(['check']);
  });
  it('rejects stale-current context that predates the recorded instruction revision',async()=>{
    const value=fixture();value.review.instructionRevision=1;
    await expect(view(value)).rejects.toMatchObject({code:'EVIDENCE_STALE'});
  });
});
