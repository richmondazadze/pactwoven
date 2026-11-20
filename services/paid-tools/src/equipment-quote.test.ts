import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PrivateEquipmentQuoteProducer} from './equipment-quote';
import {commandDigest} from '../../../packages/contracts/src/canonical';
import {equipmentRequestHash,equipmentResourceHash,type EquipmentCatalogue} from './equipment-optimizer';
import {transferFixture} from './solana-fixtures.test-support';
async function fixture(){
 const f=transferFixture(),hash='a'.repeat(64),ref={id:'policy',version:1,hash};
 const catalogue:EquipmentCatalogue={version:1,currency:'USD',provenance:'controlled_demo_catalogue',offers:[{id:'seats',label:'Twenty seats',seats:20,microphones:0,projectors:0,priceMinor:5000}]};
 const request={seats:20,microphones:0,projectors:0,budgetMinor:10000};
 const candidate={schemaVersion:1,kind:'equipment_service_selection',authority:'none',scope:{organizationId:'org',siteId:'site',rootTaskId:'root',instructionRevision:0},inputReceipt:{receiptId:randomUUID(),digest:hash},serviceId:'equipment_optimizer_v1',decision:'use_service',reason:'Choose a seating package.',assumptions:[],request,requestHash:await equipmentRequestHash(request),resourceHash:await equipmentResourceHash(catalogue),supportingArtifacts:[{artifactId:'artifact',digest:hash,role:'planning'}]};
 const selection={candidate,selectionHash:await commandDigest({namespace:'pactwoven.equipment-selection.v1',candidate})};
 const quote=vi.fn(async(input:any)=>({id:input.id,quoteHash:input.quote.challenge.hash}));
 const config={catalogue,payee:{id:'provider_payee',version:1,environment:'development' as const,network:'solana-devnet',recipient:f.intent.destinationOwner,assetId:'devnet_usdc',mint:f.intent.mint,tokenProgram:f.intent.tokenProgram,verificationRef:'configured_payee'},allowlistPolicy:ref,deliveryPolicy:ref,priceBaseUnits:'10000'};
 return {quote,producer:new PrivateEquipmentQuoteProducer({quote},config),selection,config};
}
describe('bounded exact equipment quote producer',()=>{
 it('creates deterministic inert quote under original deadline, request and fixed provider',async()=>{const f=await fixture(),input={selection:f.selection,rootDeadlineAt:'2026-11-19T16:05:00Z',maximumSpendBaseUnits:'10000'};const first=await f.producer.propose(input,new AbortController().signal),second=await f.producer.propose(input,new AbortController().signal);expect(second).toEqual(first);expect(f.quote.mock.calls[0]![0]).toEqual(f.quote.mock.calls[1]![0]);expect(f.quote.mock.calls[0]![0].quote.challenge.payee.recipient).toBe(f.config.payee.recipient);expect(f.quote.mock.calls[0]![0].quote.challenge.expiresAt).toBe(input.rootDeadlineAt);});
 it('rejects an amount above the initial ceiling without creating a quote',async()=>{const f=await fixture();await expect(f.producer.propose({selection:f.selection,rootDeadlineAt:'2026-11-19T16:05:00Z',maximumSpendBaseUnits:'9999'},new AbortController().signal)).rejects.toThrow();expect(f.quote).not.toHaveBeenCalled();});
 it('rejects changed demand/catalogue/hash or swapped quote response',async()=>{const f=await fixture();f.selection.candidate.request.seats=21;await expect(f.producer.propose({selection:f.selection,rootDeadlineAt:'2026-11-19T16:05:00Z',maximumSpendBaseUnits:'10000'},new AbortController().signal)).rejects.toThrow();expect(f.quote).not.toHaveBeenCalled();const g=await fixture();g.quote.mockResolvedValue({id:'other',quoteHash:'b'.repeat(64)});await expect(g.producer.propose({selection:g.selection,rootDeadlineAt:'2026-11-19T16:05:00Z',maximumSpendBaseUnits:'10000'},new AbortController().signal)).rejects.toThrow('STATE_REQUIRES_RECONCILIATION');});
});
