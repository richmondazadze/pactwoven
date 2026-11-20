import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { demoActivityFixture, demoPaymentFixture } from '../lib/demo-workspace.test-fixtures';
import { AgentActivityWorkspace, DemoPaymentCard, DemoWorkspaceResult } from './demo-workspace';

describe('actionable workspace render',()=>{
  it('shows real agents and stages without exposing opaque IDs or inventing a payment action',()=>{
    const activity=demoActivityFixture(),html=renderToStaticMarkup(createElement(AgentActivityWorkspace,{activity}));
    expect(html).toContain('Research specialist');expect(html).toContain('Compare source details');
    expect(html).toContain('Make a plan');expect(html).not.toContain(activity.agents[0]!.id);
    expect(html).not.toContain('Approve this payment');expect(html).not.toContain('Pay permitted');expect(html).not.toContain('<iframe');
  });
  it('does not leak hidden evidence or agents through the unavailable view',()=>{
    const activity={...demoActivityFixture(),freshness:'unavailable' as const,agents:[],actions:[]};
    const html=renderToStaticMarkup(createElement(AgentActivityWorkspace,{activity}));
    expect(html).toContain('Earlier activity needs review');expect(html).not.toContain('Research specialist');expect(html).not.toContain('Compare source details');
  });
  it.each(['historical','expired'] as const)('does not call visible %s activity a paused observation',state=>{
    const activity={...demoActivityFixture(),...(state==='historical'?{freshness:'historical' as const}:{freshUntil:'2020-01-01T00:00:00.000Z'})};
    const html=renderToStaticMarkup(createElement(AgentActivityWorkspace,{activity,observing:true}));
    expect(html).toContain('Showing the last available recorded activity.');
    expect(html).not.toContain('Live observation is paused.');expect(html).toContain('data-observing="false"');
    expect(html).not.toContain('class="demo-agent-focus"');
  });
  it('still labels an actually stopped observation without claiming execution paused',()=>{
    const html=renderToStaticMarkup(createElement(AgentActivityWorkspace,{activity:demoActivityFixture(),observing:false}));
    expect(html).toContain('Live observation is paused. Showing the last available activity.');
    expect(html).toContain('data-observing="false"');expect(html).not.toContain('class="demo-agent-focus"');
  });
  it('keeps long output in disclosures and escapes all model text',()=>{
    const text='<script>evil()</script> '+ 'Detailed advice. '.repeat(40);
    const result={title:'Comparison ready',summary:text,artifacts:[{id:'hidden-artifact-id',title:'Read comparison',text}],evidenceValidUntil:null,advisoryOnly:true as const};
    const html=renderToStaticMarkup(createElement(DemoWorkspaceResult,{result}));
    expect(html).toContain('Read full summary');expect(html).toContain('<details');expect(html).not.toContain('<script>');
    expect(html).not.toContain('hidden-artifact-id');expect(html).toContain('&lt;script&gt;');
  });
  it('suppresses expired results even when a caller forgets the unavailable flag',()=>{
    const result={title:'Expired secret finding',summary:'Retained but unavailable.',artifacts:[],evidenceValidUntil:'2020-01-01T00:00:00.000Z',advisoryOnly:true as const};
    const html=renderToStaticMarkup(createElement(AgentActivityWorkspace,{activity:demoActivityFixture(),result}));
    expect(html).not.toContain('Expired secret finding');
  });
  it('keeps completed advice permission distinct from a separately approved delivered computation',()=>{
    const activity=demoActivityFixture();
    activity.actions=activity.actions.map(action=>({...action,state:'completed' as const}));
    const result={title:'Equipment recommendation ready',summary:'The purchased computation supplied this recommendation.',artifacts:[],evidenceValidUntil:null,advisoryOnly:true as const};
    const payment={...demoPaymentFixture(),state:'delivered' as const,availableActions:[],transactionSignature:'2'.repeat(88)};
    const html=renderToStaticMarkup(createElement('div',null,
      createElement(DemoPaymentCard,{payment}),createElement(AgentActivityWorkspace,{activity,result})));
    expect(html).toContain('Service delivered');expect(html).toContain('Equipment recommendation ready');
    expect(html).toContain('Planning and advice permission does not authorize payments.');
    expect(html).toContain('A computation payment requires a separate exact approval.');
    expect(html).toContain('Messages and orders are not permitted.');
    expect(html).not.toContain('This work cannot send messages, place orders or make payments.');
    expect(html).not.toContain('<button');
  });
});
describe('real payment card render',()=>{
  it('requires a handler before exposing payment controls and does not call it while rendering',()=>{
    const payment=demoPaymentFixture(),handler=vi.fn();
    expect(renderToStaticMarkup(createElement(DemoPaymentCard,{payment}))).not.toContain('<button');
    renderToStaticMarkup(createElement(DemoPaymentCard,{payment,onAction:handler}));expect(handler).not.toHaveBeenCalled();
  });
  it('distinguishes chain confirmation from delivered service and includes a safe devnet receipt',()=>{
    const payment={...demoPaymentFixture(),state:'confirmed' as const,availableActions:['check' as const],transactionSignature:'2'.repeat(88)};
    const html=renderToStaticMarkup(createElement(DemoPaymentCard,{payment}));
    expect(html).toContain('Payment confirmed · awaiting service');expect(html).not.toContain('Service delivered');
    expect(html).toContain('?cluster=devnet');expect(html).toContain('noopener noreferrer');expect(html).not.toContain('private-payment-record');
  });
  it('shows unknown outcomes as needing recovery rather than an automatic retry',()=>{
    const payment={...demoPaymentFixture(),state:'unknown' as const,availableActions:['check' as const]};
    const html=renderToStaticMarkup(createElement(DemoPaymentCard,{payment,onAction:()=>{}}));
    expect(html).toContain('Payment outcome unknown');expect(html).toContain('Do not start another payment');
    expect(html).not.toContain('Pay permitted amount');expect(html).not.toContain('Approve this payment');
  });
});
