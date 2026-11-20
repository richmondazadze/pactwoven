'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { RequestError } from '../lib/api';
import { transcribeVoice, voiceCommandError, voiceMimeTypes, VOICE_MAX_BYTES, VOICE_MAX_SECONDS } from '../lib/voice-command';
import { canObserveAgentWork, useAgentWorkBinding } from './native-agent-work-hooks';
import { Icon } from './icon';
import './inline-voice-input.css';

type Phase = 'idle' | 'requesting' | 'recording' | 'finishing' | 'review' | 'error';
type Props = { siteId:string; value:string; onChange:(value:string)=>void; onActiveChange:(active:boolean)=>void; disabled?:boolean };
/** One textarea owns the preview. Only Use commits voice to the parent draft. */
export function InlineVoiceInput({siteId,value,onChange,onActiveChange,disabled=false}:Props) {
  const binding=useAgentWorkBinding(siteId),id=useId();
  const [phase,setPhase]=useState<Phase>('idle'),[preview,setPreview]=useState(''),[elapsed,setElapsed]=useState(0),[error,setError]=useState('');
  const phaseRef=useRef<Phase>('idle'),alive=useRef(true),epoch=useRef(0),disabledRef=useRef(disabled),valueRef=useRef(value),previewRef=useRef('');
  const base=useRef(''),words=useRef<string[]>([]),queue=useRef<Blob[]>([]),processing=useRef(false),failed=useRef(false),stopping=useRef(false),byteCount=useRef(0);
  const media=useRef<MediaStream|null>(null),recorder=useRef<MediaRecorder|null>(null),request=useRef<AbortController|null>(null),timer=useRef<ReturnType<typeof setInterval>|null>(null);
  const context=useRef<AudioContext|null>(null),analyser=useRef<AnalyserNode|null>(null),frame=useRef<number|null>(null),bars=useRef<HTMLDivElement|null>(null),editor=useRef<HTMLTextAreaElement|null>(null);
  const callbacks=useRef({onChange,onActiveChange});callbacks.current={onChange,onActiveChange};disabledRef.current=disabled;valueRef.current=value;
  function change(next:Phase){phaseRef.current=next;setPhase(next);callbacks.current.onActiveChange(next!=='idle');}
  function show(text:string){previewRef.current=text;setPreview(text);}
  function stopMeter(){if(frame.current!==null)cancelAnimationFrame(frame.current);frame.current=null;analyser.current=null;void context.current?.close().catch(()=>{});context.current=null;}
  function cleanup(){if(timer.current)clearInterval(timer.current);timer.current=null;const active=recorder.current;recorder.current=null;
    if(active){active.onstop=null;active.ondataavailable=null;active.onerror=null;if(active.state!=='inactive')try{active.stop();}catch{}}
    media.current?.getTracks().forEach(track=>track.stop());media.current=null;stopMeter();}
  function cancel(){epoch.current++;request.current?.abort();request.current=null;cleanup();queue.current=[];words.current=[];processing.current=false;failed.current=false;stopping.current=false;byteCount.current=0;
    if(alive.current){show('');setError('');setElapsed(0);change('idle');}}
  const current=()=>{if(disabledRef.current||!canObserveAgentWork())throw new RequestError('OBSERVATION_PAUSED','Return to your workspace to use voice.');return binding.current();};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;request.current?.abort();cleanup();queue.current=[];callbacks.current.onActiveChange(false);};},[binding.identity]);
  useEffect(()=>{cancel();},[binding.identity]);
  useEffect(()=>{if(disabled&&phaseRef.current!=='idle')cancel();},[disabled]);
  useEffect(()=>{const leave=()=>{if(!canObserveAgentWork()&&phaseRef.current!=='idle')cancel();};document.addEventListener('visibilitychange',leave);window.addEventListener('offline',leave);return()=>{document.removeEventListener('visibilitychange',leave);window.removeEventListener('offline',leave);};},[binding.identity]);
  // Never let an older voice session replace a newer externally restored draft.
  useEffect(()=>{if(phaseRef.current!=='idle'&&value!==base.current)cancel();},[value]);
  function meter(captured:MediaStream){
    try{const audioContext=new AudioContext();context.current=audioContext;const input=audioContext.createMediaStreamSource(captured),node=audioContext.createAnalyser();node.fftSize=256;input.connect(node);analyser.current=node;void audioContext.resume().catch(()=>{});
      const data=new Uint8Array(node.fftSize);let last=0;
      const draw=(now:number)=>{if(!alive.current||!analyser.current)return;frame.current=requestAnimationFrame(draw);if(now-last<80)return;last=now;
        const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches||['off','reduced'].includes(document.documentElement.dataset.motion??'');
        node.getByteTimeDomainData(data);const elements=bars.current?.children;if(!elements)return;
        for(let index=0;index<elements.length;index++){const start=Math.floor(index*data.length/elements.length),end=Math.floor((index+1)*data.length/elements.length);let peak=0;for(let sample=start;sample<end;sample++)peak=Math.max(peak,Math.abs(data[sample]!-128)/128);
          (elements[index] as HTMLElement).style.transform=`scaleY(${reduce?0.18:Math.min(1,0.12+peak*3)})`;}
      };frame.current=requestAnimationFrame(draw);
    }catch{stopMeter();} // Recording remains usable without the optional audio meter.
  }
  function stop(){if(!['recording','requesting'].includes(phaseRef.current))return;if(phaseRef.current==='requesting'){cancel();return;}
    stopping.current=true;if(timer.current)clearInterval(timer.current);timer.current=null;change('finishing');const active=recorder.current;
    if(active){if(active.state==='recording')active.stop();}else{cleanup();if(!processing.current&&!queue.current.length)change('review');}}
  async function drain(generation:number){
    if(processing.current||failed.current||generation!==epoch.current)return;processing.current=true;
    try{while(queue.current.length&&generation===epoch.current){const blob=queue.current[0]!;const controller=new AbortController();request.current=controller;
        try{const text=await transcribeVoice(blob,binding.scope,binding.getToken,current,AbortSignal.any([controller.signal,binding.controller.current.signal,AbortSignal.timeout(45000)]));
          if(!alive.current||generation!==epoch.current)return;queue.current.shift();words.current.push(text.trim());show(`${base.current}${base.current?'\n\n':''}${words.current.join(' ')}`);
        }catch(failure){if(!alive.current||generation!==epoch.current)return;failed.current=true;setError(voiceCommandError(failure));stop();change('error');return;}
        finally{if(request.current===controller)request.current=null;}
      }
    }finally{if(generation===epoch.current){processing.current=false;if(stopping.current&&!recorder.current&&!queue.current.length&&!failed.current){change('review');editor.current?.focus();}}}
  }
  async function start(){
    if(disabledRef.current||!canObserveAgentWork()||!['idle','review','error'].includes(phaseRef.current))return;
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){setError('This browser cannot record audio. You can still type your instructions.');return;}
    const mimeType=voiceMimeTypes.find(type=>MediaRecorder.isTypeSupported(type));if(!mimeType){setError('Recording is unavailable in this browser. You can still type.');return;}
    cancel();base.current=valueRef.current;show(base.current);const generation=epoch.current;change('requesting');
    try{const captured=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(!alive.current||generation!==epoch.current||disabledRef.current||!canObserveAgentWork()){captured.getTracks().forEach(track=>track.stop());return;}
      media.current=captured;current();meter(captured);const started=performance.now();let segmentStarted=started;
      // Each segment is finalized as a standalone container, never a raw WebM fragment.
      const segment=()=>{if(stopping.current||generation!==epoch.current)return;const active=new MediaRecorder(captured,{mimeType,audioBitsPerSecond:64000});const chunks:Blob[]=[];recorder.current=active;segmentStarted=performance.now();
        active.ondataavailable=event=>{if(generation!==epoch.current||!event.data.size)return;byteCount.current+=event.data.size;if(byteCount.current>VOICE_MAX_BYTES){cancel();setError('The recording reached its size limit. Your typed instructions are kept. Try a shorter recording.');return;}chunks.push(event.data);};
        active.onerror=()=>{if(generation===epoch.current){cancel();setError('The microphone stopped. Your typed instructions are kept. Please try again.');}};
        active.onstop=()=>{if(generation!==epoch.current)return;recorder.current=null;const blob=new Blob(chunks,{type:mimeType});if(blob.size>=16)queue.current.push(blob);
          if(stopping.current)cleanup();else segment();void drain(generation);
          if(stopping.current&&!processing.current&&!queue.current.length&&!failed.current)change('review');};
        active.start(250);
      };segment();change('recording');timer.current=setInterval(()=>{const now=performance.now(),seconds=Math.min(VOICE_MAX_SECONDS,Math.floor((now-started)/1000));setElapsed(seconds);
        if(seconds>=VOICE_MAX_SECONDS){stop();return;}if(now-segmentStarted>=5000&&recorder.current?.state==='recording')recorder.current.stop();},250);
    }catch(failure){if(alive.current&&generation===epoch.current){cancel();setError(voiceCommandError(failure));}}
  }
  function retryTranscription(){if(phaseRef.current!=='error'||disabledRef.current||!canObserveAgentWork()||processing.current)return;failed.current=false;setError('');change('finishing');void drain(epoch.current);}
  function useText(){if(phaseRef.current!=='review'||disabledRef.current||!canObserveAgentWork()||!previewRef.current.trim()||previewRef.current.length>12000)return;
    try{current();const result=previewRef.current;callbacks.current.onChange(result);cancel();editor.current?.focus();}catch(failure){setError(voiceCommandError(failure));}}
  const active=phase!=='idle',recording=phase==='recording',reviewing=phase==='review';
  return <div className="inline-voice" data-phase={phase}>
    <label htmlFor={id}>What would you like help with?</label>
    <div className="inline-voice-editor">
      <textarea ref={editor} id={id} aria-label="What would you like help with?" aria-describedby={`${id}-status ${id}-privacy`} required rows={7} maxLength={12000} value={active?preview:value} disabled={disabled} readOnly={active&&!reviewing} onChange={event=>reviewing?show(event.target.value):onChange(event.target.value)} placeholder="Explain the outcome you need, constraints and any public links to review."/>
      <div className="inline-voice-toolbar" aria-label="Voice instructions">
        {active?<><button type="button" className="inline-voice-control" aria-label="Cancel voice input" title="Cancel voice input" onClick={cancel}><span aria-hidden="true">×</span></button>
          <div className="inline-voice-wave" ref={bars} aria-hidden="true">{Array.from({length:40},(_,index)=><i key={index}/>)}</div>
          <span className="inline-voice-timer">{Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,'0')}</span>
          {recording&&<button type="button" className="inline-voice-control" aria-label="Stop recording" title="Stop recording" onClick={stop}><span className="inline-voice-stop" aria-hidden="true"/></button>}
          {reviewing&&<button type="button" className="inline-voice-retry" onClick={()=>void start()} disabled={disabled}>Retry</button>}
          {phase==='error'&&<button type="button" className="inline-voice-retry" onClick={retryTranscription} disabled={disabled}>Retry transcription</button>}
          <button type="button" className="inline-voice-control inline-voice-use" aria-label="Use transcript" title="Use transcript" disabled={!reviewing||disabled||!preview.trim()||preview.length>12000} onClick={useText}><span aria-hidden="true">↑</span></button>
        </>:<><span className="inline-voice-hint">Type or speak your instructions</span><button type="button" className="inline-voice-control inline-voice-use" aria-label="Speak instructions" title="Speak instructions" disabled={disabled||value.length>=12000} onClick={()=>void start()}><Icon name="microphone" size={20}/></button></>}
      </div>
    </div>
    <p id={`${id}-status`} className="inline-voice-status" role="status">{phase==='requesting'?'Allow microphone access to begin.':recording?'Listening — phrases appear here as they are transcribed.':phase==='finishing'?'Finishing your transcript…':reviewing?'Edit the text, then use the arrow to keep it. Or retry.':phase==='error'?'Transcription paused. Retry the retained audio, or cancel.':''}</p>
    {error&&<p className="inline-voice-error" role="alert">{error}</p>}
    {preview.length>12000&&active&&<p className="inline-voice-error">Shorten your instructions to 12,000 characters before using them.</p>}
    <p id={`${id}-privacy`} className="inline-voice-privacy">{active?'Your original draft is kept until you choose Use transcript.':'Speak sends audio to ElevenLabs in short clips for live transcription. Up to 60 seconds. It never starts a task.'}</p>
  </div>;
}
