'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { RequestError } from '../lib/api';
import { speakWorkResult, transcribeVoice, voiceCommandError, voiceMimeTypes, VOICE_MAX_BYTES, VOICE_MAX_SECONDS } from '../lib/voice-command';
import { canObserveAgentWork, useAgentWorkBinding } from './native-agent-work-hooks';
import { Icon } from './icon';
import './voice-command-composer.css';

type Phase='idle'|'requesting'|'recording'|'ready'|'transcribing'|'review';
export function VoiceCommandComposer({siteId,onUseTranscript,disabled=false,label='Use these instructions',maxLength=12000}:{siteId:string;onUseTranscript:(text:string)=>void;disabled?:boolean;label?:string;maxLength?:number}){
  const transcriptLimit=Number.isSafeInteger(maxLength)&&maxLength>0&&maxLength<=12000?maxLength:12000;
  const binding=useAgentWorkBinding(siteId),id=useId(),[phase,setPhase]=useState<Phase>('idle'),[elapsed,setElapsed]=useState(0),[transcript,setTranscript]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),chunks=useRef<Blob[]>([]),bytes=useRef(0),audio=useRef<Blob|null>(null),request=useRef<AbortController|null>(null);
  const timer=useRef<ReturnType<typeof setInterval>|null>(null),epoch=useRef(0),live=useRef(true),phaseRef=useRef<Phase>('idle'),disabledRef=useRef(disabled),editor=useRef<HTMLTextAreaElement>(null),transcribeOnStop=useRef(false);
  phaseRef.current=phase;disabledRef.current=disabled;
  function changePhase(value:Phase){phaseRef.current=value;setPhase(value);}
  function releaseCapture(){if(timer.current)clearInterval(timer.current);timer.current=null;const current=recorder.current;recorder.current=null;
    if(current){current.ondataavailable=null;current.onstop=null;current.onerror=null;if(current.state!=='inactive')current.stop();}
    stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;chunks.current=[];bytes.current=0;}
  function cancel(message='Recording discarded.'){epoch.current++;request.current?.abort();request.current=null;releaseCapture();audio.current=null;transcribeOnStop.current=false;
    if(live.current){changePhase('idle');setElapsed(0);setError('');setNotice(message);}}
  const current=()=>{if(!canObserveAgentWork()||disabledRef.current)throw new RequestError('OBSERVATION_PAUSED','Return to the current work to use voice.');return binding.current();};
  useEffect(()=>{live.current=true;changePhase('idle');setTranscript('');setNotice('');setError('');return()=>{live.current=false;epoch.current++;request.current?.abort();releaseCapture();audio.current=null;};},[binding.identity]);
  useEffect(()=>{const hidden=()=>{if(!canObserveAgentWork()&&['requesting','recording','ready','transcribing'].includes(phaseRef.current))cancel('Voice capture stopped when you left this tab.');};
    document.addEventListener('visibilitychange',hidden);window.addEventListener('offline',hidden);return()=>{document.removeEventListener('visibilitychange',hidden);window.removeEventListener('offline',hidden);};},[binding.identity]);
  useEffect(()=>{if(disabled&&['requesting','recording','ready','transcribing'].includes(phaseRef.current))cancel('Voice capture stopped because this work changed.');},[disabled]);
  useEffect(()=>{if(phase==='review')editor.current?.focus();},[phase]);
  async function transcribe(blob=audio.current){
    if(!blob||disabledRef.current||!canObserveAgentWork()||phaseRef.current==='transcribing')return;
    const generation=epoch.current;request.current?.abort();const controller=new AbortController();request.current=controller;changePhase('transcribing');setError('');setNotice('Converting your recording to text. No task has been started.');
    try{const text=await transcribeVoice(blob,binding.scope,binding.getToken,current,AbortSignal.any([controller.signal,binding.controller.current.signal,AbortSignal.timeout(45000)]));
      if(!live.current||generation!==epoch.current)return;audio.current=null;setTranscript(text);changePhase('review');setNotice('Review the transcript before adding it to your instructions.');}
    catch(failure){if(live.current&&generation===epoch.current){audio.current=null;changePhase('idle');setError(voiceCommandError(failure));setNotice('');}}
    finally{if(request.current===controller)request.current=null;}
  }
  async function start(){
    if(disabledRef.current||!canObserveAgentWork()||!['idle','review'].includes(phaseRef.current))return;
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){setError('This browser cannot record audio. You can type your instructions instead.');return;}
    const mimeType=voiceMimeTypes.find(type=>MediaRecorder.isTypeSupported(type));
    if(!mimeType){setError('This browser does not support a compatible audio format. You can type your instructions instead.');return;}
    cancel('');const generation=epoch.current;changePhase('requesting');setError('');setTranscript('');setNotice('Allow microphone access to record your instructions.');
    try{const captured=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(!live.current||generation!==epoch.current||disabledRef.current||!canObserveAgentWork()){captured.getTracks().forEach(track=>track.stop());return;}
      stream.current=captured;current();const active=new MediaRecorder(captured,{mimeType,audioBitsPerSecond:64000});recorder.current=active;chunks.current=[];bytes.current=0;transcribeOnStop.current=false;
      active.ondataavailable=event=>{if(generation!==epoch.current||!event.data.size)return;
        if(bytes.current+event.data.size>VOICE_MAX_BYTES){cancel('');setError('The recording reached 2 MB. Please make a shorter recording.');return;}
        bytes.current+=event.data.size;chunks.current.push(event.data);};
      active.onerror=()=>{if(generation===epoch.current){cancel('');setError('The microphone stopped unexpectedly. Record again or type your instructions.');}};
      active.onstop=()=>{if(generation!==epoch.current)return;const blob=new Blob(chunks.current,{type:mimeType}),send=transcribeOnStop.current;releaseCapture();audio.current=blob;
        if(!blob.size){changePhase('idle');setError('No audio was recorded. Please try again.');return;}
        changePhase('ready');setNotice('Recording stopped. You can transcribe it or discard it.');if(send)void transcribe(blob);};
      active.start(250);const started=performance.now();setElapsed(0);changePhase('recording');setNotice('Recording. Your task will only receive text after you review it.');
      timer.current=setInterval(()=>{const seconds=Math.min(VOICE_MAX_SECONDS,Math.floor((performance.now()-started)/1000));setElapsed(seconds);
        if(seconds>=VOICE_MAX_SECONDS&&active.state==='recording'){transcribeOnStop.current=false;active.stop();stream.current?.getTracks().forEach(track=>track.stop());}},250);
    }catch(failure){if(live.current&&generation===epoch.current){releaseCapture();changePhase('idle');setError(voiceCommandError(failure));setNotice('');}}
  }
  function stop(){const active=recorder.current;if(active?.state==='recording'){transcribeOnStop.current=true;active.stop();stream.current?.getTracks().forEach(track=>track.stop());}}
  const capturing=['requesting','recording','ready','transcribing'].includes(phase);
  return <section className="voice-command" aria-label="Voice instructions" data-phase={phase}>
    <div className="voice-command-heading"><span className="voice-command-symbol"><Icon name="microphone" size={19}/></span><div><h3>Say what you need</h3><p>Record up to one minute. Review the text before using it.</p></div></div>
    {error&&<p className="voice-command-error" role="alert">{error}</p>}
    <p className="voice-command-status" role="status" aria-live="polite">{notice}</p>
    {phase==='recording'&&<div className="voice-command-recording"><span aria-hidden="true"/><strong aria-label={`${elapsed} seconds recorded`}>{Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,'0')}</strong><span>of 1:00</span></div>}
    {phase==='review'&&<div className="voice-command-transcript"><label htmlFor={id}>Your transcript</label><textarea ref={editor} id={id} value={transcript} onChange={event=>setTranscript(event.target.value)} maxLength={transcriptLimit} rows={4} disabled={disabled}/>{transcript.length>transcriptLimit&&<p className="voice-command-error">Shorten this transcript to {transcriptLimit.toLocaleString()} characters before adding it.</p>}</div>}
    <div className="voice-command-actions">
      {['idle','review'].includes(phase)&&<button type="button" className="button secondary" disabled={disabled} onClick={()=>void start()}><Icon name="microphone" size={16}/>{phase==='review'?'Record again':'Speak instructions'}</button>}
      {phase==='recording'&&<button type="button" className="button" onClick={stop}>Stop and transcribe</button>}
      {phase==='ready'&&<button type="button" className="button" disabled={disabled} onClick={()=>void transcribe()}>Transcribe recording</button>}
      {capturing&&<button type="button" className="button secondary" onClick={()=>cancel(phase==='transcribing'?'Voice processing stopped. No instructions were added.':'Recording discarded.')}>Cancel</button>}
      {phase==='review'&&<button type="button" className="button" disabled={disabled||!transcript.trim()||transcript.length>transcriptLimit} onClick={()=>{if(!disabledRef.current&&canObserveAgentWork()&&transcript.trim()&&transcript.length<=transcriptLimit){try{current();onUseTranscript(transcript.trim());changePhase('idle');setTranscript('');setNotice('Transcript added to your draft. Review the usual steps to continue.');}catch(failure){setError(voiceCommandError(failure));}}}}>{label}</button>}
    </div>
    <p className="voice-command-privacy">Audio is sent to ElevenLabs for transcription when you choose to transcribe. This interface does not save the recording.</p>
  </section>;
}

