import {describe,it,expect,vi} from 'vitest';
import {commandDigest} from '../../contracts/src/canonical';
import {PostgresNativeRootInstructionCoordinatorRepository} from './native-root-instruction-repository';
import {nativeRootRefreshV3RequestKey} from './native-root-instruction-schema';
const selector={organizationId:'org',taskId:'root',generation:5,handoffId:null,leaseToken:'b8878b4d-a35f-4c5e-8abc-a89174c570bf'};
const checkpoint={schemaVersion:3 as const,expectedInstructionRevision:2,expectedRefreshEpoch:1,command:{requestKey:'checkpoint_operation_1',expectedCheckpointVersion:8,checkpoint:{stage:'working' as const,summary:'Applying updated instructions.',steps:[]},plannerState:'{}',inputReceipts:[]}};
const receipt={schemaVersion:3,instructionRevision:2,refreshEpoch:1,receipt:{checkpointVersion:9,generation:5,attempt:2,continuation:'running',requestKey:'checkpoint_operation_1'}};
describe('v3 instruction-aware repository fencing',()=>{
 it('binds the accepted checkpoint to both independent revision and refresh epoch',async()=>{const query=vi.fn().mockResolvedValue({rows:[{response:receipt}]}),repo=new PostgresNativeRootInstructionCoordinatorRepository({query}as never,'simulation');expect(await repo.checkpointV3(selector,checkpoint)).toEqual(receipt);expect(query.mock.calls[0]![0]).toContain('native_delegation_root_checkpoint_v3');});
 it.each(['instructionRevision','refreshEpoch','schemaVersion'])('retains uncertainty when response %s differs',async field=>{const query=vi.fn().mockResolvedValue({rows:[{response:{...receipt,[field]:9}}]}),repo=new PostgresNativeRootInstructionCoordinatorRepository({query}as never,'simulation');await expect(repo.checkpointV3(selector,checkpoint)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});expect(query).toHaveBeenCalledTimes(1);});
 it('uses exact v3 refresh command digest and revision during recovery',async()=>{const body={schemaVersion:3 as const,expectedInstructionRevision:2,expectedRefreshEpoch:1,expectedCheckpointVersion:8,results:[{handoffId:'result',publicationDigest:'a'.repeat(64)}]},key=await nativeRootRefreshV3RequestKey('refresh',{environment:'simulation',organizationId:'org',rootTaskId:'root',generation:5},body),command={...body,requestKey:key};
 const result={schemaVersion:3,instructionRevision:2,kind:'refresh',requestKey:key,intentDigest:await commandDigest(command),rootTaskId:'root',previousGeneration:5,generation:6,previousEpoch:1,refreshEpoch:2,attempt:3,checkpointVersion:9,lineageDigest:'b'.repeat(64),admittedTaskIds:[],pendingCount:1,continuation:'yielded',domainCompletion:false};
 const query=vi.fn().mockResolvedValue({rows:[{response:result}]}),repo=new PostgresNativeRootInstructionCoordinatorRepository({query}as never,'simulation');expect(await repo.refreshV3(selector,command)).toEqual(result);
 const lookup={kind:'refresh' as const,requestKey:key,intentDigest:result.intentDigest,instructionRevision:2};expect(await repo.refreshOperationV3({organizationId:'org',taskId:'root',generation:5},lookup)).toEqual(result);
 query.mockResolvedValue({rows:[{response:{...result,instructionRevision:1}}]});await expect(repo.refreshOperationV3({organizationId:'org',taskId:'root',generation:5},lookup)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
});
