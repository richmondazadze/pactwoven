import { describe, expect, it } from 'vitest';
import { equipmentReceiptFixture } from './native-paid-equipment.test-fixture';

describe('stored-catalogue equipment result enrichment',()=>{
  it('returns actual chosen labels and prices adding to the independently recomputed435USD result',async()=>{
    const f=await equipmentReceiptFixture(),result=await f.service.read(f.session,'root','site','operation');
    expect(result.selection.totalMinor).toBe(43500);expect(result.selection.budgetMinor).toBe(50000);
    expect(result.selection.items.map(item=>item.label)).toEqual(['Two wireless microphones','Projector and screen','20-seat package','40-seat package']);
    expect(result.selection.items.reduce((sum,item)=>sum+item.priceMinor,0)).toBe(43500);
    expect(result.selection.items.reduce((sum,item)=>sum+item.seats,0)).toBe(60);
    expect(JSON.stringify(result)).not.toMatch(/private-|signature|sourceAccount|reviewHash|messageBase64/);
    expect(f.human.read).toHaveBeenCalledOnce();expect(f.roots.quote).toHaveBeenCalledExactlyOnceWith(f.session.actor,'root','site','quote');
  });
  it('returns a truthful empty selection when the computation finds no feasible package',async()=>{
    const f=await equipmentReceiptFixture(100),result=await f.service.read(f.session,'root','site','operation');
    expect(result.selection).toMatchObject({status:'no_feasible_package',items:[],totalMinor:null,budgetMinor:100});
  });
  it.each(['environment','principal','site','sessionSite'])('rejects%s before any data read',async(kind)=>{
    const f=await equipmentReceiptFixture();if(kind==='environment')f.session.actor.environment='production';if(kind==='principal')f.session.actor.principalKind='service';if(kind==='site')f.session.actor.siteIds=[];if(kind==='sessionSite')f.session.sites=[];
    await expect(f.service.read(f.session,'root','site','operation')).rejects.toThrow();expect(f.human.read).not.toHaveBeenCalled();
  });
  it.each(['operation','root','organization','unavailable','historical','notDelivered'])('withholds%s before catalogue lookup',async(kind)=>{
    const f=await equipmentReceiptFixture();if(kind==='operation')f.snapshot.operationId='other';if(kind==='root')f.snapshot.review.rootTaskId='other';if(kind==='organization')f.snapshot.review.organizationId='other';if(kind==='unavailable')f.snapshot.evidenceAvailable=false;if(kind==='historical')f.snapshot.currentInstructionRevision=1;if(kind==='notDelivered')f.snapshot.status='payment_confirmed';
    await expect(f.service.read(f.session,'root','site','operation')).rejects.toThrow();expect(f.roots.quote).not.toHaveBeenCalled();
  });
  it.each(['label','price','demand','quoteId','root','revision','recipient','challengeHash','requestHash','resourceHash','amount','deliveredSelection'])('rejects substituted%s instead of inventing a label map',async(kind)=>{
    const f=await equipmentReceiptFixture();if(kind==='label')f.quote.resourceBody.offers[0]!.label='Unreviewed label';if(kind==='price')f.quote.resourceBody.offers[0]!.priceMinor=1;if(kind==='demand')f.quote.requestBody.seats=20;if(kind==='quoteId')f.quote.quoteId='other';if(kind==='root')f.quote.rootTaskId='other';if(kind==='revision')f.quote.instructionRevision=1;if(kind==='recipient')f.quote.quote.challenge.payee.recipient=f.snapshot.review.sourceOwner;if(kind==='challengeHash')f.quote.quote.challenge.hash='b'.repeat(64);if(kind==='requestHash')f.quote.quote.request.hash='b'.repeat(64);if(kind==='resourceHash')f.quote.quote.resource.hash='b'.repeat(64);if(kind==='amount')f.quote.quote.challenge.amountBaseUnits='1';if(kind==='deliveredSelection')f.snapshot.delivery.resultBody.selectedOfferIds=['workshop_60'];
    await expect(f.service.read(f.session,'root','site','operation')).rejects.toThrow();
  });
  it('allows a current read-only member without giving any spending authority',async()=>{
    const f=await equipmentReceiptFixture();f.session.actor.roles=['auditor'];f.session.actor.actionSiteIds=[];
    expect((await f.service.read(f.session,'root','site','operation')).selection.items).toHaveLength(4);
    expect(Object.keys(f.human)).toEqual(['read']);expect(Object.keys(f.roots)).toEqual(['quote']);
  });
});
