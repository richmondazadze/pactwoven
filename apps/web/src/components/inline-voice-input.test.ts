import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineVoiceInput } from './inline-voice-input';

// Actual component callbacks and cleanup, with browser media and provider boundaries
// simulated. Actual microphone/audio hardware is deliberately not requested here.
const h=vi.hoisted(()=>({frame:null as any,binding:null as any,online:true,media:vi.fn(),transcribe:vi.fn(),speak:vi.fn(),recorders:[]as any[],tracks:[]as any[],events:null as any,windowEvents:null as any}));
vi.mock('react',async original=>({...await original<any>(),useId:()=> 'voice-test',
  useState:(initial:any)=>{const f=h.frame,i=f.cursor++;if(!(i in f.cells))f.cells[i]=typeof initial==='function'?initial():initial;return[f.cells[i],(v:any)=>{const next=typeof v==='function'?v(f.cells[i]):v;if(!Object.is(next,f.cells[i])){f.cells[i]=next;f.dirty=true;}}];},
  useRef:(initial:any)=>{const f=h.frame,i=f.cursor++;return f.cells[i]??(f.cells[i]={current:initial});},
  useEffect:(fn:any,deps:any[])=>{const f=h.frame,i=f.cursor++,old=f.cells[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n]))){f.cells[i]={deps,cleanup:old?.cleanup};f.effects.push(()=>{old?.cleanup?.();f.cells[i].cleanup=fn();});}},
}));
vi.mock('./native-agent-work-hooks',()=>({canObserveAgentWork:()=>h.online,useAgentWorkBinding:()=>h.binding}));
vi.mock('../lib/voice-command',async original=>({...await original<any>(),transcribeVoice:(...a:any[])=>h.transcribe(...a),speakWorkResult:(...a:any[])=>h.speak(...a)}));
vi.mock('./ui',()=>({ActionLabel:'ActionLabel'}));
function nodes(v:any):any[]{if(Array.isArray(v))return v.flatMap(nodes);if(!v||typeof v!=='object'||!('type'in v))return[];return[v,...nodes(v.props.children)];}
function text(v:any):string{if(Array.isArray(v))return v.map(text).join('');if(v==null||typeof v==='boolean')return'';if(typeof v==='string'||typeof v==='number')return String(v);return v.props?.label??text(v.props?.children);}
const mounted:any[]=[];
function mount(component:(props:any)=>any,initial:any){let props=initial,tree:any;const frame={cursor:0,cells:[]as any[],effects:[]as any[],dirty:false};
  function render(){for(let round=0;round<25;round++){frame.cursor=0;frame.effects=[];frame.dirty=false;h.frame=frame;tree=component(props);for(const n of nodes(tree))if(n.props.ref&&typeof n.props.ref==='object')n.props.ref.current={focus:vi.fn(),pause:vi.fn()};frame.effects.forEach(f=>f());if(!frame.dirty)return tree;}throw Error('Unsettled voice lifecycle');}
  const view={render,get tree(){return tree;},get phase(){return tree.props['data-phase'];},get text(){return text(tree);},patch:(next:any)=>{props={...props,...next};render();},button:(label:string)=>{const node=nodes(tree).find(n=>n.type==='button'&&(n.props['aria-label']??text(n))===label);if(!node)throw Error(`Missing ${label}`);return node;},find:(type:string)=>nodes(tree).find(n=>n.type===type),unmount:()=>{for(const c of frame.cells)c?.cleanup?.();}};mounted.push(view);render();return view;
}
async function settle(view:any){for(let n=0;n<10;n++){await Promise.resolve();view.render();}}
function capture(){const track={stop:vi.fn()},value={getTracks:()=>[track]};h.tracks.push(track);return value;}
const props=()=>({siteId:'site_one',value:'Typed constraints.',onChange:vi.fn(),onActiveChange:vi.fn()});
beforeEach(()=>{
  vi.useFakeTimers();h.online=true;h.recorders=[];h.tracks=[];h.events=new EventTarget();h.windowEvents=new EventTarget();vi.stubGlobal('document',h.events);vi.stubGlobal('window',h.windowEvents);
  h.binding={identity:'scope-one',scope:{siteId:'site_one'},getToken:vi.fn(),current:vi.fn(()=>({siteId:'site_one'})),controller:{current:new AbortController()}};
  h.media.mockReset().mockImplementation(async()=>capture());h.transcribe.mockReset().mockResolvedValue('Plan a one-day workshop.');h.speak.mockReset().mockResolvedValue(new Blob(['audio'],{type:'audio/mpeg'}));
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:h.media}});vi.stubGlobal('MediaRecorder',class{static isTypeSupported(){return true;}state='inactive';ondataavailable:any;onstop:any;onerror:any;constructor(){h.recorders.push(this);}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['standalone-audio-container-data'],{type:'audio/webm'})});this.onstop?.();}});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local-voice-fixture');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
});
afterEach(()=>{mounted.splice(0).forEach(v=>v.unmount());vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();});


