import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {paidToolFixture} from './native-paid-tool.test-fixtures';
import {paidEquipmentFixture} from './native-paid-equipment.test-fixtures';
import {paidEquipmentSelection,readPaidEquipment} from './native-paid-equipment';
import {agentWorkScope} from './native-agent-work';
import {nativeSessionFixture} from './native-tasks.test-fixtures';
const scope=()=>agentWorkScope(nativeSessionFixture(),'site_one');
beforeEach(()=>vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL','http://localhost:3108'));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('equipment result binding',()=>{
  it('accepts the exact scoped server selection and matches the recorded hashes',()=>{const view=paidToolFixture(),value=paidEquipmentFixture();expect(paidEquipmentSelection(view,value)).toEqual(value.selection);});
  it.each(['scope','root','operation','revision','catalogue','request','ids','total','capacity','duplicate'])('withholds %s mismatches',kind=>{const view=paidToolFixture(),v=paidEquipmentFixture();
    if(kind==='scope')v.scope.siteId='other';if(kind==='root')v.rootTaskId='other';if(kind==='operation')v.operationId='other';if(kind==='revision')v.instructionRevision++;if(kind==='catalogue')v.selection.catalogueHash='c'.repeat(64);if(kind==='request')v.selection.requestHash='c'.repeat(64);if(kind==='ids')v.selection.items[0]!.id='other';if(kind==='total'){v.selection.totalMinor=40000;v.selection.items[0]!.priceMinor=40000;}if(kind==='capacity')v.selection.items[0]!.seats=1;if(kind==='duplicate'){v.selection.items.push({...v.selection.items[0]!});v.selection.totalMinor=100000;v.selection.budgetMinor=100000;}
    expect(paidEquipmentSelection(view,v)).toBeNull();
  });
  it.each(['historical','unavailable'] as const)('withholds %s receipt enrichment',resultApplicability=>{expect(paidEquipmentSelection({...paidToolFixture(),resultApplicability},paidEquipmentFixture())).toBeNull();});
  it('never displays delivered selection for a pending payment',()=>{expect(paidEquipmentSelection({...paidToolFixture(),state:'payment_pending',delivery:null},paidEquipmentFixture())).toBeNull();});
  it('makes only a fixed GET and rejects changed session after its response',async()=>{const s=scope(),view={...paidToolFixture(),scope:{environment:'development' as const,organizationId:s.organizationId,siteId:s.siteId}},value={...paidEquipmentFixture(),scope:view.scope};const fetch=vi.fn().mockResolvedValue(Response.json(value));vi.stubGlobal('fetch',fetch);const token=vi.fn(async()=> 'test-only');expect(await readPaidEquipment(view,s,token,()=>s,new AbortController().signal)).toEqual(value);expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]![0]).toContain('/purchases/hidden-operation/equipment?siteId=site_one');expect(fetch.mock.calls[0]![1].method??'GET').toBe('GET');expect(fetch.mock.calls[0]![1].body).toBeUndefined();
    fetch.mockImplementationOnce(async()=>{s.sessionId='changed';return Response.json(value)});const before={...s};await expect(readPaidEquipment(view,before,token,()=>s,new AbortController().signal)).rejects.toThrow('workspace changed');
  });
  it('does not request equipment for an unqualified or foreign receipt',async()=>{const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(readPaidEquipment(paidToolFixture(),scope(),async()=> 'test-only',scope,new AbortController().signal)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();});
});
