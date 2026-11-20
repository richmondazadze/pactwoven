import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceCommandComposer, SpokenWorkResult } from './voice-command-composer';

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
  const view={render,get tree(){return tree;},get phase(){return tree.props['data-phase'];},get text(){return text(tree);},patch:(next:any)=>{props={...props,...next};render();},button:(label:string)=>{const node=nodes(tree).find(n=>n.type==='button'&&text(n)===label);if(!node)throw Error(`Missing ${label}`);return node;},find:(type:string)=>nodes(tree).find(n=>n.type===type),unmount:()=>{for(const c of frame.cells)c?.cleanup?.();}};mounted.push(view);render();return view;
}
async function settle(view:any){for(let n=0;n<10;n++){await Promise.resolve();view.render();}}
function capture(){const track={stop:vi.fn()},value={getTracks:()=>[track]};h.tracks.push(track);return value;}
const props=()=>({siteId:'site_one',onUseTranscript:vi.fn()});
async function recorded(view:any){view.button('Speak instructions').props.onClick();await settle(view);expect(view.phase).toBe('recording');view.button('Stop recording').props.onClick();view.render();expect(view.phase).toBe('ready');}
async function reviewed(view:any){await recorded(view);view.button('Transcribe recording').props.onClick();await settle(view);expect(view.phase).toBe('review');}
beforeEach(()=>{
  vi.useFakeTimers();h.online=true;h.recorders=[];h.tracks=[];h.events=new EventTarget();h.windowEvents=new EventTarget();vi.stubGlobal('document',h.events);vi.stubGlobal('window',h.windowEvents);
  h.binding={identity:'scope-one',scope:{siteId:'site_one'},getToken:vi.fn(),current:vi.fn(()=>({siteId:'site_one'})),controller:{current:new AbortController()}};
  h.media.mockReset().mockImplementation(async()=>capture());h.transcribe.mockReset().mockResolvedValue('Plan a one-day workshop.');h.speak.mockReset().mockResolvedValue(new Blob(['audio'],{type:'audio/mpeg'}));
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:h.media}});vi.stubGlobal('MediaRecorder',class{static isTypeSupported(){return true;}state='inactive';ondataavailable:any;onstop:any;onerror:any;constructor(){h.recorders.push(this);}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'],{type:'audio/webm'})});this.onstop?.();}});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local-voice-fixture');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
});
afterEach(()=>{mounted.splice(0).forEach(v=>v.unmount());vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();});

