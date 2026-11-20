'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { RequestError } from '../lib/api';
import { speakWorkResult, transcribeVoice, voiceCommandError, voiceMimeTypes, VOICE_MAX_BYTES, VOICE_MAX_SECONDS } from '../lib/voice-command';
import { canObserveAgentWork, useAgentWorkBinding } from './native-agent-work-hooks';
import { Icon } from './icon';
import { ActionLabel } from './ui';
import './voice-command-composer.css';

type Phase='idle'|'requesting'|'recording'|'ready'|'transcribing'|'review';
const capturePhases:Phase[]=['requesting','recording','ready','transcribing'];
const time=(seconds:number)=>`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
export function VoiceCommandComposer({siteId,onUseTranscript,disabled=false,label='Use these instructions',maxLength=12000}:{siteId:string;onUseTranscript:(text:string)=>void;disabled?:boolean;label?:string;maxLength?:number}){
  const transcriptLimit=Number.isSafeInteger(maxLength)&&maxLength>0&&maxLength<=12000?maxLength:12000;
  const binding=useAgentWorkBinding(siteId),id=useId(),[phase,setPhase]=useState<Phase>('idle'),[elapsed,setElapsed]=useState(0),[transcript,setTranscript]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[micHelp,setMicHelp]=useState(false),[preview,setPreview]=useState<string|null>(null);
  const recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),chunks=useRef<Blob[]>([]),bytes=useRef(0),audio=useRef<Blob|null>(null),request=useRef<AbortController|null>(null);
  const timer=useRef<ReturnType<typeof setInterval>|null>(null),epoch=useRef(0),live=useRef(true),phaseRef=useRef<Phase>('idle'),disabledRef=useRef(disabled),editor=useRef<HTMLTextAreaElement>(null),transcriptRef=useRef(transcript),previewUrl=useRef<string|null>(null),previewPlayer=useRef<HTMLAudioElement>(null);
  phaseRef.current=phase;disabledRef.current=disabled;transcriptRef.current=transcript;
  function changePhase(value:Phase){phaseRef.current=value;setPhase(value);}
  function clearAudio(){previewPlayer.current?.pause();if(previewUrl.current)URL.revokeObjectURL(previewUrl.current);previewUrl.current=null;audio.current=null;if(live.current)setPreview(null);}
  function releaseCapture(){if(timer.current)clearInterval(timer.current);timer.current=null;const active=recorder.current;recorder.current=null;
    if(active){active.ondataavailable=null;active.onstop=null;active.onerror=null;if(active.state!=='inactive'){try{active.stop();}catch{}}}
    stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;chunks.current=[];bytes.current=0;}
  function cancel(message='Recording discarded.'){
    epoch.current++;request.current?.abort();request.current=null;releaseCapture();clearAudio();
    if(live.current){changePhase(transcriptRef.current?'review':'idle');setElapsed(0);setError('');setNotice(transcriptRef.current&&message?`${message} Your previous transcript is kept.`:message);}
  }
  const current=()=>{if(!canObserveAgentWork()||disabledRef.current)throw new RequestError('OBSERVATION_PAUSED','Return to the current work to use voice.');return binding.current();};
  useEffect(()=>{live.current=true;changePhase('idle');setTranscript('');transcriptRef.current='';setNotice('');setError('');setMicHelp(false);setPreview(null);return()=>{live.current=false;epoch.current++;request.current?.abort();releaseCapture();clearAudio();};},[binding.identity]);
  useEffect(()=>{const hidden=()=>{if(!canObserveAgentWork()&&capturePhases.includes(phaseRef.current))cancel('Voice capture stopped when you left this tab or lost your connection.');};
    document.addEventListener('visibilitychange',hidden);window.addEventListener('offline',hidden);return()=>{document.removeEventListener('visibilitychange',hidden);window.removeEventListener('offline',hidden);};},[binding.identity]);
  useEffect(()=>{if(disabled&&capturePhases.includes(phaseRef.current))cancel('Voice capture stopped because this work changed.');},[disabled]);
  useEffect(()=>{if(phase==='review')editor.current?.focus();},[phase]);
  async function transcribe(){
    const blob=audio.current;if(!blob||disabledRef.current||!canObserveAgentWork()||phaseRef.current!=='ready')return;
    const generation=epoch.current;request.current?.abort();const controller=new AbortController();request.current=controller;previewPlayer.current?.pause();changePhase('transcribing');setError('');setNotice('Transcribing your recording. Your instructions have not been added yet.');
    try{const text=await transcribeVoice(blob,binding.scope,binding.getToken,current,AbortSignal.any([controller.signal,binding.controller.current.signal,AbortSignal.timeout(45000)]));
      if(!live.current||generation!==epoch.current)return;clearAudio();setTranscript(text);changePhase('review');setNotice('Your transcript is ready. Edit anything that needs correcting, then add it to your draft.');}
    catch(failure){if(live.current&&generation===epoch.current){changePhase('ready');setError(voiceCommandError(failure));setNotice('Your recording is still here. Retry transcription or discard it.');}}
    finally{if(request.current===controller)request.current=null;}
  }
  async function start(){
    if(disabledRef.current||!canObserveAgentWork()||!['idle','review'].includes(phaseRef.current))return;
    setMicHelp(false);
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){setError('This browser cannot record audio. You can type your instructions instead.');return;}
    const mimeType=voiceMimeTypes.find(type=>MediaRecorder.isTypeSupported(type));
    if(!mimeType){setError('This browser does not support a compatible audio format. You can type your instructions instead.');return;}
    cancel('');const generation=epoch.current;changePhase('requesting');setError('');setNotice('Waiting for microphone permission. Allow access in your browser to begin.');
    try{const captured=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(!live.current||generation!==epoch.current||disabledRef.current||!canObserveAgentWork()){captured.getTracks().forEach(track=>track.stop());return;}
      stream.current=captured;current();const active=new MediaRecorder(captured,{mimeType,audioBitsPerSecond:64000});recorder.current=active;chunks.current=[];bytes.current=0;
      active.ondataavailable=event=>{if(generation!==epoch.current||!event.data.size)return;if(bytes.current+event.data.size>VOICE_MAX_BYTES){cancel('');setError('The recording reached 2 MB. Please make a shorter recording.');return;}bytes.current+=event.data.size;chunks.current.push(event.data);};
      active.onerror=()=>{if(generation===epoch.current){cancel('');setError('The microphone stopped unexpectedly. Record again or type your instructions.');}};
      active.onstop=()=>{if(generation!==epoch.current)return;const blob=new Blob(chunks.current,{type:mimeType});releaseCapture();audio.current=blob;
        if(!blob.size){changePhase(transcriptRef.current?'review':'idle');setError('No audio was recorded. Please try again.');return;}
        try{const value=URL.createObjectURL(blob);previewUrl.current=value;setPreview(value);}catch{setPreview(null);}
        changePhase('ready');setNotice('Recording stopped. Listen back if you like, then choose Transcribe recording.');};
      active.start(250);const started=performance.now();setElapsed(0);changePhase('recording');setNotice('Microphone is recording. Stop when you have finished.');
      timer.current=setInterval(()=>{const seconds=Math.min(VOICE_MAX_SECONDS,Math.floor((performance.now()-started)/1000));setElapsed(seconds);if(seconds>=VOICE_MAX_SECONDS&&active.state==='recording'){active.stop();stream.current?.getTracks().forEach(track=>track.stop());}},250);
    }catch(failure){if(live.current&&generation===epoch.current){releaseCapture();changePhase(transcriptRef.current?'review':'idle');setError(voiceCommandError(failure));setMicHelp(failure instanceof DOMException&&failure.name==='NotAllowedError');setNotice(transcriptRef.current?'Your previous transcript is kept.':'');}}
  }
  function stop(){const active=recorder.current;if(active?.state==='recording'){active.stop();stream.current?.getTracks().forEach(track=>track.stop());}}
  function useTranscript(){if(disabledRef.current||!canObserveAgentWork()||!transcript.trim()||transcript.length>transcriptLimit)return;try{current();onUseTranscript(transcript.trim());changePhase('idle');setTranscript('');transcriptRef.current='';setNotice('Transcript added to your draft. Review the usual steps to continue.');setError('');}catch(failure){setError(voiceCommandError(failure));}}
  const capturing=capturePhases.includes(phase),step=phase==='review'?2:['ready','transcribing'].includes(phase)?1:0;
  return <section className="voice-command" aria-label="Voice instructions" data-phase={phase}>
    <div className="voice-command-heading"><span className="voice-command-symbol"><Icon name="microphone" size={19}/></span><div><h3>Say what you need</h3><p>Record up to one minute. Review the text before using it.</p></div><span className="voice-command-duration">60 sec max</span></div>
    <ol className="voice-command-steps" aria-label="Voice instruction steps">{['Record','Listen & transcribe','Review & add'].map((text,index)=><li key={text} aria-current={index===step?'step':undefined} data-complete={index<step}><span aria-hidden="true">{index<step?<Icon name="circle-check" size={15}/>:index+1}</span>{text}</li>)}</ol>
    {error&&<p className="voice-command-error" role="alert">{error}</p>}
    {micHelp&&<details className="voice-command-help"><summary>How to allow your microphone</summary><p>Open this page’s site controls beside the browser address, allow Microphone, then try again. If the browser is still blocked, check its microphone permission in your device settings. You can keep typing while voice is unavailable.</p></details>}
    <p className="voice-command-status" role="status" aria-live="polite">{notice}</p>
    {phase==='recording'&&<div className="voice-command-recording"><div><span className="voice-command-recording-dot" aria-hidden="true"/><strong aria-label={`${elapsed} seconds recorded`}>{time(elapsed)}</strong><span>Recording</span><small>{VOICE_MAX_SECONDS-elapsed}s left</small></div><div className="voice-command-time-track" aria-hidden="true"><span style={{transform:`scaleX(${elapsed/VOICE_MAX_SECONDS})`}}/></div></div>}
    {['ready','transcribing'].includes(phase)&&<div className="voice-command-preview"><div><Icon name="microphone" size={18}/><strong>Your recording</strong><span>{time(elapsed)} captured</span></div>{preview&&<audio ref={previewPlayer} src={preview} controls preload="metadata" aria-label="Preview your recording"/>}<p>{phase==='transcribing'?'Waiting for the transcription service.':'This recording stays in this tab until you choose to transcribe it.'}</p></div>}
    {phase==='review'&&<div className="voice-command-transcript"><div><label htmlFor={id}>Your transcript</label><span id={`${id}-count`}>{transcript.length.toLocaleString()} / {transcriptLimit.toLocaleString()}</span></div><textarea ref={editor} id={id} value={transcript} onChange={event=>setTranscript(event.target.value)} maxLength={transcriptLimit} rows={4} disabled={disabled} aria-describedby={`${id}-count`} aria-invalid={transcript.length>transcriptLimit}/>{transcript.length>transcriptLimit&&<p className="voice-command-error">Shorten this transcript to {transcriptLimit.toLocaleString()} characters before adding it.</p>}</div>}
    <div className="voice-command-actions">
      {['idle','review'].includes(phase)&&<button type="button" className="button secondary" disabled={disabled} onClick={()=>void start()}><Icon name="microphone" size={16}/>{phase==='review'?'Record again':'Speak instructions'}</button>}
      {phase==='requesting'&&<span className="voice-command-pending"><ActionLabel pending label="Waiting for microphone…" reserve={['Waiting for microphone…']}/></span>}
      {phase==='recording'&&<button type="button" className="button" onClick={stop}><Icon name="circle-half" size={16}/>Stop recording</button>}
      {['ready','transcribing'].includes(phase)&&<button type="button" className="button" disabled={disabled||phase==='transcribing'} onClick={()=>void transcribe()}><ActionLabel pending={phase==='transcribing'} label={phase==='transcribing'?'Transcribing recording…':error?'Retry transcription':'Transcribe recording'} reserve={['Transcribing recording…','Transcribe recording','Retry transcription']}/></button>}
      {capturing&&<button type="button" className="button secondary" onClick={()=>cancel(phase==='transcribing'?'Transcription stopped. No instructions were added.':'Recording discarded.')}>{phase==='transcribing'?'Cancel transcription':phase==='requesting'?'Cancel':'Discard recording'}</button>}
      {phase==='review'&&<button type="button" className="button" disabled={disabled||!transcript.trim()||transcript.length>transcriptLimit} onClick={useTranscript}>{label}</button>}
    </div>
    {phase==='review'&&<p className="voice-command-retention">Recording again keeps this transcript until a new transcription is ready.</p>}
    <p className="voice-command-privacy">Audio is sent to ElevenLabs only when you choose to transcribe. This interface does not save the recording. Adding text never starts work automatically.</p>
  </section>;
}

export function SpokenWorkResult({siteId,rootTaskId,disabled=false}:{siteId:string;rootTaskId:string;disabled?:boolean}){
  const binding=useAgentWorkBinding(siteId),[url,setUrl]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[playback,setPlayback]=useState<'ready'|'playing'|'paused'|'ended'>('ready');
  const request=useRef<AbortController|null>(null),audio=useRef<HTMLAudioElement>(null),objectUrl=useRef<string|null>(null),generation=useRef(0),disabledRef=useRef(disabled);disabledRef.current=disabled;
  function clear(){generation.current++;request.current?.abort();request.current=null;audio.current?.pause();if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=null;}
  function cancel(){clear();setUrl(null);setBusy(false);setPlayback('ready');}
  useEffect(()=>{setUrl(null);setBusy(false);setError('');setPlayback('ready');return()=>clear();},[binding.identity,rootTaskId]);
  useEffect(()=>{if(disabled)cancel();},[disabled]);
  useEffect(()=>{const hidden=()=>{if(!canObserveAgentWork())cancel();};document.addEventListener('visibilitychange',hidden);window.addEventListener('offline',hidden);return()=>{document.removeEventListener('visibilitychange',hidden);window.removeEventListener('offline',hidden);};},[binding.identity,rootTaskId]);
  async function speak(){if(request.current||busy||disabledRef.current||!canObserveAgentWork())return;clear();setUrl(null);setBusy(true);setError('');setPlayback('ready');const epoch=generation.current,controller=new AbortController();request.current=controller;
    try{const blob=await speakWorkResult(rootTaskId,binding.scope,binding.getToken,()=>{if(!canObserveAgentWork()||disabledRef.current)throw new RequestError('OBSERVATION_PAUSED','Return to the saved result.');return binding.current();},AbortSignal.any([controller.signal,binding.controller.current.signal,AbortSignal.timeout(45000)]));
      if(epoch!==generation.current)return;const value=URL.createObjectURL(blob);objectUrl.current=value;setUrl(value);}
    catch{if(epoch===generation.current)setError('The saved result could not be read aloud. You can still read it on screen.');}
    finally{if(epoch===generation.current){setBusy(false);request.current=null;}}}
  return <section className="spoken-work-result" aria-label="Listen to saved result" data-playing={playback==='playing'}>
    <div className="spoken-work-heading"><span className="voice-command-symbol" aria-hidden="true"><Icon name="microphone" size={18}/></span><div><h3>Listen to the result</h3><p>A spoken summary of the saved result.</p></div></div>
    {!url&&<div className="voice-command-actions"><button type="button" className="button secondary" disabled={disabled||busy} onClick={()=>void speak()}><ActionLabel pending={busy} label={busy?'Preparing audio…':error?'Try audio again':'Listen to this result'} reserve={['Preparing audio…','Listen to this result','Try audio again']}/></button>{busy&&<button className="button secondary" type="button" onClick={cancel}>Cancel audio</button>}</div>}
    {url&&<><p className="spoken-work-status" role="status">{playback==='playing'?'Playing saved summary':playback==='paused'?'Playback paused':playback==='ended'?'Summary finished. You can replay it below.':'Audio ready. Press play when you are ready.'}</p><audio ref={audio} src={url} controls preload="metadata" aria-label="Spoken summary of the saved result" onPlay={()=>setPlayback('playing')} onPause={()=>setPlayback(value=>value==='ended'?'ended':'paused')} onEnded={()=>setPlayback('ended')} onError={()=>{clear();setUrl(null);setError('This browser could not play the audio. Try again or read the saved result.');}}/><button className="spoken-work-clear" type="button" onClick={cancel}>Close audio</button></>}
    {busy&&<p className="spoken-work-status" role="status">Preparing a spoken summary. Playback will not start automatically.</p>}
    {error&&<p role="alert">{error}</p>}<p className="voice-command-privacy">Playback does not execute instructions. Replay uses the audio already prepared in this tab.</p>
  </section>;
}
