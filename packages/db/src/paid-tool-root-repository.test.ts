import {describe,it,expect,vi} from 'vitest';
import {PostgresPaidToolRootRepository} from './paid-tool-root-repository';
import {PaidToolRootPolicyInputSchema,PaidToolRootQuoteSchema} from './paid-tool-root-schema';
import {PaidToolIntentPrepareSchema,PaidToolIntentConfirmSchema} from './paid-tool-intent-schema';
const selector={organizationId:'org',taskId:'root',generation:3,handoffId:null,leaseToken:'00000000-0000-4000-8000-000000000001'};
const input={schemaVersion:1 as const,expectedInstructionRevision:0,expectedRefreshEpoch:0,quoteId:'quote',selection:null,checkpoint:{requestKey:'original_request_key',expectedCheckpointVersion:2,checkpoint:{stage:'reviewing' as const,summary:'Review the exact computation price.',steps:[]},plannerState:'{}',inputReceipts:[]}};
const frame={rootTaskId:'root',quoteId:'quote',instructionRevision:0,checkpoint:{checkpointVersion:3,generation:4,attempt:1,continuation:'waiting_children',requestKey:'original_request_key'}};
const mock=(response:unknown)=>{const query=vi.fn().mockResolvedValue({rows:[{response}]});return {query,repo:new PostgresPaidToolRootRepository({query} as never)};};
describe('same-root paid attachment adapter',()=>{
 it('accepts original parked root and next generation',async()=>{expect(await mock(frame).repo.wait(selector,input)).toEqual(frame);});
 it.each([{...frame,rootTaskId:'other'},{...frame,quoteId:'other'},{...frame,checkpoint:{...frame.checkpoint,generation:99}},{...frame,checkpoint:{...frame.checkpoint,checkpointVersion:99}}])('rejects misbound wait receipt',async frame=>{await expect(mock(frame).repo.wait(selector,input)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});});
 it('does not promote absent attachment to permission',async()=>{expect(await mock({kind:'none',rootTaskId:'root',instructionRevision:0}).repo.read(selector)).toEqual({kind:'none',rootTaskId:'root',instructionRevision:0});});
 it('rejects another task policy',async()=>{await expect(mock({enabled:false,rootTaskId:'other',instructionRevision:0}).repo.policy(selector)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});});
 it('keeps unknown database details private',async()=>{const m=mock(null);m.query.mockRejectedValue({code:'XX000',message:'private_url_and_key'});await expect(m.repo.read(selector)).rejects.toMatchObject({message:'The paid work update could not be confirmed.'});});
 it('enforces unsigned64 ceiling',()=>{expect(PaidToolRootPolicyInputSchema.safeParse({rootTaskId:'root',siteId:'site',instructionRevision:0,requestKey:'original_request_key',maximumComputationBaseUnits:'18446744073709551616',maximumFeeLamports:'5000',authorization:'separate_quote_required'}).success).toBe(false);});
 it('requires a separate policy review hash when starting opted-in work',()=>{expect(PaidToolIntentConfirmSchema.safeParse({work:{reviewId:'review',reviewToken:'a'.repeat(64),continuesAfterSignOut:true}}).success).toBe(false);});
 it('initial opt-in cannot express payment authorization',()=>{const work={siteId:'site',title:'Workshop',prompt:'Plan equipment.',selections:[],continuesAfterSignOut:true};const paidPolicy={serviceId:'equipment_optimizer_v1',maximumComputationBaseUnits:'10000',maximumFeeLamports:'5000',authorization:'spend_now'};expect(PaidToolIntentPrepareSchema.safeParse({work,paidPolicy}).success).toBe(false);});
 it('public quote contract excludes raw provider fields',()=>{expect(PaidToolRootQuoteSchema.safeParse({rootTaskId:'root',quoteId:'quote',instructionRevision:0,rawProviderToken:'private'}).success).toBe(false);});
});
