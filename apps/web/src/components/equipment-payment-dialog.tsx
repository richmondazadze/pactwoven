'use client';

import { useRef, type ReactNode, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { NativePaidQuoteView } from '../../../../packages/contracts/src/native-paid-quote';
import type { NativePaidToolView } from '../../../../packages/contracts/src/native-paid-tool';
import { agentWorkTime } from '../lib/native-agent-work';
import { paidToolAmount } from '../lib/native-paid-tool-presentation';
import { Icon } from './icon';
import './equipment-payment-dialog.css';

/** Presentation identity only. Never used as payment or review authority. */
export function paymentDialogIdentity(scope: string, rootTaskId: string, quote: NativePaidQuoteView) {
  return JSON.stringify([scope, rootTaskId, quote.quoteId, quote.quoteHash, quote.instructionRevision, quote.reviewBy]);
}
export function claimPaymentDialogPrompt(storage: Pick<Storage, 'getItem' | 'setItem'>, identity: string): boolean {
  const key = `pactwoven:payment-dialog:${identity}`;
  try {
    if (storage.getItem(key) === 'shown') return false;
    storage.setItem(key, 'shown');
    return storage.getItem(key) === 'shown';
  } catch { return false; }
}

export function EquipmentPaymentDialog({ open, onOpenChange, returnFocus, fallbackFocus, title, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; returnFocus: RefObject<HTMLButtonElement | null>;
  fallbackFocus?: RefObject<HTMLElement | null>; title: string; children: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="payment-dialog-overlay"/>
      <Dialog.Content className="payment-dialog equipment-payment-panel" aria-modal="true"
        onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); (returnFocus.current?.isConnected && !returnFocus.current.disabled ? returnFocus.current : fallbackFocus?.current)?.focus({ preventScroll: true }); }}>
        <header className="payment-dialog-heading">
          <span className="payment-dialog-symbol" aria-hidden="true"><Icon name="receipt" size={22}/></span>
          <div><p className="payment-dialog-eyebrow">Your payment decision</p><Dialog.Title ref={titleRef} tabIndex={-1}>{title}</Dialog.Title></div>
          <Dialog.Close className="icon-button" aria-label="Close payment review"><Icon name="close" size={18}/></Dialog.Close>
        </header>
        <Dialog.Description className="payment-dialog-description">Review the computation and its exact cost. Payment only happens after your explicit approval.</Dialog.Description>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function EquipmentPaymentFacts({ quote, confirmBy, expired }: { quote: NativePaidQuoteView; confirmBy: string; expired: boolean }) {
  return <section className="payment-dialog-facts" aria-label="Payment facts">
    <div className="payment-dialog-amount"><span>Computation fee</span><strong>{paidToolAmount(quote.amount)}</strong><p>{quote.title}</p></div>
    <dl className="payment-dialog-key-values">
      <div><dt>Recipient</dt><dd>{quote.recipient.label}</dd></div>
      <div><dt>Network</dt><dd>{quote.network}</dd></div>
      <div><dt>Maximum network fee</dt><dd>{paidToolAmount(quote.feeCeiling)}</dd></div>
      <div><dt>{expired ? 'Review ended' : 'Confirm before'}</dt><dd><time dateTime={confirmBy}>{agentWorkTime(confirmBy)}</time></dd></div>
    </dl>
    <p className="payment-dialog-notice"><Icon name="circle-question" size={18}/><span>Computation only. No equipment purchase or permission for other tasks.</span></p>
  </section>;
}

export function EquipmentPaymentProgress({ purchase, loading }: { purchase: NativePaidToolView | null; loading: boolean }) {
  const delivered = purchase?.state === 'completed' && purchase.delivery !== null && purchase.transaction?.state === 'finalized';
  const confirmed = purchase?.state === 'payment_confirmed';
  const unknown = purchase?.state === 'outcome_unknown';
  return <section className="payment-dialog-progress" role="status" data-complete={delivered || confirmed}>
    <Icon name={delivered || confirmed ? 'circle-check' : unknown ? 'triangle-alert' : 'clock-arrow'} size={30}/>
    <h3>{delivered ? 'Computation delivered' : confirmed ? 'Payment confirmed' : unknown ? 'Payment status needs checking' : purchase?.statusText ?? 'Approval recorded'}</h3>
    <p>{delivered ? 'The original payment and saved computation result are available in this task.' : confirmed ? 'Payment is finalized. The computation result has not been delivered yet.' : unknown ? 'The outcome is unknown. Check the original receipt before taking another action.' : loading ? 'Checking the recorded payment and delivery. This does not start another payment.' : 'Follow the original receipt in this task for the latest payment and delivery status.'}</p>
  </section>;
}
