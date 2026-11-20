import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {nativeSessionFixture} from '../lib/native-tasks.test-fixtures';
import {VoiceCommandComposer,SpokenWorkResult} from './voice-command-composer';
vi.mock('./workspace-provider',()=>({useWorkspace:()=>({session:nativeSessionFixture(),getToken:async()=> 'qa-only'})}));
beforeEach(()=>vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL','http://localhost:3108'));
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('never records, transcribes or hands instructions off merely by mounting',()=>{
  const microphone=vi.fn(),fetch=vi.fn(),onUseTranscript=vi.fn();vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:microphone}});vi.stubGlobal('fetch',fetch);
  const html=renderToStaticMarkup(createElement(VoiceCommandComposer,{siteId:'site_one',onUseTranscript}));
  expect(html).toContain('Speak instructions');expect(html).toContain('Review the text');expect(html).toContain('ElevenLabs');
  expect(microphone).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(onUseTranscript).not.toHaveBeenCalled();
});
it('disables recording when the parent work cannot accept instructions',()=>{
  const html=renderToStaticMarkup(createElement(VoiceCommandComposer,{siteId:'site_one',onUseTranscript:()=>{},disabled:true}));
  expect(html).toContain('disabled=""');expect(html).not.toContain('<textarea');
});
it('does not auto-play or fetch a spoken result on mount',()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const html=renderToStaticMarkup(createElement(SpokenWorkResult,{siteId:'site_one',rootTaskId:'root_one'}));
  expect(html).toContain('Listen to this result');expect(html).not.toContain('<audio');expect(fetch).not.toHaveBeenCalled();
});
