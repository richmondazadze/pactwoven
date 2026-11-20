import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendVoiceTranscript, speakWorkResult, transcribeVoice, voiceAudioBase64, VOICE_MAX_BYTES } from './voice-command';
const scope={apiBase:'http://localhost:3108',environment:'development' as const,organizationId:'org_one',actorId:'actor_one',sessionId:'session_one',siteId:'site_one'};
const responseScope={environment:scope.environment,organizationId:scope.organizationId,siteId:scope.siteId};
beforeEach(()=>vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL',scope.apiBase));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('scoped voice transport',()=>{
  it('preserves the existing typed draft verbatim and rejects overflow instead of truncating it',()=>{
    const typed='Keep the original budget.  ';
    expect(appendVoiceTranscript(typed,'  Add delivery options.  ',4000)).toBe(`${typed}\n\nAdd delivery options.`);
    expect(appendVoiceTranscript('','A new spoken draft.',4000)).toBe('A new spoken draft.');
    expect(()=>appendVoiceTranscript('a'.repeat(3990),'long new addition',4000)).toThrowError('instruction limit');
    expect(typed).toBe('Keep the original budget.  ');
  });
  it('encodes only bounded supported audio and rejects empty/oversized/unsupported recordings',async()=>{
    expect(await voiceAudioBase64(new Blob([new Uint8Array([1,2,3])],{type:'audio/webm'}))).toBe('AQID');
    for(const blob of [new Blob([],{type:'audio/webm'}),new Blob([new Uint8Array(VOICE_MAX_BYTES+1)],{type:'audio/webm'}),new Blob(['text'],{type:'text/plain'})]) await expect(voiceAudioBase64(blob)).rejects.toMatchObject({code:'VOICE_AUDIO_INVALID'});
  });
  it('returns scoped transcript without creating a task or an execution request',async()=>{
    const fetch=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify({scope:responseScope,transcript:'Compare the test options.'}),{status:200,headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetch);
    const text=await transcribeVoice(new Blob(['audio'],{type:'audio/webm'}),scope,async()=>'qa-only',()=>scope,new AbortController().signal);
    expect(text).toBe('Compare the test options.');expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0]![0]).toBe(`${scope.apiBase}/v1/voice/transcribe`);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({siteId:'site_one',mimeType:'audio/webm',audioBase64:'YXVkaW8='});
  });
  it('rejects a transcript from another tenant and never accepts blank text',async()=>{
    for(const response of [{scope:{...responseScope,organizationId:'org_other'},transcript:'text'},{scope:responseScope,transcript:' '}]){
      vi.stubGlobal('fetch',vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify(response),{status:200})));
      await expect(transcribeVoice(new Blob(['audio'],{type:'audio/webm'}),scope,async()=>'qa-only',()=>scope,new AbortController().signal)).rejects.toMatchObject({code:'RESPONSE_UNVERIFIED'});
    }
  });
  it('does not dispatch after an account change during token retrieval',async()=>{
    let current=scope;const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(transcribeVoice(new Blob(['audio'],{type:'audio/webm'}),scope,async()=>{current={...scope,sessionId:'other_session'};return 'qa-only';},()=>current,new AbortController().signal)).rejects.toMatchObject({code:'SCOPE_CHANGED'});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends only a saved task reference for spoken output, not arbitrary model prose',async()=>{
    const fetch=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(new Uint8Array([73,68,51,0]),{headers:{'Content-Type':'audio/mpeg'}}));vi.stubGlobal('fetch',fetch);
    const blob=await speakWorkResult('root_one',scope,async()=>'qa-only',()=>scope,new AbortController().signal);
    expect(blob.type).toBe('audio/mpeg');expect(blob.size).toBe(4);expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({siteId:'site_one',rootTaskId:'root_one'});
  });
  it('rejects nonaudio output and cancels overlarge streamed audio',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response('{}',{headers:{'Content-Type':'application/json'}})));
    await expect(speakWorkResult('root_one',scope,async()=>'qa-only',()=>scope,new AbortController().signal)).rejects.toMatchObject({code:'RESPONSE_UNVERIFIED'});
    const cancelled=vi.fn(),body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(5*1024*1024+1));},cancel:cancelled});
    vi.stubGlobal('fetch',vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(body,{headers:{'Content-Type':'audio/mpeg'}})));
    await expect(speakWorkResult('root_one',scope,async()=>'qa-only',()=>scope,new AbortController().signal)).rejects.toMatchObject({code:'VOICE_AUDIO_INVALID'});expect(cancelled).toHaveBeenCalledOnce();
  });
});
