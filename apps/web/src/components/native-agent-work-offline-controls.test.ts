import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeAgentWorkSchema, type NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import { nativeSessionFixture } from '../lib/native-tasks.test-fixtures';
import { agentWorkFixture } from '../lib/native-agent-work.test-fixtures';
import { agentWorkScope } from '../lib/native-agent-work';
import { NativeAgentWorkDetail } from './native-agent-work-detail';

let work:NativeAgentWork,visible=true;
vi.mock('./workspace-provider',()=>({useWorkspace:()=>({session:nativeSessionFixture()})}));
vi.mock('./native-agent-work-hooks',()=>({canObserveAgentWork:()=>visible,useAgentWorkDetail:()=>({data:{work},visible,error:null,isFetching:false,refetch:vi.fn()}),
 useAgentWorkBinding:()=>({session:nativeSessionFixture(),scope:agentWorkScope(nativeSessionFixture(),'site_one'),current:vi.fn(),live:{current:true},controller:{current:new AbortController()},getToken:vi.fn()})}));
beforeEach(()=>{vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL','http://localhost:3108');work=agentWorkFixture();visible=true;});
afterEach(()=>vi.unstubAllEnvs());
const render=()=>renderToStaticMarkup(createElement(QueryClientProvider,{client:new QueryClient()},createElement(NativeAgentWorkDetail,{siteId:'site_one',id:'root_internal'})));
it('offers no cancellation without a returned authoritative action',()=>{
 work=NativeAgentWorkSchema.parse({...work,state:'working',progress:null,availableActions:[]});expect(render()).not.toContain('Cancel work');
});
it('preserves pause for ordinary work and resume for ordinary paused work',()=>{
 expect(render()).toContain('Pause work');work={...work,state:'paused',availableActions:['resume','cancel']};expect(render()).toContain('Resume work');
});
it('labels offline records historical and stops active progress animation without claiming work was paused',()=>{
 visible=false;const html=render();expect(html).toContain('Live updates are paused');expect(html).toContain('Showing the last saved status.');
 expect(html).toContain('Background work keeps its current instructions.');expect(html).toContain('data-observing="false"');
 expect(html).not.toContain('data-observing="true"');expect(html).not.toContain('This work stays paused until you resume it.');
});
it('does not show an offline notice for current connected work',()=>{
 expect(render()).not.toContain('Live updates are paused');
});
