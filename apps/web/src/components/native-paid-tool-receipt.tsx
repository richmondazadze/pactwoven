'use client';
import { useId, useRef, useState } from 'react';
import type { NativePaidToolView } from '../../../../packages/contracts/src/native-paid-tool';
import { paidToolActionLabels, paidToolAmount, paidToolConfirmation, paidToolReceipt, paidToolReceiptKey, type PaidToolAction, type PaidToolActionRequest } from '../lib/native-paid-tool-presentation';
import './native-paid-tool-receipt.css';

export type NativePaidToolReceiptProps = {
  view: NativePaidToolView;
  observing?: boolean;
  pending?: boolean;
  onAction?: (request: PaidToolActionRequest) => void | Promise<void>;
};

/** A receipt, never a payment authorization. The host must enforce scope/CAS on every action. */
export function NativePaidToolReceipt(props: NativePaidToolReceiptProps) {
  const view = paidToolReceipt(props.view);
  if (!view) return <section className="paid-tool-receipt" role="status"><h2>Receipt needs refreshing</h2><p>This payment record could not be confirmed. Refresh its status before taking another step.</p></section>;
  return <Receipt key={paidToolReceiptKey(view)} {...props} view={view}/>;
}
function Receipt({ view, observing = true, pending = false, onAction }: NativePaidToolReceiptProps) {
  const titleId = useId(), confirmId = useId();
  const [confirmation, setConfirmation] = useState<Exclude<PaidToolAction, 'check'> | null>(null);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const disabled = pending || busy || !observing;
  const output = view.resultApplicability !== 'unavailable' ? view.delivery?.result : null;
  async function act(action: PaidToolAction) {
    if (!onAction || disabled || lock.current || !view.actions.includes(action)) return;
    lock.current = true; setBusy(true); setFailed(false); setConfirmation(null);
    try { await onAction({ action, operationId: view.operationId, version: view.version }); }
    catch { setFailed(true); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="paid-tool-receipt" aria-labelledby={titleId} aria-busy={busy || pending}>
    <header className="paid-tool-heading"><div><p className="paid-tool-eyebrow">Paid computation · {view.network}</p><h2 id={titleId}>{view.title}</h2><p>{view.purpose}</p></div><span className="paid-tool-status" role="status">{view.statusText}</span></header>
    <div className="paid-tool-charge"><div><span>Computation fee</span><strong>{paidToolAmount(view.amount)}</strong></div><p>{view.notice}</p></div>
    {view.state === 'outcome_unknown' && <p className="paid-tool-callout">The payment outcome is unknown. Check this receipt; do not start another payment.</p>}
    {view.state === 'payment_confirmed' && <p className="paid-tool-callout">Payment is finalized. The computation result has not been delivered yet.</p>}
    <section className="paid-tool-allocation" aria-label="This purchase allocation"><h3>This purchase allocation</h3><dl>{([
      ['Approved', view.allowance.limit], ['Held for this purchase', view.allowance.held],
      ['Confirmed spend', view.allowance.spent], ['Unallocated', view.allowance.unallocated],
    ] as const).map(([label, amount]) => <div key={label}><dt>{label}</dt><dd>{paidToolAmount(amount)}</dd></div>)}</dl><p>This is the allocation for this purchase, not your wallet balance. Unallocated funds do not indicate a refund.</p></section>
    <div className="paid-tool-fees"><p>Network fee paid <strong>{view.feePaid ? paidToolAmount(view.feePaid) : 'Not yet verified'}</strong></p><p>Approved fee ceiling <strong>{paidToolAmount(view.feeCeiling)}</strong></p></div>
    {view.resultApplicability === 'unavailable' && <p className="paid-tool-callout">Result content is unavailable under your current evidence access. The payment receipt is retained.</p>}
    {output && <section className="paid-tool-result" aria-label="Computation result"><div className="paid-tool-result-heading"><h3>{view.resultApplicability === 'historical' ? 'Earlier result' : 'Equipment comparison'}</h3><span>Controlled demo catalogue</span></div>
      {view.resultApplicability === 'historical' && <p className="paid-tool-callout">This result belongs to earlier instructions. It has not been adopted into the current work.</p>}
      {output.status === 'feasible' ? <><p className="paid-tool-estimate"><span>Sample equipment estimate</span><strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(output.totalMinor! / 100)}</strong><span>USD catalogue estimate · separate from the computation fee</span></p><dl className="paid-tool-capacity">{([['Seats', output.supplied!.seats], ['Microphones', output.supplied!.microphones], ['Projectors', output.supplied!.projectors]] as const).map(([name, quantity]) => <div key={name}><dt>{name}</dt><dd>{quantity}</dd></div>)}</dl></> : <p>No equipment package matched these requirements. This is a completed computation, not a failed payment.</p>}
      <p>{output.evaluatedPackages.toLocaleString('en-US')} packages compared. No equipment has been ordered.</p>
    </section>}
    {view.transaction && <a className="paid-tool-explorer" href={`https://explorer.solana.com/tx/${encodeURIComponent(view.transaction.signature)}?cluster=devnet`} target="_blank" rel="noopener noreferrer">View transaction on Solana Explorer <span>(Devnet · opens a new tab)</span></a>}
    <details className="paid-tool-details"><summary>Receipt and permission details</summary><dl>
      <div><dt>Service recipient</dt><dd>{view.recipient.label}</dd></div>
      <div><dt>Token account</dt><dd>{view.recipient.tokenAccount}</dd></div><div><dt>Recipient owner</dt><dd>{view.recipient.owner}</dd></div>
      <div><dt>Token mint</dt><dd>{view.asset.mint}</dd></div><div><dt>Token program</dt><dd>{view.asset.tokenProgram}</dd></div><div><dt>Network genesis</dt><dd>{view.asset.genesis}</dd></div>
      <div><dt>Approved</dt><dd><time dateTime={view.approvedAt}>{view.approvedAt}</time></dd></div><div><dt>Permission ends</dt><dd><time dateTime={view.permissionExpiresAt}>{view.permissionExpiresAt}</time></dd></div>
      {view.revokedAt && <div><dt>Permission revoked</dt><dd><time dateTime={view.revokedAt}>{view.revokedAt}</time></dd></div>}
      <div><dt>Receipt checked</dt><dd><time dateTime={view.asOf}>{view.asOf}</time></dd></div>
      {view.transaction && <><div><dt>Transaction status</dt><dd>{view.transaction.state}</dd></div><div><dt>Signature</dt><dd>{view.transaction.signature}</dd></div></>}
    </dl></details>
    {onAction && <div className="paid-tool-actions">{view.actions.map(action => <button key={action} type="button" className="button secondary" disabled={disabled} onClick={() => action === 'check' ? void act(action) : setConfirmation(action)}>{paidToolActionLabels[action]}</button>)}</div>}
    {confirmation && onAction && <section className="paid-tool-confirmation" aria-labelledby={confirmId}><h3 id={confirmId}>{paidToolActionLabels[confirmation]}?</h3><p>{paidToolConfirmation(confirmation)}</p><div className="paid-tool-actions"><button type="button" className="button" disabled={disabled} onClick={() => void act(confirmation)}>Confirm {confirmation === 'cancel' ? 'cancellation' : 'revocation'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmation(null)}>Keep current permission</button></div></section>}
    {!observing && <p role="status">Reconnect to check or change this purchase.</p>}
    {failed && <p role="alert">The action was not confirmed. Refresh this receipt before trying another change.</p>}
  </section>;
}
