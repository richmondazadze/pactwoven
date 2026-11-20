import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NativePaidToolReceipt } from './native-paid-tool-receipt';
import { NativePaidSavedResult } from './native-paid-saved-result';
import { ReceiptProgress } from './ux7-receipt-status';
import { EquipmentItemList } from './ux7-equipment-items';
import { paidToolFixture } from '../lib/native-paid-tool.test-fixtures';
import { paidHistoryFixture } from '../lib/native-paid-history.test-fixtures';
import { paidToolAmount } from '../lib/native-paid-tool-presentation';

vi.mock('./workspace-provider',()=>({useWorkspace:()=>{throw new Error('No session in presentation checks.');}}));

const textMarkup = (text: string) => renderToStaticMarkup(createElement('span', null, text)).replace(/^<span>|<\/span>$/g, '');
describe('UX7 saved outcome and financial fact preservation', () => {
  it('puts the admitted saved outcome before financial detail while retaining every exact financial amount', () => {
    const view = paidToolFixture(), history = paidHistoryFixture(); view.feePaid = { baseUnits: '5000', decimals: 9, symbol: 'test SOL' };
    const html = renderToStaticMarkup(createElement(NativePaidToolReceipt, { view, history }));
    expect(html.indexOf('aria-label="Saved result"')).toBeLessThan(html.indexOf('aria-label="Payment receipt"'));
    for (const amount of [view.amount, view.feePaid, view.feeCeiling, view.allowance.limit, view.allowance.held, view.allowance.spent, view.allowance.unallocated]) expect(html).toContain(paidToolAmount(amount));
    for (const value of [view.network, view.recipient.label, view.recipient.tokenAccount, view.recipient.owner, view.asset.mint, view.asset.tokenProgram, view.asset.genesis, view.approvedAt, view.permissionExpiresAt, view.asOf, view.transaction!.signature]) expect(html).toContain(value);
    expect(html).toContain('$500.00'); expect(html).toContain('USD catalogue estimate · separate from the computation fee'); expect(html).toContain('This is the allocation for this purchase, not your wallet balance.');
    expect(html).toContain('Unallocated funds do not indicate a refund.'); expect(html).not.toContain('<details open');
  });
  it('retains long multilingual prose, exact whitespace, artifacts and source destinations without inventing an agenda', () => {
    const record = paidHistoryFixture(); if (record.kind !== 'recorded') throw new Error();
    record.advice.summary = 'Workshop — 東京\n\n' + 'A long paragraph with  two spaces & <literal text>. '.repeat(40);
    record.advice.artifacts = [{ id: 'hidden-unstructured', title: 'Unstructured advice', text: 'Keep this exactly:\n\n09:00? Maybe.\nNo parsed schedule.\tΩ' }];
    const html = renderToStaticMarkup(createElement(NativePaidSavedResult, { record }));
    expect(html).toContain(textMarkup(record.advice.summary));
    expect(html).toContain(textMarkup(record.advice.artifacts[0]!.text));
    for (const source of record.provenance.sources) { expect(html).toContain(`href="${source.url}"`); expect(html).toContain(source.observedAt); }
    expect(html).toContain(record.evidenceValidUntil); expect(html).toContain('does not authorize further work or payments');
    expect(html).not.toContain('hidden-unstructured'); expect(html).not.toContain('<table'); expect(html).not.toContain('<button');
  });
  it('retains every recorded capacity including zero and exact item prices', () => {
    const items = [{ id: 'private-seat', label: 'Seats', seats: 20, microphones: 0, projectors: 0, priceMinor: 9010 }, { id: 'private-mic', label: 'Microphones & stand', seats: 0, microphones: 2, projectors: 0, priceMinor: 7040 }, { id: 'private-screen', label: 'Projection', seats: 0, microphones: 0, projectors: 1, priceMinor: 11001 }];
    const html = renderToStaticMarkup(createElement(EquipmentItemList, { items, saved: true }));
    for (const value of ['20 seats', '0 seats', '0 microphones', '2 microphones', '0 projectors', '1 projector', '$90.10', '$70.40', '$110.01', 'Microphones &amp; stand']) expect(html).toContain(value);
    expect(html).not.toContain('private-seat'); expect(html).not.toContain('private-mic'); expect(html).not.toContain('private-screen');
  });
  it.each(['authorized', 'reserved', 'signing', 'signed', 'submitting', 'payment_pending', 'outcome_unknown', 'payment_confirmed', 'completed', 'cancelled'] as const)('preserves exact receipt facts and admitted controls for %s', state => {
    const view = { ...paidToolFixture(), state, delivery: null, actions: ['check'] as const }, onAction = vi.fn();
    const html = renderToStaticMarkup(createElement(NativePaidToolReceipt, { view: { ...view, actions: [...view.actions] }, observing: false, onAction }));
    for (const value of [view.recipient.label, view.network, view.transaction!.signature, '0.01 devnet USDC', '0.000015 test SOL', 'Check payment and delivery', 'disabled=""']) expect(html).toContain(value);
    expect(html).not.toContain('Approve payment'); expect(html).not.toContain('Pay now'); expect(onAction).not.toHaveBeenCalled();
  });
  it('does not let result styling override mismatched history or unavailable evidence', () => {
    const view = paidToolFixture(), history = paidHistoryFixture();
    for (const candidate of [{ ...history, operationId: 'wrong' }, { ...history, instructionRevision: 1 }]) {
      const html = renderToStaticMarkup(createElement(NativePaidToolReceipt, { view, history: candidate, resultUnavailable: true }));
      expect(html).not.toContain('aria-label="Saved result"'); expect(html).not.toContain('Workshop equipment recommendation'); expect(html).toContain('Result content is unavailable'); expect(html).toContain(view.transaction!.signature);
    }
  });
});

