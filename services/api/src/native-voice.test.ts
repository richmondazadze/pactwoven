import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import type { FoundationRepository, VerifiedIdentity } from '@pactwoven/db';
import { createNativeTaskApp } from './native-host';
import { createElevenLabsVoiceGateway, voiceAudioBytes } from './native-voice-service';
import { VoiceTranscribeCommandSchema } from '../../../packages/contracts/src/native-voice';

const origin='https://pactwoven.vercel.app', at='2026-11-19T12:00:00Z';
const headers={Authorization:'Bearer synthetic',Origin:origin,'Content-Type':'application/json'};
const audio=Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.alloc(40)]);
const input={siteId:'office',mimeType:'audio/webm' as const,audioBase64:audio.toString('base64')};
function fixture() {
  const session:Session={actor:{actorId:'operator',principalKind:'human',organizationId:'org',environment:'development',roles:['owner'],siteIds:['office'],actionSiteIds:['office'],sessionId:'session',authenticatedAt:at,correlationId:'test'},organization:{id:'org',name:'Company',authorityEpoch:1},sites:[{id:'office',name:'Office',timeZone:'America/Chicago'}]};
  const identity:VerifiedIdentity={subject:'external',externalOrganizationId:'org_external',sessionId:'session',externalOrganizationName:'Company',externalMembershipId:'member',externalRole:'org:admin',authenticatedAt:at,membershipObservedAt:at};
  const scope={environment:'development' as const,organizationId:'org',siteId:'office'};
  const view={scope,id:'root',title:'Workshop plan',prompt:'Prepare advice.',controlVersion:1,state:'running',reason:'none',checkpointVersion:0,checkpoint:null,checkpointHistorical:false,attempt:1,attemptLimit:4,generation:1,coverage:[],result:null,updatedAt:at,expiresAt:'2099-01-01T00:00:00Z',evidenceUnavailable:false,domainCompletion:false};
  const work={read:vi.fn(async()=>structuredClone(view)),control:vi.fn(),recover:vi.fn()};
  const foundation:FoundationRepository={getSession:vi.fn(async()=>session),listResponsibilities:vi.fn(),getResponsibility:vi.fn(),createResponsibility:vi.fn()};
  const gateway={transcribe:vi.fn(async()=> 'Compare workshop options.'),speak:vi.fn(async(_text:string,_signal:AbortSignal)=>new Uint8Array(64))};
  const verifyIdentity=vi.fn(async()=>identity);
  const activity={read:vi.fn(async()=>({root:structuredClone(view),instructionRevision:0,observedAt:new Date().toISOString(),children:[]}))};
  const app=createNativeTaskApp({allowedOrigins:[origin],repository:foundation,verifyIdentity,nativeAgentWorkRepository:work,nativeVoiceGateway:gateway,nativeWorkActivityRepository:activity});
  const post=(path='/v1/voice/transcribe',body:unknown=input,override=headers)=>app.request(path,{method:'POST',headers:override,body:JSON.stringify(body)});
  return{session,scope,view,work,foundation,gateway,verifyIdentity,app,post,activity};
}
describe('voice mounted in the real native application',()=>{
  it('also routes scoped activity through the full authenticated native surface',async()=>{
    const f=fixture(),response=await f.app.request('/v1/agent-work/root/activity?siteId=office',{headers});
    expect(response.status).toBe(200);expect((await response.json()).activity.rootTaskId).toBe('root');
    expect(f.activity.read).toHaveBeenCalledExactlyOnceWith(f.session.actor,'root','office');
    expect((await f.app.request('/v1/agent-work/root/activity?siteId=office')).status).toBe(401);
    expect((await f.post('/v1/agent-work/root/activity?siteId=office',{})).status).toBe(404);
  });
  it('returns a scoped draft transcript without issuing any work control',async()=>{
    const f=fixture(),response=await f.post();expect(response.status).toBe(200);
    expect(await response.json()).toEqual({scope:f.scope,transcript:'Compare workshop options.'});
    expect(response.headers.get('cache-control')).toBe('private, no-store');expect(f.gateway.transcribe).toHaveBeenCalledOnce();
    expect(f.work.control).not.toHaveBeenCalled();expect(f.work.read).not.toHaveBeenCalled();
  });
  it('admits audio beyond the old 64 KB limit only on transcription',async()=>{
    const f=fixture(),body={...input,audioBase64:Buffer.concat([audio,Buffer.alloc(70000)]).toString('base64')};
    expect((await f.post('/v1/voice/transcribe',body)).status).toBe(200);
    expect((await f.post('/v1/voice/speak',body)).status).toBe(413);
  });
  it.each(['foreign_site','foreign_origin','unsigned','forged_audio','extra_action','oversized'])('rejects %s before provider processing',async kind=>{
    const f=fixture();let body:unknown=input,h={...headers};
    if(kind==='foreign_site')body={...input,siteId:'elsewhere'};
    if(kind==='foreign_origin')h.Origin='https://untrusted.example';
    if(kind==='unsigned')h.Authorization='';
    if(kind==='forged_audio')body={...input,audioBase64:Buffer.alloc(40).toString('base64')};
    if(kind==='extra_action')body={...input,action:'approve_payment'};
    if(kind==='oversized')body={...input,audioBase64:'A'.repeat(3*1024*1024)};
    const response=await f.post('/v1/voice/transcribe',body,h);
    expect([401,403,413,422]).toContain(response.status);expect(f.gateway.transcribe).not.toHaveBeenCalled();
  });
  it('speaks only a server-selected authorized task and rereads after synthesis',async()=>{
    const f=fixture(),response=await f.post('/v1/voice/speak',{siteId:'office',rootTaskId:'root'});
    expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(f.gateway.speak.mock.calls[0]?.[0]).toBe('Workshop plan. The agent team is working');expect(f.work.read).toHaveBeenCalledTimes(2);
    expect((await f.post('/v1/voice/speak',{siteId:'office',rootTaskId:'root',text:'Payment confirmed'})).status).toBe(422);
  });
  it('withholds speech if instruction or evidence changes during synthesis',async()=>{
    const f=fixture();f.gateway.speak.mockImplementation(async()=>{f.view.controlVersion++;return new Uint8Array(64);});
    expect((await f.post('/v1/voice/speak',{siteId:'office',rootTaskId:'root'})).status).toBe(409);
  });
  it('blocks concurrent voice requests from the same operator',async()=>{
    const f=fixture();let release!:(value:string)=>void;let began!:()=>void;
    const started=new Promise<void>(resolve=>{began=resolve;});
    f.gateway.transcribe.mockImplementation(()=>{began();return new Promise(resolve=>{release=resolve;});});
    const first=f.post();await started;
    expect((await f.post()).status).toBe(429);release('Reviewed command');expect((await first).status).toBe(200);
  });
  it('permits only voice POST/OPTIONS routes and does not open unrelated paths',async()=>{
    const f=fixture();expect((await f.app.request('/v1/voice/transcribe',{headers})).status).toBe(404);
    expect((await f.post('/v1/voice/approve_payment')).status).toBe(404);
    expect((await f.app.request('/v1/voice/transcribe',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}})).status).toBe(204);
  });
});
describe('bounded fixed-origin ElevenLabs adapter',()=>{
  it('sends the recording to Scribe without source URLs or transcription edits',async()=>{
    const transport=vi.fn(async()=>Response.json({text:' Prepare options. '}));
    const gateway=createElevenLabsVoiceGateway({apiKey:'private-test-key',voiceId:'stock_voice',fetch:transport as typeof fetch});
    expect(await gateway.transcribe(input,new AbortController().signal)).toBe('Prepare options.');
    const [url,options]=transport.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');expect(options.redirect).toBe('error');
    const form=options.body as FormData;expect(form.get('model_id')).toBe('scribe_v2');expect(form.get('source_url')).toBeNull();expect(form.get('transcript_edit')).toBeNull();
  });
  it.each(['http','invalid_json','blank','too_long','too_large'])('sanitizes provider %s failure',async kind=>{
    const response=kind==='http'?new Response('secret upstream text',{status:401}):kind==='invalid_json'?new Response('private invalid body'):
      kind==='blank'?Response.json({text:' '}):kind==='too_long'?Response.json({text:'a'.repeat(12001)}):new Response('x'.repeat(512*1024+1));
    const gateway=createElevenLabsVoiceGateway({apiKey:'private-test-key',voiceId:'stock_voice',fetch:vi.fn(async()=>response) as typeof fetch});
    await expect(gateway.transcribe(input,new AbortController().signal)).rejects.toMatchObject({code:'VOICE_UNAVAILABLE',message:'Voice is temporarily unavailable. You can continue by typing.'});
  });
  it('requires matching audio format and canonical base64',()=>{
    expect(voiceAudioBytes(VoiceTranscribeCommandSchema.parse(input))).toEqual(audio);
    expect(()=>voiceAudioBytes({...input,mimeType:'audio/mp4'})).toThrow();
    expect(()=>VoiceTranscribeCommandSchema.parse({...input,audioBase64:'data:audio/webm;base64,AAAA'})).toThrow();
  });
  it('returns bounded MPEG only from the fixed voice and model',async()=>{
    const transport=vi.fn(async()=>new Response(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(61)]),{headers:{'Content-Type':'audio/mpeg'}}));
    const gateway=createElevenLabsVoiceGateway({apiKey:'private-test-key',voiceId:'stock_voice',fetch:transport as typeof fetch});
    expect((await gateway.speak('Saved result.',new AbortController().signal)).length).toBe(64);
    const [url,options]=transport.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/stock_voice?output_format=mp3_44100_128');
    expect(JSON.parse(options.body as string)).toEqual({text:'Saved result.',model_id:'eleven_multilingual_v2'});
  });
  it('withholds a mislabeled provider response instead of returning silent invalid audio',async()=>{
    const gateway=createElevenLabsVoiceGateway({apiKey:'private-test-key',voiceId:'stock_voice',fetch:vi.fn(async()=>new Response(new Uint8Array(64),{headers:{'Content-Type':'audio/mpeg'}})) as typeof fetch});
    await expect(gateway.speak('Saved result.',new AbortController().signal)).rejects.toMatchObject({code:'VOICE_UNAVAILABLE'});
  });
});
