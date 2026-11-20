import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { NativeWorkConversationSchema } from '../../../../packages/contracts/src/native-work-conversation';
import { NativeWorkConversationContent } from './native-work-conversation';
vi.mock('./workspace-provider',()=>({useWorkspace:()=>{throw Error('Presentation-only check.');}}));
it('renders only recorded original instructions and ordered updates, with honest application state',()=>{
  const conversation=NativeWorkConversationSchema.parse({scope:{environment:'development',organizationId:'private_org',siteId:'private_site'},rootTaskId:'private_root',instructionVersion:2,controlVersion:7,originalPrompt:'Create a four-hour workshop.',entries:[{sequence:1,text:'Keep activities seated.',recordedAt:'2026-11-19T06:00:00Z',state:'applied'},{sequence:2,text:'Include <script> breaks.',recordedAt:'2026-11-19T06:01:00Z',state:'recorded'}],canUpdate:true,updateUnavailableReason:null});
  const html=renderToStaticMarkup(createElement(NativeWorkConversationContent,{conversation}));
  expect(html).toContain('Create a four-hour workshop.');expect(html).toContain('Keep activities seated.');expect(html).toContain('Included in the team’s current instructions.');expect(html).toContain('Saved. Waiting for the team to apply this update.');
  expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('private_');expect(html).not.toContain('is typing');
});
