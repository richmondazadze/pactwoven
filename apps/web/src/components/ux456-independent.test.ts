import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeSessionFixture } from '../lib/native-tasks.test-fixtures';
import { paidQuoteFixture, paidQuoteReviewFixture } from '../lib/native-paid-quote.test-fixtures';
import { createPaidQuoteAttempt, readPaidQuoteAttempt, retainPaidQuoteReview, storePaidQuoteAttempt } from '../lib/native-paid-quote';
import { buildAgentWorkflowChain, selectChainObservation } from '../lib/agent-workflow-chain';
import { demoActivityFixture } from '../lib/demo-workspace.test-fixtures';
import { agentWorkFixture } from '../lib/native-agent-work.test-fixtures';
import { AgentWorkflowChain } from './agent-workflow-chain';
import { NativeAgentWorkspaceContent, NativeAgentWorkContent } from './native-agent-work-detail';
import { NativeEquipmentPaymentPanel } from './native-equipment-payment-panel';

// Execute the real controller and storage/review helpers, with network/query and
// React lifecycle boundaries simulated. Real browser focus/layout is qualified separately.
const h=vi.hoisted(()=>({frame:null as any,activityQuery:null as any,binding:null as any,discovery:null as any,online:true,inView:true,observer:null as any,
  review:vi.fn(),send:vi.fn(),recover:vi.fn(),events:null as any,windowEvents:null as any}));
