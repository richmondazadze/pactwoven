import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nativeSessionFixture } from '../lib/native-tasks.test-fixtures';
import { useAgentWorkDetail } from './native-agent-work-hooks';

const mocks=vi.hoisted(()=>({effects:[] as (()=>(()=>void)|void)[],setVisible:vi.fn(),useQuery:vi.fn(),
 cancelQueries:vi.fn(async()=>{}),removeQueries:vi.fn(),invalidateQueries:vi.fn(async()=>{})}));
vi.mock('react',()=>({useRef:(value:unknown)=>({current:value}),useLayoutEffect:()=>{},
 useState:(initial:()=>boolean)=>[initial(),mocks.setVisible],useEffect:(effect:()=>()=>void)=>mocks.effects.push(effect)}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>{mocks.useQuery(options);return{data:undefined,error:null};},useQueryClient:()=>mocks}));
vi.mock('./workspace-provider',()=>({useWorkspace:()=>({session:nativeSessionFixture(),getToken:async()=> 'synthetic'})}));
beforeEach(()=>{vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL','http://localhost:3108');vi.stubGlobal('window',new EventTarget());vi.stubGlobal('navigator',{onLine:true});vi.clearAllMocks();mocks.effects.length=0;});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

it('suspends hidden observations and resumes the same R5 work read on visible return',()=>{
 const events=new EventTarget(),document={visibilityState:'visible',addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)};
 vi.stubGlobal('document',document);useAgentWorkDetail('site_one','root_internal');
 const options=mocks.useQuery.mock.calls[0]![0];expect(options.refetchInterval({state:{data:{work:{state:'waiting'}},error:null}})).toBe(3500);
 expect(options.refetchIntervalInBackground).toBe(false);expect(options.retry).toBe(false);
 const cleanup=mocks.effects[0]!();document.visibilityState='hidden';events.dispatchEvent(new Event('visibilitychange'));
 expect(mocks.cancelQueries).toHaveBeenCalledOnce();expect(mocks.setVisible).toHaveBeenLastCalledWith(false);expect(mocks.invalidateQueries).not.toHaveBeenCalled();
 document.visibilityState='visible';events.dispatchEvent(new Event('visibilitychange'));
 expect(mocks.invalidateQueries).not.toHaveBeenCalled();
 expect(mocks.setVisible).toHaveBeenLastCalledWith(true);
 cleanup?.();expect(mocks.removeQueries).toHaveBeenCalledExactlyOnceWith({queryKey:options.queryKey,exact:true});
 events.dispatchEvent(new Event('visibilitychange'));expect(mocks.invalidateQueries).not.toHaveBeenCalled();
});
it('does not poll a waiting request when the detail first mounts hidden',()=>{
 vi.stubGlobal('document',{visibilityState:'hidden'});useAgentWorkDetail('site_one','root_internal');
 const options=mocks.useQuery.mock.calls[0]![0];expect(options.enabled).toBe(false);
 expect(options.refetchInterval({state:{data:{work:{state:'waiting'}},error:null}})).toBe(false);
});
it('does not begin observing when a visible detail first mounts offline',()=>{
 vi.stubGlobal('document',{visibilityState:'visible'});vi.stubGlobal('navigator',{onLine:false});useAgentWorkDetail('site_one','root_internal');
 const options=mocks.useQuery.mock.calls[0]![0];expect(options.enabled).toBe(false);
 expect(options.refetchInterval({state:{data:{work:{state:'working'}},error:null}})).toBe(false);
});
it('refuses a saved query callback if connectivity changes before dispatch',async()=>{
 const navigator={onLine:true};vi.stubGlobal('document',{visibilityState:'visible'});vi.stubGlobal('navigator',navigator);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 useAgentWorkDetail('site_one','root_internal');const options=mocks.useQuery.mock.calls[0]![0];navigator.onLine=false;
 await expect(options.queryFn({signal:new AbortController().signal})).rejects.toMatchObject({code:'OBSERVATION_PAUSED'});expect(fetch).not.toHaveBeenCalled();
});
it('cancels offline work reads, refreshes the same key on reconnect, and removes both network listeners',()=>{
 const events=new EventTarget(),document={visibilityState:'visible',addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)},navigator={onLine:true};
 vi.stubGlobal('document',document);vi.stubGlobal('navigator',navigator);useAgentWorkDetail('site_one','root_internal');
 const options=mocks.useQuery.mock.calls[0]![0],cleanup=mocks.effects[0]!();
 navigator.onLine=false;window.dispatchEvent(new Event('offline'));
 expect(mocks.cancelQueries).toHaveBeenCalledExactlyOnceWith({queryKey:options.queryKey,exact:true});expect(mocks.setVisible).toHaveBeenLastCalledWith(false);
 document.visibilityState='hidden';navigator.onLine=true;window.dispatchEvent(new Event('online'));
 expect(mocks.invalidateQueries).not.toHaveBeenCalled();expect(mocks.setVisible).toHaveBeenLastCalledWith(false);
 document.visibilityState='visible';events.dispatchEvent(new Event('visibilitychange'));
 expect(mocks.invalidateQueries).not.toHaveBeenCalled();
 expect(mocks.setVisible).toHaveBeenLastCalledWith(true);
 cleanup?.();vi.clearAllMocks();window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'));
 expect(mocks.setVisible).not.toHaveBeenCalled();expect(mocks.cancelQueries).not.toHaveBeenCalled();
});
