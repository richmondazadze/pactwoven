import { z } from 'zod';
import { IdSchema } from '@pactwoven/contracts';
import { RequestError, requestApiAtBase, type TokenSource } from './api';
import { getNativeApiBase } from './config';
import { agentWorkResponseScope, type AgentWorkScope } from './native-agent-work';

export const VOICE_MAX_BYTES = 2 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 60;
export const voiceMimeTypes = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus','audio/ogg'] as const;
export const VoiceTranscriptSchema = z.strictObject({ scope: z.strictObject({ environment:z.enum(['simulation','development','staging','production']),organizationId:IdSchema,siteId:IdSchema }),
  transcript:z.string().trim().min(1).max(12000) });

/** Preserve the current typed draft verbatim; voice can add text but never replace it silently. */
export function appendVoiceTranscript(draft: string, transcript: string, maximum: number) {
  const addition=transcript.trim();
  if(!addition)throw new RequestError('VOICE_TRANSCRIPT_EMPTY','The transcript is empty.');
  const combined=`${draft}${draft?'\n\n':''}${addition}`;
  if(combined.length>maximum)throw new RequestError('VOICE_DRAFT_TOO_LONG','The transcript and existing draft exceed the instruction limit.');
  return combined;
}

export function voiceScopeCheck(scope: AgentWorkScope, current: () => AgentWorkScope) {
  if (getNativeApiBase() !== scope.apiBase || JSON.stringify(current()) !== JSON.stringify(scope)) throw new RequestError('SCOPE_CHANGED','Your workspace changed.');
}

export async function voiceAudioBase64(blob: Blob) {
  if (!blob.size || blob.size > VOICE_MAX_BYTES || !voiceMimeTypes.includes(blob.type as typeof voiceMimeTypes[number])) throw new RequestError('VOICE_AUDIO_INVALID','Record up to one minute of audio, under 2 MB.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary='';for(let offset=0;offset<bytes.length;offset+=32768) binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return btoa(binary);
}

export async function transcribeVoice(blob: Blob, scope: AgentWorkScope, getToken: TokenSource, current: () => AgentWorkScope, signal: AbortSignal) {
  voiceScopeCheck(scope,current);signal.throwIfAborted();
  const audioBase64=await voiceAudioBase64(blob);signal.throwIfAborted();voiceScopeCheck(scope,current);
  const response=await requestApiAtBase(scope.apiBase,'/v1/voice/transcribe',VoiceTranscriptSchema.refine(value=>agentWorkResponseScope(scope,value)),
    async()=>{voiceScopeCheck(scope,current);return getToken();},{signal,body:{siteId:scope.siteId,mimeType:blob.type,audioBase64},beforeDispatch:()=>{voiceScopeCheck(scope,current);}});
  signal.throwIfAborted();voiceScopeCheck(scope,current);return response.transcript;
}

export async function speakWorkResult(rootTaskId: string, scope: AgentWorkScope, getToken: TokenSource, current: () => AgentWorkScope, signal: AbortSignal) {
  IdSchema.parse(rootTaskId);voiceScopeCheck(scope,current);signal.throwIfAborted();
  const token=await getToken();signal.throwIfAborted();voiceScopeCheck(scope,current);
  if(!token)throw new RequestError('SESSION_REQUIRED','Sign in again to continue.',401);
  const response=await fetch(`${scope.apiBase}/v1/voice/speak`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'audio/mpeg'},
    body:JSON.stringify({siteId:scope.siteId,rootTaskId}),credentials:'omit',cache:'no-store',signal});
  if(!response.ok)throw new RequestError('VOICE_PLAYBACK_UNAVAILABLE','The saved result could not be read aloud.',response.status);
  if(response.headers.get('content-type')?.split(';')[0]?.trim()!=='audio/mpeg')throw new RequestError('RESPONSE_UNVERIFIED','Audio was not returned.');
  const reader=response.body?.getReader();if(!reader)throw new RequestError('RESPONSE_UNVERIFIED','Audio was not returned.');
  let size=0;const chunks:Uint8Array<ArrayBuffer>[]=[];
  try{while(true){signal.throwIfAborted();voiceScopeCheck(scope,current);const item=await reader.read();if(item.done)break;size+=item.value.byteLength;
    if(size>5*1024*1024)throw new RequestError('VOICE_AUDIO_INVALID','The spoken result is too large.');chunks.push(new Uint8Array(item.value));}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  signal.throwIfAborted();voiceScopeCheck(scope,current);if(!size)throw new RequestError('RESPONSE_UNVERIFIED','Audio was not returned.');
  return new Blob(chunks,{type:'audio/mpeg'});
}

export function voiceCommandError(error: unknown) {
  if(error instanceof DOMException){if(error.name==='NotAllowedError')return 'Microphone access was not allowed. You can type your instructions instead.';
    if(error.name==='NotFoundError')return 'No microphone was found. Connect one or type your instructions.';
    if(error.name==='AbortError')return 'Voice processing stopped. Your task was not started.';}
  if(error instanceof RequestError){if(error.code==='SCOPE_CHANGED')return 'Your workspace changed. Record again in the current workspace.';
    if(error.code==='VOICE_DRAFT_TOO_LONG')return 'The existing draft has been kept. Shorten the transcript before adding it.';
    if(error.status===401||error.status===403)return 'Check your sign-in and workspace access before using voice.';
    if(error.code==='VOICE_AUDIO_INVALID')return 'The recording could not be used. Record up to one minute, under 2 MB.';
    if(error.status===503)return 'Voice is not available right now. You can type your instructions instead.';}
  return 'We could not process that recording. Your task was not started. You can type your instructions instead.';
}