describe('inline live voice draft',()=>{
  it('streams ordered standalone clips into the existing textarea before stopping, committing only on Use',async()=>{
    const input=props(),view=mount(InlineVoiceInput,input);expect(h.media).not.toHaveBeenCalled();expect(view.find('textarea').props.value).toBe(input.value);
    view.button('Speak instructions').props.onClick();await settle(view);expect(view.phase).toBe('recording');expect(input.onActiveChange).toHaveBeenLastCalledWith(true);
    h.transcribe.mockResolvedValueOnce('Plan a workshop.');h.recorders[0].stop();await settle(view);
    expect(view.phase).toBe('recording');expect(view.find('textarea').props.value).toBe('Typed constraints.\n\nPlan a workshop.');expect(input.onChange).not.toHaveBeenCalled();expect(h.tracks[0].stop).not.toHaveBeenCalled();
    h.transcribe.mockResolvedValueOnce('For twenty people.');view.button('Stop recording').props.onClick();await settle(view);
    expect(view.phase).toBe('review');expect(h.tracks[0].stop).toHaveBeenCalled();expect(view.find('textarea').props.value).toBe('Typed constraints.\n\nPlan a workshop. For twenty people.');
    view.find('textarea').props.onChange({target:{value:'Edited final instructions'}});view.render();view.button('Use transcript').props.onClick();view.render();
    expect(input.onChange).toHaveBeenCalledExactlyOnceWith('Edited final instructions');expect(view.phase).toBe('idle');expect(input.onActiveChange).toHaveBeenLastCalledWith(false);
  });
  it('Cancel never alters original text and ignores an outstanding provider result',async()=>{
    let resolve!:(value:string)=>void;h.transcribe.mockImplementation(()=>new Promise(r=>resolve=r));const input=props(),view=mount(InlineVoiceInput,input);
    view.button('Speak instructions').props.onClick();await settle(view);h.recorders[0].stop();await settle(view);const signal=h.transcribe.mock.calls[0]![4];
    view.button('Cancel voice input').props.onClick();view.render();resolve('Too late');await settle(view);
    expect(signal.aborted).toBe(true);expect(view.phase).toBe('idle');expect(view.find('textarea').props.value).toBe(input.value);expect(input.onChange).not.toHaveBeenCalled();
  });
  it('serializes clips, retains failed audio and retries without duplicating successful words',async()=>{
    const input=props(),view=mount(InlineVoiceInput,input);view.button('Speak instructions').props.onClick();await settle(view);
    h.transcribe.mockResolvedValueOnce('First phrase.');h.recorders[0].stop();await settle(view);
    h.transcribe.mockRejectedValueOnce(new Error('Provider unavailable'));h.recorders[1].stop();await settle(view);expect(view.phase).toBe('error');expect(view.button('Use transcript').props.disabled).toBe(true);
    const failedBlob=h.transcribe.mock.calls[1]![0];h.transcribe.mockResolvedValueOnce('Second phrase.').mockResolvedValueOnce('Last phrase.');view.button('Retry transcription').props.onClick();await settle(view);
    expect(h.transcribe.mock.calls[2]![0]).toBe(failedBlob);expect(view.phase).toBe('review');expect(view.find('textarea').props.value).toBe('Typed constraints.\n\nFirst phrase. Second phrase. Last phrase.');
  });
  it('Retry starts a replacement transcript from the unchanged original draft',async()=>{
    const input=props(),view=mount(InlineVoiceInput,input);view.button('Speak instructions').props.onClick();await settle(view);view.button('Stop recording').props.onClick();await settle(view);
    view.button('Retry').props.onClick();await settle(view);expect(view.find('textarea').props.value).toBe(input.value);expect(input.onChange).not.toHaveBeenCalled();
  });
  it('releases late microphone permission after cancellation',async()=>{
    let resolve!:(stream:any)=>void;h.media.mockImplementation(()=>new Promise(r=>resolve=r));const view=mount(InlineVoiceInput,props());view.button('Speak instructions').props.onClick();view.render();view.button('Cancel voice input').props.onClick();view.render();const stream=capture();resolve(stream);await settle(view);
    expect(stream.getTracks()[0]!.stop).toHaveBeenCalled();expect(h.recorders).toHaveLength(0);expect(view.phase).toBe('idle');
  });
  it.each(['offline','disabled','scope','new draft'])('%s cancels the old session and keeps parent text',async reason=>{
    const input=props(),view=mount(InlineVoiceInput,input);view.button('Speak instructions').props.onClick();await settle(view);
    if(reason==='offline'){h.online=false;h.windowEvents.dispatchEvent(new Event('offline'));view.render();}
    if(reason==='disabled')view.patch({disabled:true});
    if(reason==='scope'){h.binding={...h.binding,identity:'new-scope'};view.render();}
    if(reason==='new draft')view.patch({value:'Restored externally'});
    expect(view.phase).toBe('idle');expect(h.tracks[0].stop).toHaveBeenCalled();expect(input.onChange).not.toHaveBeenCalled();
  });
  it('guards empty, too-long and unavailable transcripts at the handler',async()=>{
    const input=props(),view=mount(InlineVoiceInput,input);view.button('Speak instructions').props.onClick();await settle(view);view.button('Stop recording').props.onClick();await settle(view);
    for(const value of ['', 'x'.repeat(12001)]){view.find('textarea').props.onChange({target:{value}});view.render();view.button('Use transcript').props.onClick();expect(input.onChange).not.toHaveBeenCalled();}
    view.find('textarea').props.onChange({target:{value:'Good'}});view.render();h.online=false;view.button('Use transcript').props.onClick();expect(input.onChange).not.toHaveBeenCalled();
  });
  it('stops microphone capture at sixty seconds and drains pending clips in order',async()=>{
    const view=mount(InlineVoiceInput,props());view.button('Speak instructions').props.onClick();await settle(view);vi.advanceTimersByTime(60000);await settle(view);
    expect(h.tracks[0].stop).toHaveBeenCalled();expect(['finishing','review']).toContain(view.phase);expect(h.recorders.length).toBeLessThanOrEqual(13);
  });
  it('rejects oversized capture without committing any text',async()=>{
    const input=props(),view=mount(InlineVoiceInput,input);view.button('Speak instructions').props.onClick();await settle(view);h.recorders[0].ondataavailable({data:new Blob([new Uint8Array(2*1024*1024+1)])});view.render();
    expect(view.phase).toBe('idle');expect(view.text).toContain('size limit');expect(input.onChange).not.toHaveBeenCalled();expect(h.tracks[0].stop).toHaveBeenCalled();
  });
  it('shows microphone denial without changing the draft',async()=>{
    h.media.mockRejectedValueOnce(new DOMException('Blocked','NotAllowedError'));const input=props(),view=mount(InlineVoiceInput,input);view.button('Speak instructions').props.onClick();await settle(view);
    expect(view.phase).toBe('idle');expect(view.text).toContain('Microphone access was not allowed');expect(input.onChange).not.toHaveBeenCalled();
  });
});