describe('voice instruction lifecycle',()=>{
  it('records locally and stops for review without an automatic transcription or draft mutation',async()=>{
    const input=props(),view=mount(VoiceCommandComposer,input);expect(h.media).not.toHaveBeenCalled();await recorded(view);
    expect(h.transcribe).not.toHaveBeenCalled();expect(input.onUseTranscript).not.toHaveBeenCalled();expect(view.find('audio').props.autoPlay).toBeUndefined();expect(h.tracks[0].stop).toHaveBeenCalled();
    view.button('Transcribe recording').props.onClick();await settle(view);expect(h.transcribe).toHaveBeenCalledOnce();expect(input.onUseTranscript).not.toHaveBeenCalled();
    view.find('textarea').props.onChange({target:{value:'  Keep the workshop under two hours.  '}});view.render();view.button('Use these instructions').props.onClick();view.render();
    expect(input.onUseTranscript).toHaveBeenCalledExactlyOnceWith('Keep the workshop under two hours.');expect(view.phase).toBe('idle');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-voice-fixture');
  });
  it('keeps edited text when re-recording is denied or cancelled',async()=>{
    const view=mount(VoiceCommandComposer,props());await reviewed(view);view.find('textarea').props.onChange({target:{value:'My carefully edited transcript'}});view.render();
    h.media.mockRejectedValueOnce(new DOMException('Blocked','NotAllowedError'));view.button('Record again').props.onClick();await settle(view);
    expect(view.phase).toBe('review');expect(view.find('textarea').props.value).toBe('My carefully edited transcript');expect(view.text).toContain('How to allow your microphone');
    view.button('Record again').props.onClick();await settle(view);view.button('Discard recording').props.onClick();view.render();expect(view.find('textarea').props.value).toBe('My carefully edited transcript');
  });
  it('retains the same recording for explicit retry after provider failure',async()=>{
    const view=mount(VoiceCommandComposer,props());await recorded(view);h.transcribe.mockRejectedValueOnce(new Error('Unavailable'));view.button('Transcribe recording').props.onClick();await settle(view);
    expect(view.phase).toBe('ready');expect(view.text).toContain('recording is still here');const first=h.transcribe.mock.calls[0]![0];view.button('Retry transcription').props.onClick();await settle(view);
    expect(h.transcribe.mock.calls[1]![0]).toBe(first);expect(view.phase).toBe('review');
  });
  it('drops late transcription after cancellation and revokes local playback',async()=>{
    let resolve!:(text:string)=>void;h.transcribe.mockImplementation(()=>new Promise(r=>{resolve=r;}));const input=props(),view=mount(VoiceCommandComposer,input);await recorded(view);
    view.button('Transcribe recording').props.onClick();view.render();view.button('Cancel transcription').props.onClick();view.render();resolve('Late text');await settle(view);
    expect(view.phase).toBe('idle');expect(view.find('textarea')).toBeUndefined();expect(input.onUseTranscript).not.toHaveBeenCalled();expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
  it('releases a late microphone permission result after cancellation',async()=>{
    let resolve!:(stream:any)=>void;h.media.mockImplementation(()=>new Promise(r=>{resolve=r;}));const view=mount(VoiceCommandComposer,props());view.button('Speak instructions').props.onClick();view.render();view.button('Cancel').props.onClick();view.render();const stream=capture();resolve(stream);await settle(view);
    expect(stream.getTracks()[0]!.stop).toHaveBeenCalled();expect(h.recorders).toHaveLength(0);expect(view.phase).toBe('idle');
  });
  it.each(['offline','disabled','scope'])('%s stops capture and prevents late draft handoff',async reason=>{
    const input=props(),view=mount(VoiceCommandComposer,input);await recorded(view);
    if(reason==='offline'){h.online=false;h.windowEvents.dispatchEvent(new Event('offline'));view.render();}
    if(reason==='disabled')view.patch({disabled:true});
    if(reason==='scope'){h.binding={...h.binding,identity:'scope-two'};view.render();}
    expect(view.find('audio')).toBeUndefined();expect(view.phase).toBe('idle');expect(h.transcribe).not.toHaveBeenCalled();expect(input.onUseTranscript).not.toHaveBeenCalled();expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
  it('stops automatically at the capture limit without uploading the recording',async()=>{
    const view=mount(VoiceCommandComposer,props());view.button('Speak instructions').props.onClick();await settle(view);vi.advanceTimersByTime(60000);view.render();
    expect(view.phase).toBe('ready');expect(view.text).toContain('1:00 captured');expect(h.transcribe).not.toHaveBeenCalled();
  });
  it('cannot hand off over-limit or unavailable text',async()=>{
    const input={...props(),maxLength:10},view=mount(VoiceCommandComposer,input);await reviewed(view);expect(view.button('Use these instructions').props.disabled).toBe(true);view.button('Use these instructions').props.onClick();expect(input.onUseTranscript).not.toHaveBeenCalled();
    view.find('textarea').props.onChange({target:{value:'Valid'}});view.render();h.online=false;view.button('Use these instructions').props.onClick();expect(input.onUseTranscript).not.toHaveBeenCalled();
  });
});

describe('spoken result lifecycle',()=>{
  it('prepares once despite duplicate clicks and never starts playback automatically',async()=>{
    const view=mount(SpokenWorkResult,{siteId:'site_one',rootTaskId:'root_one'});const action=view.button('Listen to this result');action.props.onClick();action.props.onClick();await settle(view);
    expect(h.speak).toHaveBeenCalledOnce();expect(view.find('audio').props.autoPlay).toBeUndefined();expect(view.text).toContain('Audio ready');view.find('audio').props.onPlay();view.render();expect(view.text).toContain('Playing saved summary');view.find('audio').props.onPause();view.render();expect(view.text).toContain('Playback paused');view.find('audio').props.onEnded();view.render();expect(view.text).toContain('Summary finished');expect(h.speak).toHaveBeenCalledOnce();
  });
  it('cancels a pending narration and ignores its late provider response',async()=>{
    let resolve!:(blob:Blob)=>void;h.speak.mockImplementation(()=>new Promise(r=>{resolve=r;}));const view=mount(SpokenWorkResult,{siteId:'site_one',rootTaskId:'root_one'});view.button('Listen to this result').props.onClick();view.render();view.button('Cancel audio').props.onClick();view.render();resolve(new Blob(['audio'],{type:'audio/mpeg'}));await settle(view);
    expect(view.find('audio')).toBeUndefined();expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('cleans up audio when the saved result becomes unavailable',async()=>{
    const view=mount(SpokenWorkResult,{siteId:'site_one',rootTaskId:'root_one'});view.button('Listen to this result').props.onClick();await settle(view);view.patch({disabled:true});expect(view.find('audio')).toBeUndefined();expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});
