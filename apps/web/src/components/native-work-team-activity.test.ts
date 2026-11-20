import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { teamActivityFixture } from '../lib/native-work-team-activity.test-fixtures';
import { NativeWorkTeamActivityPanel } from './native-work-team-activity';
vi.mock('./native-agent-work-hooks',()=>({canObserveAgentWork:()=>true}));
describe('truthful current specialist rail',()=>{
 it('shows names with current Working/Waiting and no raw IDs or action controls',()=>{const{work,activity}=teamActivityFixture();const html=renderToStaticMarkup(createElement(NativeWorkTeamActivityPanel,{work,activity,observing:true}));expect(html).toContain('Research');expect(html).toContain('Working');expect(html).toContain('Waiting to start');expect(html.match(/<svg/g)).toHaveLength(1);for(const text of ['opaque-agent','opaque-planner','<button','Payment confirmed','<iframe'])expect(html).not.toContain(text);});
 it('has no saved fallback for expired/hidden/wrong control activity',()=>{const{work,activity}=teamActivityFixture();for(const props of [{work,activity,observing:false},{work:{...work,state:'paused' as const},activity,observing:true},{work,activity:{...activity,validUntil:'2020-01-01T00:00:00Z'},observing:true}])expect(renderToStaticMarkup(createElement(NativeWorkTeamActivityPanel,props))).toBe('');});
});