vi.mock('react',async original=>({...await original<any>(),
  useId:()=> 'independent-id',
  useState:(initial:any)=>{const f=h.frame,i=f.cursor++;if(!(i in f.cells))f.cells[i]=typeof initial==='function'?initial():initial;return[f.cells[i],(v:any)=>{const next=typeof v==='function'?v(f.cells[i]):v;if(!Object.is(next,f.cells[i])){f.cells[i]=next;f.dirty=true;}}];},
  useRef:(initial:any)=>{const f=h.frame,i=f.cursor++;return f.cells[i]??(f.cells[i]={current:initial});},
  useEffect:(fn:any,deps:any[])=>{const f=h.frame,i=f.cursor++,old=f.cells[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n]))){f.cells[i]={deps,cleanup:old?.cleanup};f.effects.push(()=>{old?.cleanup?.();f.cells[i].cleanup=fn();});}},
}));
vi.mock('./workspace-provider',()=>({useWorkspace:()=>({session:nativeSessionFixture()})}));
vi.mock('./native-agent-work-hooks',()=>({canObserveAgentWork:()=>h.online,useAgentWorkBinding:()=>h.binding}));
vi.mock('./native-work-activity-hooks',()=>({useNativeWorkActivity:()=>h.activityQuery}));
vi.mock('./native-work-team-activity-hooks',()=>({useNativeWorkTeamActivity:()=>({})}));
vi.mock('./native-paid-quote-hooks',()=>({useNativeEquipmentDiscovery:()=>h.discovery}));
vi.mock('./native-paid-tool-hooks',()=>({useNativePaidToolRead:()=>({purchase:null,error:null,refetch:vi.fn(),isFetching:false}),useNativePaidToolControl:()=>({busy:false,hasPending:false,error:null})}));
vi.mock('./native-paid-equipment-hooks',()=>({useNativePaidEquipment:()=>({enabled:false})}));
vi.mock('./native-paid-history-hooks',()=>({useNativePaidHistory:()=>({enabled:false})}));
vi.mock('./native-paid-contributors',()=>({useNativePaidContributors:()=>({}),RecordedEquipmentContributors:'Contributors'}));
vi.mock('./ui',()=>({Alert:'Alert',LoadingState:'LoadingState',ActionLabel:'ActionLabel'}));
vi.mock('./equipment-payment-dialog',async original=>({...await original<any>(),EquipmentPaymentDialog:'PaymentDialog',EquipmentPaymentFacts:'PaymentFacts',EquipmentPaymentProgress:'PaymentProgress'}));
vi.mock('../lib/native-paid-quote',async original=>({...await original<any>(),requestPaidQuoteReview:(...a:any[])=>h.review(...a),sendPaidQuoteApproval:(...a:any[])=>h.send(...a),recoverPaidQuoteApproval:(...a:any[])=>h.recover(...a)}));
function storage(){const data=new Map<string,string>();return{data,get length(){return data.size;},key:(i:number)=>[...data.keys()][i]??null,getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};}
function elements(v:any):any[]{if(Array.isArray(v))return v.flatMap(elements);if(!v||typeof v!=='object'||!('type'in v))return[];return[v,...elements(v.props.children)];}
function text(v:any):string{if(Array.isArray(v))return v.map(text).join('');if(v==null||typeof v==='boolean')return'';if(typeof v==='string'||typeof v==='number')return String(v);return v.props?.label??text(v.props?.children);}
const mounted:any[]=[];
function mount(overrides:Record<string,unknown>={}){
  let props:any={siteId:'hidden-site',rootTaskId:'hidden-task',workState:'waiting',workControlVersion:1,evidenceAvailable:true,revisionKey:'revision-one',observing:true,canAuthorize:true,...overrides};
  const frame={cursor:0,cells:[]as any[],effects:[]as any[],dirty:false};let tree:any;
  function render(){for(let round=0;round<20;round++){frame.cursor=0;frame.effects=[];frame.dirty=false;h.frame=frame;const child=NativeEquipmentPaymentPanel(props);tree=(child.type as (props:any)=>ReactElement)(child.props);for(const n of elements(tree)){if(n.props.ref&&typeof n.props.ref==='object')n.props.ref.current={focus:vi.fn(),isConnected:true,disabled:n.props.disabled??false};}frame.effects.forEach(f=>f());if(!frame.dirty)return tree;}throw Error('Unsettled controller');}
  const view={render,get tree(){return tree;},get dialog(){return elements(tree).find(n=>n.type==='PaymentDialog');},patch:(next:any)=>{props={...props,...next};render();},button:(label:string)=>{const n=elements(tree).find(n=>n.type==='button'&&text(n)===label);if(!n)throw Error(`Missing ${label}`);return n;},input:()=>elements(tree).find(n=>n.type==='input'&&n.props.type==='checkbox'),unmount:()=>{for(const c of frame.cells)c?.cleanup?.();}};mounted.push(view);render();return view;
}
async function settle(view:any){for(let n=0;n<10;n++){await Promise.resolve();view.render();}}
let store:ReturnType<typeof storage>;
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-20T05:00:00Z'));vi.stubEnv('NEXT_PUBLIC_API_BASE_URL','https://api.example.test');
  store=storage();h.online=true;h.inView=true;h.events=new EventTarget();h.windowEvents=new EventTarget();
  vi.stubGlobal('sessionStorage',store);vi.stubGlobal('document',h.events);vi.stubGlobal('window',Object.assign(h.windowEvents,{setTimeout,clearTimeout}));
  vi.stubGlobal('IntersectionObserver',class{constructor(callback:any){h.observer=callback;}observe(){h.observer([{isIntersecting:h.inView}]);}disconnect(){}});
  const quote=paidQuoteFixture();h.discovery={data:{state:'awaiting_review',quote,operationId:null},error:null,refetch:vi.fn()};
  const scope={apiBase:'https://api.example.test',environment:'development',organizationId:'hidden-org',actorId:'operator',sessionId:'session',siteId:'hidden-site'};
  h.binding={scope,current:()=>scope,getToken:vi.fn(),controller:{current:new AbortController()},live:{current:true}};
  h.review.mockReset().mockImplementation(async(a:any)=>paidQuoteReviewFixture(a.quote,a.reviewId));h.send.mockReset();h.recover.mockReset();
});
afterEach(()=>{mounted.splice(0).forEach(v=>v.unmount());vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('independent exact-payment controller regression',()=>{
  it('auto-opens once without review/payment and remains dismissed after rerender or remount',()=>{
    const view=mount();expect(view.dialog.props.open).toBe(true);expect(h.review).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();
    view.dialog.props.onOpenChange(false);view.render();expect(view.dialog.props.open).toBe(false);view.patch({revisionKey:'revision-two'});expect(view.dialog.props.open).toBe(false);
    view.unmount();expect(mount().dialog.props.open).toBe(false);expect(view.button('Review payment').props.disabled).toBe(false);
  });
  it.each([{canAuthorize:false},{observing:false},{evidenceAvailable:false},{workState:'paused'},{workState:'cancelled'},{workState:'completed'}])('does not auto-open outside actionable current authority: %j',props=>{
    const view=mount(props);expect(view.dialog.props.open).toBe(false);expect(h.review).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();
  });
  it('does not auto-open offscreen or offline; entering view opens once',()=>{
    h.inView=false;const view=mount();expect(view.dialog.props.open).toBe(false);h.observer([{isIntersecting:true}]);view.render();expect(view.dialog.props.open).toBe(true);
    h.online=false;h.windowEvents.dispatchEvent(new Event('offline'));view.render();expect(view.dialog.props.open).toBe(false);h.online=true;view.patch({observing:true});expect(view.dialog.props.open).toBe(false);
  });
  it('dismissal preserves exact review identity and clears consent on reopen',async()=>{
    const view=mount();view.button('Review exact payment').props.onClick();await settle(view);expect(h.review).toHaveBeenCalledTimes(1);
    const before=readPaidQuoteAttempt(store,h.binding.scope,'hidden-task');expect(before?.review).not.toBeNull();view.input().props.onChange({target:{checked:true}});view.render();expect(view.input().props.checked).toBe(true);
    view.dialog.props.onOpenChange(false);view.render();view.button('Review payment').props.onClick();view.render();expect(view.input().props.checked).toBe(false);expect(readPaidQuoteAttempt(store,h.binding.scope,'hidden-task')).toEqual(before);expect(h.send).not.toHaveBeenCalled();
  });
  it('expiry while open clears consent and disables approval without renewing or discarding the review',async()=>{
    const view=mount();view.button('Review exact payment').props.onClick();await settle(view);view.input().props.onChange({target:{checked:true}});view.render();const before=readPaidQuoteAttempt(store,h.binding.scope,'hidden-task');
    vi.advanceTimersByTime(300010);view.render();expect(view.input().props.checked).toBe(false);expect(view.button('Approve 0.01 devnet USDC computation').props.disabled).toBe(true);expect(readPaidQuoteAttempt(store,h.binding.scope,'hidden-task')).toEqual(before);expect(h.send).not.toHaveBeenCalled();
  });
  it('revision change closes the dialog, clears consent, and retains the original review',async()=>{
    const view=mount();view.button('Review exact payment').props.onClick();await settle(view);view.input().props.onChange({target:{checked:true}});view.render();const before=readPaidQuoteAttempt(store,h.binding.scope,'hidden-task');
    view.patch({revisionKey:'revision-two'});expect(view.dialog.props.open).toBe(false);expect(readPaidQuoteAttempt(store,h.binding.scope,'hidden-task')).toEqual(before);expect(h.send).not.toHaveBeenCalled();
  });
  it('permission loss clears checked consent and disables approval',async()=>{
    const view=mount();view.button('Review exact payment').props.onClick();await settle(view);view.input().props.onChange({target:{checked:true}});view.render();view.patch({canAuthorize:false});expect(view.input().props.checked).toBe(false);expect(view.button('Approve 0.01 devnet USDC computation').props.disabled).toBe(true);
  });
  it('late exact-review response after dismissal never reopens or selects consent',async()=>{
    let resolve!:(v:any)=>void;h.review.mockImplementation((a:any)=>new Promise(r=>{resolve=()=>r(paidQuoteReviewFixture(a.quote,a.reviewId));}));
    const view=mount();view.button('Review exact payment').props.onClick();view.render();view.dialog.props.onOpenChange(false);view.render();resolve(null);await settle(view);expect(view.dialog.props.open).toBe(false);expect(view.input().props.checked).toBe(false);expect(h.send).not.toHaveBeenCalled();
  });
  it('uncertain approval retains one command identity and requires checking it before retry',async()=>{
    h.send.mockRejectedValue(new Error('Response lost'));h.recover.mockResolvedValue({purchase:null});
    const view=mount();view.button('Review exact payment').props.onClick();await settle(view);view.input().props.onChange({target:{checked:true}});view.render();view.button('Approve 0.01 devnet USDC computation').props.onClick();await settle(view);
    const original=readPaidQuoteAttempt(store,h.binding.scope,'hidden-task');expect(original?.approval).not.toBeNull();expect(h.send).toHaveBeenCalledTimes(1);
    view.dialog.props.onOpenChange(false);view.render();view.button('Check original approval').props.onClick();await settle(view);
    expect(h.recover).toHaveBeenCalledTimes(1);expect(h.recover.mock.calls[0]![0].approval.commandKey).toBe(original!.approval!.commandKey);expect(view.input().props.checked).toBe(false);expect(view.button('Retry original approval').props.disabled).toBe(true);expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('restores original stored review without implicit authorization',()=>{
    let attempt=createPaidQuoteAttempt(h.binding.scope,'hidden-task',h.discovery.data.quote);attempt=retainPaidQuoteReview(attempt,paidQuoteReviewFixture(attempt.quote,attempt.reviewId));storePaidQuoteAttempt(store,attempt);
    const view=mount();expect(view.dialog.props.open).toBe(true);expect(readPaidQuoteAttempt(store,h.binding.scope,'hidden-task')).toEqual(attempt);expect(h.review).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();
  });
});


describe('independent chain observation integrity',()=>{
  function fixture(){const activity=demoActivityFixture(),now=Date.parse(activity.asOf);const work={...agentWorkFixture(),id:activity.rootTaskId,updatedAt:activity.recordedAt,controlVersion:activity.revision.controlVersion,expiresAt:activity.expiresAt,state:'waiting' as const};const team={rootTaskId:work.id,recordedAt:work.updatedAt,asOf:activity.asOf,validUntil:activity.freshUntil,controlVersion:work.controlVersion,instructionRevision:0,status:'verified' as const,authority:'none' as const,agents:[{id:'lease-research',role:'research' as const,label:'Research' as const,state:'working' as const},{id:'lease-planning',role:'planning' as const,label:'Planning' as const,state:'working' as const}]};return{activity,work,teamActivity:team,observing:true,now};}
  it('shows distinct concurrent leased agents but never merges their IDs with recorded actors',()=>{
    const input=fixture(),chain=buildAgentWorkflowChain(input);expect(chain.nodes.filter(n=>n.key.startsWith('current:'))).toHaveLength(2);expect(new Set(chain.nodes.map(n=>n.key)).size).toBe(chain.nodes.length);expect(chain.nodes.filter(n=>n.role==='research')).toHaveLength(1);
    input.activity.actions[1]!.state='completed';const withRecorded=buildAgentWorkflowChain(input);expect(withRecorded.nodes.filter(n=>n.role==='research')).toHaveLength(2);expect(withRecorded.completedContributions).toBe(1);
  });
  it('stale, paused, cancelled and hidden data cannot display live work',()=>{
    const input=fixture();for(const changed of [{observing:false},{now:input.now+10001},{work:{...input.work,state:'paused' as const}},{work:{...input.work,state:'cancelled' as const}}]){const chain=buildAgentWorkflowChain({...input,...changed});expect(chain.workingCount).toBe(0);expect(chain.nodes.some(n=>n.live)).toBe(false);}
  });
  it('rejects current team metadata from another instruction revision or work identity',()=>{
    const input=fixture();for(const teamActivity of [{...input.teamActivity,instructionRevision:1},{...input.teamActivity,rootTaskId:'other-root'},{...input.teamActivity,controlVersion:99}]){expect(buildAgentWorkflowChain({...input,teamActivity}).nodes.some(n=>n.key.startsWith('current:'))).toBe(false);}
  });
  it('late snapshots cannot reverse a newer checked observation, but revoked evidence clears it',()=>{
    const input=fixture(),latest={...input.activity,asOf:new Date(input.now+5000).toISOString(),revision:{...input.activity.revision,generation:2,checkpointVersion:2}};
    expect(selectChainObservation(latest,input.activity,input.work)).toBe(latest);expect(selectChainObservation(latest,undefined,input.work)).toBeUndefined();expect(selectChainObservation(latest,latest,{...input.work,evidenceUnavailable:true})).toBeUndefined();
  });
  it('a recorded purchase never becomes a paid or delivered success claim in the chain',()=>{
    const chain=buildAgentWorkflowChain({...fixture(),equipmentStage:'purchase_recorded'});expect(chain.payment?.state).toBe('waiting');expect(chain.payment?.caption).toContain('receipt');
  });
});


function mountPresentation(component:(p:any)=>any,initial:any){
  let props=initial,tree:any;const frame={cursor:0,cells:[]as any[],effects:[]as any[],dirty:false};
  const render=()=>{for(let round=0;round<20;round++){h.frame=frame;frame.cursor=0;frame.effects=[];frame.dirty=false;tree=component(props);for(const node of elements(tree))if(node.props.ref&&typeof node.props.ref==='object')node.props.ref.current={focus:vi.fn()};frame.effects.forEach(f=>f());if(!frame.dirty)return tree;}throw Error('Unsettled presentation');};
  const view={render,get pendingRender(){return frame.dirty;},get tree(){return tree;},patch:(p:any)=>{props={...props,...p};render();},unmount:()=>{for(const c of frame.cells)c?.cleanup?.();}};mounted.push(view);render();return view;
}
describe('independent chain and payment integration lifecycle',()=>{
  it('retained newer snapshot loses its live state at its own expiry after an older read arrives',()=>{
    const activity=demoActivityFixture(),at=Date.parse(activity.asOf);vi.setSystemTime(at+3000);
    const work={...agentWorkFixture(),id:activity.rootTaskId,controlVersion:activity.revision.controlVersion,updatedAt:activity.recordedAt,expiresAt:activity.expiresAt};
    const newer={...activity,asOf:new Date(at+2000).toISOString()},older={...activity,freshUntil:new Date(at+7000).toISOString()};
    const view=mountPresentation(AgentWorkflowChain,{activity:newer,work,observing:true});expect(view.tree.props['data-live']).toBe(true);
    view.patch({activity:older});vi.advanceTimersByTime(4001);view.render();expect(view.tree.props['data-live']).toBe(true);
    vi.advanceTimersByTime(3000);expect(view.pendingRender).toBe(true);view.render();expect(view.tree.props['data-live']).toBe(false);
  });
  it('renders one conversation and a stable payment slot through setup fallback and payment stages',()=>{
    const conversation={type:'ConversationFixture',props:{}},equipment={type:'PaymentFixture',props:{}},work=agentWorkFixture();
    h.activityQuery={setupRequired:true};const view=mountPresentation(NativeAgentWorkspaceContent,{siteId:'site_one',work,observing:true,evidenceExpired:false,instructionsChanged:false,conversation,equipment,onRefresh:vi.fn(),equipmentStage:null});
    const count=()=>{const nodes=elements(view.tree).flatMap(n=>n.type===NativeAgentWorkContent?elements(NativeAgentWorkContent(n.props)):[n]);return nodes.filter(n=>n.type==='ConversationFixture').length;};
    expect(count()).toBe(1);expect(view.tree.props.children[1]).toBe(equipment);
    h.activityQuery={setupRequired:false};view.render();expect(count()).toBe(1);expect(view.tree.props.children[1]).toBe(equipment);
    for(const equipmentStage of ['quote_ready','approval_unconfirmed','purchase_recorded',null]){view.patch({equipmentStage});expect(count()).toBe(1);expect(view.tree.props.children[1]).toBe(equipment);}
  });
});
