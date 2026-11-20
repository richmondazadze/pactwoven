import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { paidQuoteFixture } from '../lib/native-paid-quote.test-fixtures';
import { paidToolFixture } from '../lib/native-paid-tool.test-fixtures';
import { EquipmentPaymentFacts, EquipmentPaymentProgress, claimPaymentDialogPrompt, paymentDialogIdentity } from './equipment-payment-dialog';

function memoryStore() {
  const values = new Map<string,string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string,value: string) => {values.set(key,value);}, values };
}

describe('payment dialog presentation boundaries', () => {
  it('prompts once across remounts and leaves unrelated authority storage intact', () => {
    const storage = memoryStore(), quote = paidQuoteFixture();
    storage.setItem('pactwoven:equipment-quote:v1:original', 'original-review-and-approval');
    const identity = paymentDialogIdentity('session-a', 'root-a', quote);
    expect(claimPaymentDialogPrompt(storage, identity)).toBe(true);
    expect(claimPaymentDialogPrompt(storage, paymentDialogIdentity('session-a','root-a',{...quote}))).toBe(false);
    expect(storage.getItem('pactwoven:equipment-quote:v1:original')).toBe('original-review-and-approval');
    expect(claimPaymentDialogPrompt(storage,paymentDialogIdentity('session-b','root-a',quote))).toBe(true);
    expect(claimPaymentDialogPrompt(storage,paymentDialogIdentity('session-a','root-b',quote))).toBe(true);
  });
  it('allows a genuinely different quote without treating an observation as a new quote', () => {
    const quote=paidQuoteFixture(),identity=paymentDialogIdentity('scope','root',quote);
    expect(paymentDialogIdentity('scope','root',{...quote,quoteHash:'e'.repeat(64)})).not.toBe(identity);
    expect(paymentDialogIdentity('scope','root',{...quote,instructionRevision:1})).not.toBe(identity);
    expect(paymentDialogIdentity('scope','root',{...quote,reviewBy:new Date(Date.parse(quote.reviewBy)+1000).toISOString()})).not.toBe(identity);
  });
  it('suppresses automatic opening when presentation storage cannot retain the marker', () => {
    expect(claimPaymentDialogPrompt({getItem(){throw Error('denied');},setItem(){throw Error('denied');}},'quote')).toBe(false);
    expect(claimPaymentDialogPrompt({getItem(){return null;},setItem(){throw Error('quota');}},'quote')).toBe(false);
    expect(claimPaymentDialogPrompt({getItem(){return null;},setItem(){}},'quote')).toBe(false);
  });
  it('keeps exact cost, recipient, network, fee and expiry visible with no account identifiers', () => {
    const quote=paidQuoteFixture();
    const html=renderToStaticMarkup(createElement(EquipmentPaymentFacts,{quote,confirmBy:quote.reviewBy,expired:false}));
    for(const value of ['0.01 devnet USDC','Pactwoven demo computation service','Solana devnet','0.000015 test SOL','Confirm before',quote.reviewBy,'No equipment purchase'])expect(html).toContain(value);
    for(const value of [quote.quoteHash,quote.recipient.owner,quote.asset.mint,quote.rootTaskId])expect(html).not.toContain(value);
    expect(html).not.toContain('<details');expect(html).not.toContain('<button');expect(html).not.toContain('<input');
  });
  it('labels an expired decision without asking for a new confirmation', () => {
    const quote=paidQuoteFixture();
    const html=renderToStaticMarkup(createElement(EquipmentPaymentFacts,{quote,confirmBy:quote.reviewBy,expired:true}));
    expect(html).toContain('Review ended');expect(html).not.toContain('Confirm before');expect(html).not.toContain('<button');
  });
  it('does not infer successful delivery from a completed label without its recorded facts', () => {
    const purchase=paidToolFixture();
    expect(renderToStaticMarkup(createElement(EquipmentPaymentProgress,{purchase,loading:false}))).toContain('Computation delivered');
    for(const missing of [{...purchase,delivery:null},{...purchase,transaction:null}]){
      expect(renderToStaticMarkup(createElement(EquipmentPaymentProgress,{purchase:missing,loading:false}))).not.toContain('<h3>Computation delivered</h3>');
    }
  });
  it('distinguishes a recorded approval, finalized payment and uncertain outcome without a retry payment control', () => {
    const purchase=paidToolFixture();
    const loading=renderToStaticMarkup(createElement(EquipmentPaymentProgress,{purchase:null,loading:true}));
    expect(loading).toContain('Approval recorded');expect(loading).not.toContain('Payment confirmed');
    const confirmed=renderToStaticMarkup(createElement(EquipmentPaymentProgress,{purchase:{...purchase,state:'payment_confirmed',delivery:null},loading:false}));
    expect(confirmed).toContain('Payment is finalized. The computation result has not been delivered yet.');
    const unknown=renderToStaticMarkup(createElement(EquipmentPaymentProgress,{purchase:{...purchase,state:'outcome_unknown',delivery:null,transaction:null},loading:false}));
    expect(unknown).toContain('outcome is unknown');expect(unknown).not.toContain('<button');expect(unknown).not.toContain('Pay again');
  });
});