export function SpokenWorkResult({siteId,rootTaskId,disabled=false}:{siteId:string;rootTaskId:string;disabled?:boolean}){
  const binding=useAgentWorkBinding(siteId),[url,setUrl]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef<AbortController|null>(null),audio=useRef<HTMLAudioElement>(null),objectUrl=useRef<string|null>(null),generation=useRef(0),disabledRef=useRef(disabled);disabledRef.current=disabled;
  function clear(){generation.current++;request.current?.abort();request.current=null;audio.current?.pause();if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=null;}
  useEffect(()=>{setUrl(null);setBusy(false);setError('');return()=>clear();},[binding.identity,rootTaskId]);
  useEffect(()=>{if(disabled){clear();setUrl(null);setBusy(false);}},[disabled]);
  useEffect(()=>{const hidden=()=>{if(!canObserveAgentWork()){clear();setUrl(null);setBusy(false);}};document.addEventListener('visibilitychange',hidden);window.addEventListener('offline',hidden);return()=>{document.removeEventListener('visibilitychange',hidden);window.removeEventListener('offline',hidden);};},[binding.identity,rootTaskId]);
  async function speak(){if(busy||disabledRef.current||!canObserveAgentWork())return;clear();setUrl(null);setBusy(true);setError('');const epoch=generation.current,controller=new AbortController();request.current=controller;
    try{const blob=await speakWorkResult(rootTaskId,binding.scope,binding.getToken,()=>{if(!canObserveAgentWork()||disabledRef.current)throw new RequestError('OBSERVATION_PAUSED','Return to the saved result.');return binding.current();},AbortSignal.any([controller.signal,binding.controller.current.signal,AbortSignal.timeout(45000)]));
      if(epoch!==generation.current)return;const value=URL.createObjectURL(blob);objectUrl.current=value;setUrl(value);}
    catch{if(epoch===generation.current)setError('The saved result could not be read aloud. You can still read it on screen.');}
    finally{if(epoch===generation.current){setBusy(false);request.current=null;}}}
  return <div className="spoken-work-result"><button type="button" className="button secondary" disabled={disabled||busy} onClick={()=>void speak()}><Icon name="microphone" size={16}/>{busy?'Preparing audio…':url?'Refresh spoken result':'Listen to this result'}</button>
    {url&&<audio ref={audio} src={url} controls preload="metadata" aria-label="Spoken summary of the saved result"/>}
    {error&&<p role="alert">{error}</p>}<p className="voice-command-privacy">Reads a summary of this saved result. Playback does not execute instructions.</p></div>;
}