describe('UX7 payment and delivery are separate recorded facts', () => {
  it('does not call a completed-looking status text proof of delivery', () => {
    const view = { ...paidToolFixture(), delivery: null };
    const html = renderToStaticMarkup(createElement(ReceiptProgress, { view, savedResult: false }));
    expect(html).toContain('Finalized'); expect(html).toContain('Awaiting delivery'); expect(html).not.toContain('>Delivered<');
  });
  it('can display a separately admitted saved delivery without requiring current result content', () => {
    const view = { ...paidToolFixture(), delivery: null, resultApplicability: 'unavailable' as const };
    expect(renderToStaticMarkup(createElement(ReceiptProgress, { view, savedResult: true }))).toContain('>Delivered<');
  });
  it.each(['signed', 'submitted', 'unknown'] as const)('does not promote transaction %s to finalized', state => {
    const original = paidToolFixture(), view = { ...original, transaction: { ...original.transaction!, state, finalizedAt: null }, delivery: null };
    const html = renderToStaticMarkup(createElement(ReceiptProgress, { view, savedResult: false }));
    expect(html).not.toContain('Finalized'); expect(html).not.toContain('Delivered'); expect(html).toContain(state === 'unknown' ? 'Needs checking' : state === 'signed' ? 'Signed' : 'Submitted');
  });
});

import { DemoWorkspaceResult } from './demo-workspace';
import { NativeAgentWorkContent } from './native-agent-work-detail';
import { agentWorkFixture } from '../lib/native-agent-work.test-fixtures';
describe('UX7 ordinary advice remains complete and evidence-gated', () => {
  const result = { title: 'Team workshop advice', summary: 'Keep the full advice. '.repeat(50), artifacts: [{ id: 'private-advice-artifact', title: 'Preparation', text: 'Original full content\n\nBring paper & pens. Do not parse this into an invented schedule.' }], advisoryOnly: true as const, evidenceValidUntil: null };
  it('preserves full prose and the existing narration action slot', () => {
    const onClick = vi.fn(), html = renderToStaticMarkup(createElement(DemoWorkspaceResult, { result, actions: createElement('button', { onClick }, 'Read aloud') }));
    expect(html).toContain(textMarkup(result.summary)); expect(html).toContain(textMarkup(result.artifacts[0]!.text)); expect(html).toContain('Read aloud'); expect(html).toContain('Saved documents'); expect(html).not.toContain('private-advice-artifact'); expect(onClick).not.toHaveBeenCalled();
  });
  it('keeps fallback saved advice readable without dropping fields', () => {
    const work = { ...agentWorkFixture(), state: 'completed' as const, result };
    const html = renderToStaticMarkup(createElement(NativeAgentWorkContent, { work }));
    expect(html).toContain(textMarkup(result.summary)); expect(html).toContain(textMarkup(result.artifacts[0]!.text)); expect(html).toContain('Advice only'); expect(html).toContain('Saved documents');
  });
  it.each(['evidenceExpired', 'instructionsChanged', 'evidenceUnavailable'] as const)('preserves fallback withholding for %s', gate => {
    const work = { ...agentWorkFixture(), state: 'completed' as const, result, evidenceUnavailable: gate === 'evidenceUnavailable' };
    const html = renderToStaticMarkup(createElement(NativeAgentWorkContent, { work, evidenceExpired: gate === 'evidenceExpired', instructionsChanged: gate === 'instructionsChanged' }));
    expect(html).not.toContain(result.title); expect(html).not.toContain('Original full content'); expect(html).not.toContain('Saved documents');
  });
});
