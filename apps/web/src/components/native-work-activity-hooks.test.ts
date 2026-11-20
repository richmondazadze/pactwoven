import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nativeSessionFixture } from '../lib/native-tasks.test-fixtures';
import { agentWorkFixture } from '../lib/native-agent-work.test-fixtures';
import { demoActivityFixture } from '../lib/demo-workspace.test-fixtures';
import { useNativeWorkActivity } from './native-work-activity-hooks';

const mocks=vi.hoisted(()=>({effects:[] as (()=>(()=>void)|void)[],setVisible:vi.fn(),useQuery:vi.fn(),data:undefined as unknown,error:null as unknown,
 cancelQueries:vi.fn(async()=>{}),removeQueries:vi.fn(),invalidateQueries:vi.fn(async()=>{})}));
vi.mock('react',()=>({useRef:(value:unknown)=>({current:value}),useLayoutEffect:()=>{},
 useState:(initial:()=>boolean)=>[initial(),mocks.setVisible],useEffect:(effect:()=>()=>void)=>mocks.effects.push(effect)}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>{mocks.useQuery(options);return{data:mocks.data,error:mocks.error};},useQueryClient:()=>mocks}));
vi.mock('./workspace-provider',()=>({useWorkspace:()=>({session:nativeSessionFixture(),getToken:async()=> 'synthetic'})}));
beforeEach(()=>{vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL','http://localhost:3108');vi.stubGlobal('window',new EventTarget());vi.stubGlobal('navigator',{onLine:true});vi.stubGlobal('document',{visibilityState:'visible'});vi.clearAllMocks();mocks.effects.length=0;mocks.data=undefined;mocks.error=null;});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

it('starts only visible permitted observations and never polls in background',()=>{
 const work=agentWorkFixture();useNativeWorkActivity('site_one',work,false);
 const disabled=mocks.useQuery.mock.calls[0]![0];expect(disabled.enabled).toBe(false);expect(disabled.refetchInterval({state:{error:null}})).toBe(false);
 useNativeWorkActivity('site_one',work,true);const enabled=mocks.useQuery.mock.calls[1]![0];expect(enabled.enabled).toBe(true);expect(enabled.refetchIntervalInBackground).toBe(false);expect(enabled.refetchInterval({state:{error:null}})).toBe(3500);
 expect(enabled.refetchInterval({state:{error:new Error()}})).toBe(false);
});
it('cancels on hide and invalidates before resuming the same key on visibility return',()=>{
 const events=new EventTarget(),document={visibilityState:'visible',addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)};
 vi.stubGlobal('document',document);useNativeWorkActivity('site_one',agentWorkFixture());const options=mocks.useQuery.mock.calls[0]![0],cleanup=mocks.effects[0]!();
 document.visibilityState='hidden';events.dispatchEvent(new Event('visibilitychange'));expect(mocks.cancelQueries).toHaveBeenCalledOnce();expect(mocks.setVisible).toHaveBeenLastCalledWith(false);
 document.visibilityState='visible';events.dispatchEvent(new Event('visibilitychange'));expect(mocks.invalidateQueries).toHaveBeenCalledExactlyOnceWith({queryKey:options.queryKey,exact:true,refetchType:'none'});expect(mocks.setVisible).toHaveBeenLastCalledWith(true);
 cleanup?.();expect(mocks.removeQueries).toHaveBeenCalledExactlyOnceWith({queryKey:options.queryKey,exact:true});
});
it('refuses late dispatch after going offline',async()=>{
 const navigator={onLine:true};vi.stubGlobal('navigator',navigator);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 useNativeWorkActivity('site_one',agentWorkFixture());const options=mocks.useQuery.mock.calls[0]![0];navigator.onLine=false;
 await expect(options.queryFn({signal:new AbortController().signal})).rejects.toMatchObject({code:'OBSERVATION_PAUSED'});expect(fetch).not.toHaveBeenCalled();
});
it('withholds mismatched revisions and stale cached data after a failed read',()=>{
 const activity=demoActivityFixture(),work={...agentWorkFixture(),id:activity.rootTaskId,updatedAt:activity.recordedAt,controlVersion:activity.revision.controlVersion};mocks.data={activity};
 expect(useNativeWorkActivity('site_one',work).activity).toEqual(activity);
 expect(useNativeWorkActivity('site_one',{...work,controlVersion:2}).activity).toBeUndefined();
 mocks.error=new Error('read rejected');expect(useNativeWorkActivity('site_one',work).activity).toBeUndefined();
});
