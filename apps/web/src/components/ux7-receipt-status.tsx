import type { NativePaidToolView } from '../../../../packages/contracts/src/native-paid-tool';
import { Icon, type IconName } from './icon';

/** Status derives from receipt records, never from elapsed time or a displayed result. */
export function ReceiptProgress({ view, savedResult }: { view: NativePaidToolView; savedResult: boolean }) {
  const finalized = view.transaction?.state === 'finalized';
  const unknown = view.state === 'outcome_unknown' || view.transaction?.state === 'unknown';
  const delivered = Boolean(view.delivery) || savedResult;
  const payment = finalized ? 'Finalized' : unknown ? 'Needs checking' : view.transaction?.state === 'submitted' ? 'Submitted' : view.transaction?.state === 'signed' ? 'Signed' : 'Not yet confirmed';
  const stages: { title: string; state: string; tone: string; icon: IconName }[] = [
    { title: 'Permission', state: 'Approval recorded', tone: 'complete', icon: 'shield-lock' },
    { title: 'Payment', state: payment, tone: finalized ? 'complete' : unknown ? 'attention' : 'waiting', icon: finalized ? 'circle-check' : unknown ? 'circle-question' : 'coins' },
    { title: 'Computation', state: delivered ? 'Delivered' : finalized ? 'Awaiting delivery' : 'Not yet verified', tone: delivered ? 'complete' : 'waiting', icon: delivered ? 'circle-check' : 'document-signature' },
  ];
  return <ol className="ux7-receipt-progress" aria-label="Payment and delivery records">{stages.map(stage => <li key={stage.title} data-tone={stage.tone}><Icon name={stage.icon} size={18}/><div><span>{stage.title}</span><strong>{stage.state}</strong></div></li>)}</ol>;
}
