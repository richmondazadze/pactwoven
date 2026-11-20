import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {paidToolFixture} from '../lib/native-paid-tool.test-fixtures';
import {paidHistoryFixture} from '../lib/native-paid-history.test-fixtures';
import {NativePaidToolReceipt} from './native-paid-tool-receipt';
describe('saved public result inside original receipt',()=>{
 it('shows timestamp, readable itemized selection and details with no added controls or opaque IDs',()=>{
  const history=paidHistoryFixture(),view={...paidToolFixture(),resultApplicability:'unavailable' as const,delivery:null};
  const html=renderToStaticMarkup(createElement(NativePaidToolReceipt,{view,history,resultUnavailable:true}));
  expect(html).toContain('Saved result');expect(html).toContain('2026-11-19T16:00:10Z');expect(html).toContain('Sources and prices have not been checked again');
  expect(html).toContain('Workshop seating and presentation package');expect(html).toContain('$500.00');expect(html).toContain('Equipment estimate budget: $600.00');
  expect(html).toContain('0.01 devnet USDC');expect(html).toContain('View transaction on Solana Explorer');expect(html).toContain('Preparation checklist');
  expect(html).not.toContain('hidden-operation');expect(html).not.toContain('hidden-artifact');expect(html).not.toContain('hidden-offer');
  expect(html).not.toContain('<button');expect(html).not.toContain('Listen');expect(html).not.toContain('Result content is unavailable');
 });
 it('does not fall back to live output when a saved response has a different operation',()=>{
  const history=paidHistoryFixture();history.operationId='other';const html=renderToStaticMarkup(createElement(NativePaidToolReceipt,{view:paidToolFixture(),history}));
  expect(html).toContain('Result content is unavailable');expect(html).not.toContain('Workshop seating');expect(html).not.toContain('Sample equipment estimate');expect(html).toContain('View transaction on Solana Explorer');
 });
 it('withholds current output while history loads and on an explicit result-expiry boundary',()=>{
  for(const props of [{resultUnavailable:true,historyLoading:true},{resultUnavailable:true}]){
   const html=renderToStaticMarkup(createElement(NativePaidToolReceipt,{view:paidToolFixture(),...props}));expect(html).not.toContain('Sample equipment estimate');expect(html).toContain('payment receipt is retained');
  }
 });
 it('escapes model/catalogue text and keeps long advice collapsed',()=>{
  const history=paidHistoryFixture();if(history.kind!=='recorded')throw Error();history.advice.summary='<script>bad()</script> '+ 'Saved advice. '.repeat(60);history.equipment.items[0]!.label='<img src=x onerror=alert(1)>';
  const html=renderToStaticMarkup(createElement(NativePaidToolReceipt,{view:paidToolFixture(),history,resultUnavailable:true}));
  expect(html).toContain('Read full summary');expect(html).toContain('&lt;script&gt;');expect(html).toContain('&lt;img');expect(html).not.toContain('<script>');expect(html).not.toContain('<img src=x');expect(html).not.toContain('<details open');
 });
 it('does not add or invoke payment controls through the historical record',()=>{
  const handler=vi.fn(),view={...paidToolFixture(),actions:[]};const html=renderToStaticMarkup(createElement(NativePaidToolReceipt,{view,history:paidHistoryFixture(),resultUnavailable:true,onAction:handler}));
  expect(handler).not.toHaveBeenCalled();expect(html).not.toContain('<button');expect(html).toContain('does not authorize further work or payments');
 });
});
