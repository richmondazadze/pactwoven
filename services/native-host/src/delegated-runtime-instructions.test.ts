import {beforeEach,describe,expect,it,vi} from 'vitest';
import {PostgresNativeRootInstructionCoordinatorRepository,PostgresNativeRootInstructionWorkerRepository} from '../../../packages/db/src/native-root-instruction-repository';
import {PostgresNativeRootRefreshCoordinatorRepository,PostgresNativeRootRefreshWorkerRepository} from '../../../packages/db/src/native-root-refresh-repository';
const captured=vi.hoisted(()=>({coordinator:vi.fn(),specialist:vi.fn()}));
vi.mock('../../coordinator/src/delegated-coordinator',()=>({DelegatedCoordinator:class {constructor(options:any){captured.coordinator(options);}run=vi.fn();}}));
vi.mock('../../coordinator/src/delegated-specialist',()=>({DelegatedSpecialist:class {constructor(options:any){captured.specialist(options);}run=vi.fn();}}));
import {createDelegatedRuntime} from './delegated-runtime';
function fixture(){
 const query=vi.fn(),complete=vi.fn(),observe=vi.fn(),send=vi.fn(),pool={query};const identity={serviceId:'specialist',serviceVersion:1,workloadIdentityId:'specialist'};
 const options:any={environment:'simulation',services:{coordinator:{...identity,serviceId:'coordinator'},research:identity,planning:identity,escalation:identity},pools:{coordinator:pool,worker:pool,dispatcher:pool},gateway:{complete},observe,send};return{options,effects:[query,complete,observe,send]};
}
describe('bounded host exact root protocol composition',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it.each(['legacy','refresh','instructions'] as const)('constructs only the selected %s data protocol and performs no effects at composition',protocol=>{
  const x=fixture();const runtime=createDelegatedRuntime({...x.options,protocol});expect(runtime).toHaveProperty('consume');expect(captured.coordinator).toHaveBeenCalledOnce();expect(captured.specialist).toHaveBeenCalledOnce();
  const coordinator=captured.coordinator.mock.calls[0]![0],specialist=captured.specialist.mock.calls[0]![0];
  if(protocol==='instructions'){expect(coordinator.instructions).toBeInstanceOf(PostgresNativeRootInstructionCoordinatorRepository);expect(specialist.instructions).toBeInstanceOf(PostgresNativeRootInstructionWorkerRepository);expect(coordinator.refresh).toBeUndefined();expect(specialist.refresh).toBeUndefined();}
  else if(protocol==='refresh'){expect(coordinator.refresh).toBeInstanceOf(PostgresNativeRootRefreshCoordinatorRepository);expect(specialist.refresh).toBeInstanceOf(PostgresNativeRootRefreshWorkerRepository);expect(coordinator.instructions).toBeUndefined();expect(specialist.instructions).toBeUndefined();}
  else for(const value of [coordinator,specialist]){expect(value.refresh).toBeUndefined();expect(value.instructions).toBeUndefined();}
  for(const effect of x.effects)expect(effect).not.toHaveBeenCalled();
 });
 it('rejects an unknown protocol instead of silently selecting legacy',()=>{
  const x=fixture();expect(()=>createDelegatedRuntime({...x.options,protocol:'newer_unqualified'})).toThrow('Unknown root protocol.');expect(captured.coordinator).not.toHaveBeenCalled();for(const effect of x.effects)expect(effect).not.toHaveBeenCalled();
 });
 it.each(['refresh','instructions'] as const)('rejects Calendar plus %s before repository/model use',protocol=>{
  const x=fixture();expect(()=>createDelegatedRuntime({...x.options,protocol,externalCalendar:{input:{},disposition:{}}})).toThrow('Calendar is unavailable in this bounded runtime.');expect(captured.coordinator).not.toHaveBeenCalled();for(const effect of x.effects)expect(effect).not.toHaveBeenCalled();
 });
});
