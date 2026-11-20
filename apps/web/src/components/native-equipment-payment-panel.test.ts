import { createElement } from 'react';import { renderToStaticMarkup } from 'react-dom/server';import { describe,expect,it,vi } from 'vitest';
import { paidQuoteFixture } from '../lib/native-paid-quote.test-fixtures';import { EquipmentPlanningState,EquipmentQuoteSummary } from './native-equipment-payment-panel';
vi.mock('./workspace-provider',()=>({useWorkspace:()=>{throw Error('No session in presentation test.');}}));
describe('actionable equipment quote display',()=>{it('separates actual computation fee from sample USD budget and does not expose technical identities by default',()=>{const q=paidQuoteFixture(),html=renderToStaticMarkup(createElement(EquipmentQuoteSummary,{quote:q}));expect(html).toContain('0.01 devnet USDC');expect(html).toContain('$600.00');expect(html).toContain('Seats');expect(html).toContain('No equipment is ordered');expect(html).toContain('<details');expect(html).not.toContain(q.quoteHash);expect(html).not.toContain(q.rootTaskId);expect(html).not.toContain('<button');});it('renders provider text as escaped content with retained readable offer labels',()=>{const q=paidQuoteFixture();q.reason='<script>pretend approval</script>';const html=renderToStaticMarkup(createElement(EquipmentQuoteSummary,{quote:q}));expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');expect(html).toContain('Workshop package');});});

describe('equipment planning follows the actual task state',()=>{
  it.each([
    ['needs_review','Equipment comparison needs review','Work has stopped without an equipment quote.'],
    ['cancelled','Equipment comparison stopped','cancelled without an equipment quote'],
    ['completed','No equipment quote was prepared','This task has finished.'],
    ['paused','Equipment comparison paused','Resume this task'],
    ['queued','Equipment comparison queued','has not started'],
    ['waiting','Equipment comparison waiting','Check the task status'],
  ] as const)('%s does not claim work or payment is progressing',(workState,title,message)=>{
    const html=renderToStaticMarkup(createElement(EquipmentPlanningState,{workState}));
    expect(html).toContain(title);expect(html).toContain(message);expect(html).toContain('role="status"');
    expect(html).not.toContain('The team is working');expect(html).not.toContain('No payment has been approved');expect(html).not.toContain('<button');
  });
  it('shows preparation only while the task is working',()=>{
    const html=renderToStaticMarkup(createElement(EquipmentPlanningState,{workState:'working'}));
    expect(html).toContain('Preparing an equipment comparison');expect(html).toContain('The team is working');
    expect(html).not.toContain('No payment has been approved');
  });
});
