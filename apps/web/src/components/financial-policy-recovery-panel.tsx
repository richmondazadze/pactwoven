'use client';
import type { FinancialPolicyHttpReceipt } from '@pactwoven/contracts';
import type { FinancialPolicyReference } from '../lib/financial-policy-contract';
import { financialPolicyReferenceKey } from '../lib/financial-policy-recovery';
import { FinancialPolicyReceiptReview, financialPolicyLabel } from './financial-policy-review';
import { ActionLabel, Panel, StatusBadge } from './ui';

export type FinancialPolicyRecoveryRow = Readonly<{ reference: FinancialPolicyReference;
  state: 'unchecked' | 'checking' | 'recorded' | 'not-recorded' | 'unconfirmed' | 'clearing' | 'cleared';
  receipt: FinancialPolicyHttpReceipt | null; message: string }>;
export type FinancialPolicyRecoveryPanelProps = { rows: readonly FinancialPolicyRecoveryRow[]; blocked: boolean; busy: boolean;
  onLookup: (reference: FinancialPolicyReference) => void; onClear: (reference: FinancialPolicyReference) => void;
  onRefresh: () => void };
/** Presentation only: mounting never looks up, resends or clears an original. */
export function FinancialPolicyRecoveryPanel({ rows, blocked, busy, onLookup, onClear, onRefresh }: FinancialPolicyRecoveryPanelProps) {
  return <Panel title="Saved financial requests" action={<button type="button" className="button secondary" disabled={busy} onClick={onRefresh}>Refresh saved references</button>}>
    <p className="review-note">References are saved in this browser tab and can survive a reload. Browser storage is not guaranteed after closing the tab. Each original result needs its own explicit check.</p>
    {blocked ? <p role="status">Saved references could not be safely read. Originals are preserved. Check this tab's storage access before continuing.</p>
      : rows.length === 0 ? <p className="financial-policy-empty">No saved financial-policy references were found in this tab for this scope.</p>
      : <div className="financial-policy-originals">{rows.map(row => <article className="financial-policy-original" key={financialPolicyReferenceKey(row.reference)}>
        <div className="financial-policy-row-heading"><div><h3>{financialPolicyLabel(row.reference.locator.kind)}</h3><p>{row.reference.locator.targetId}</p></div>
          <StatusBadge tone={row.receipt ? 'blue' : 'neutral'}>{row.state === 'cleared' ? 'Reminder cleared' : row.receipt ? 'Original recorded' : 'Original unresolved'}</StatusBadge></div>
        <dl className="financial-policy-facts"><div><dt>Original key</dt><dd>{row.reference.locator.key}</dd></div>
          <div><dt>Public request reference</dt><dd><code>{row.reference.locator.publicRequestHash}</code></dd></div></dl>
        <p className="review-note">{row.message}</p>
        <div className="actions">{row.state !== 'cleared' && <button type="button" className="button secondary" disabled={busy || blocked} onClick={() => onLookup(row.reference)}>
          <ActionLabel label={row.state === 'checking' ? 'Checking original…' : 'Check original result'} reserve={['Checking original…', 'Check original result']}/></button>}
          {row.receipt && row.state !== 'cleared' && <button type="button" className="button secondary" disabled={busy || blocked} onClick={() => onClear(row.reference)}>
            <ActionLabel label={row.state === 'clearing' ? 'Clearing reminder…' : 'Clear this tab’s reminder'} reserve={['Clearing reminder…', 'Clear this tab’s reminder']}/></button>}</div>
        {row.receipt && <FinancialPolicyReceiptReview receipt={row.receipt}/>}
      </article>)}</div>}
  </Panel>;
}
