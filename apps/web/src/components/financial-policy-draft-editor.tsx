'use client';
import { FinancialPolicyHttpDraftSchema, FinancialPolicyInstantSchema, type FinancialPolicyHttpDraft, type FinancialPolicyRef } from '@pactwoven/contracts';
import { FinancialPolicyAuthoringInputError } from './financial-policy-document-editor';
import { ActionLabel } from './ui';

export type FinancialPolicyDraftDates = Readonly<{ startsLocal: string; expiresLocal: string; timeZone: string }>;
export const emptyFinancialPolicyDraftDates = (): FinancialPolicyDraftDates => ({ startsLocal: '', expiresLocal: '', timeZone: 'UTC' });
/** Resolve an explicit IANA zone without guessing through daylight-saving gaps or overlaps. */
export function resolveFinancialPolicyLocalTime(value: string, timeZone: string, field: string): string {
  const fail = (message: string): never => { throw new FinancialPolicyAuthoringInputError(field, message); };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return fail('Enter an exact local date and time.');
  const local = value.length === 16 ? `${value}:00` : value, naive = Date.parse(`${local}.000Z`);
  if (!Number.isFinite(naive) || !FinancialPolicyInstantSchema.safeParse(`${local}.000Z`).success) return fail('This calendar date or time does not exist.');
  if (!/^[A-Za-z0-9_+/-]{1,64}$/.test(timeZone)) throw new FinancialPolicyAuthoringInputError('draft-time-zone', 'Enter a valid IANA time zone, such as UTC or America/Chicago.');
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw new FinancialPolicyAuthoringInputError('draft-time-zone', 'This IANA time zone is unavailable. Enter UTC or a supported named zone.'); }
  const rendered = (time: number) => {
    const parts = Object.fromEntries(format.formatToParts(time).map(p => [p.type, p.value]));
    if (parts.era !== 'AD') return null;
    return `${parts.year!.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 3) {
    const sample = naive + hours * 3600000, projected = Date.parse(`${rendered(sample)}.000Z`);
    if (Number.isFinite(projected)) offsets.add(projected - sample);
  }
  const matches = [...offsets].map(offset => naive - offset).filter(time => rendered(time) === local);
  if (matches.length !== 1) return fail(matches.length ? 'This local time occurs twice. Choose an unambiguous time, or enter the exact UTC time with zone UTC.' : 'This local time does not exist in this zone. Choose another time.');
  const result = new Date(matches[0]!).toISOString();
  if (!FinancialPolicyInstantSchema.safeParse(result).success) return fail('The resolved UTC time is outside the supported range.');
  return result;
}
export function reviewFinancialPolicyDraft(dates: FinancialPolicyDraftDates, scope: FinancialPolicyHttpDraft['scope'], document: FinancialPolicyRef, now: number) {
  const startsAt = resolveFinancialPolicyLocalTime(dates.startsLocal, dates.timeZone, 'draft-start'),
    expiresAt = resolveFinancialPolicyLocalTime(dates.expiresLocal, dates.timeZone, 'draft-expiry');
  if (startsAt >= expiresAt) throw new FinancialPolicyAuthoringInputError('draft-expiry', 'Expiry must be later than the start.');
  if (!Number.isFinite(now) || Date.parse(expiresAt) <= now) throw new FinancialPolicyAuthoringInputError('draft-expiry', 'Expiry must still be in the future when reviewed and saved.');
  const draft = FinancialPolicyHttpDraftSchema.parse({ scope, documents: [{ ...document, purpose: 'financial_mandate' }], startsAt, expiresAt,
    asset: null, account: null, governance: null, trust: null,
    terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
      supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
      communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } } });
  return { draft, dates: { ...dates } };
}
export function FinancialPolicyDraftEditor({ dates, disabled, reviewed, error, onChange, onReview }: {
  dates: FinancialPolicyDraftDates; disabled: boolean; reviewed: ReturnType<typeof reviewFinancialPolicyDraft> | null;
  error: { field: string; message: string } | null; onChange: (dates: FinancialPolicyDraftDates) => void; onReview: () => void;
}) {
  return <section className="financial-authoring-editor" aria-label="Incomplete draft editor">
    <h3>Draft boundaries</h3>
    <p className="review-note">Choose a named time zone explicitly. Ambiguous or nonexistent local times cannot be saved.</p>
    <div className="financial-authoring-date-grid">
      <label htmlFor="draft-time-zone">Source time zone<input id="draft-time-zone" value={dates.timeZone} disabled={disabled} maxLength={64} autoComplete="off"
        aria-invalid={error?.field === 'draft-time-zone'} aria-describedby={error?.field === 'draft-time-zone' ? 'draft-input-error' : undefined} onChange={e => onChange({ ...dates, timeZone: e.target.value })}/></label>
      <label htmlFor="draft-start">Starts at<input type="datetime-local" step="1" id="draft-start" value={dates.startsLocal} disabled={disabled}
        aria-invalid={error?.field === 'draft-start'} aria-describedby={error?.field === 'draft-start' ? 'draft-input-error' : undefined} onChange={e => onChange({ ...dates, startsLocal: e.target.value })}/></label>
      <label htmlFor="draft-expiry">Expires at<input type="datetime-local" step="1" id="draft-expiry" value={dates.expiresLocal} disabled={disabled}
        aria-invalid={error?.field === 'draft-expiry'} aria-describedby={error?.field === 'draft-expiry' ? 'draft-input-error' : undefined} onChange={e => onChange({ ...dates, expiresLocal: e.target.value })}/></label>
    </div>
    {error && <p id="draft-input-error" className="financial-authoring-error">{error.message}</p>}
    <h3>Supported incomplete terms</h3><p>Prepare for approval · allocate funds · supplier principal · responsibility earmark.</p>
    <p className="review-note">Supplier, accepted terms, payee, tool, withdrawal and branch are not configured. Communication has no recipients, purposes or kinds; its allowance is 0 base units.</p>
    <p className="review-note">Asset, account, governance and trust are absent. Saving creates configuration only. It does not authorize spending or make funds available.</p>
    <button type="button" className="button secondary" disabled={disabled} onClick={onReview}><ActionLabel label="Review exact draft" reserve={['Review exact draft']}/></button>
    {reviewed && <section className="financial-authoring-local-review" aria-label="Exact locally reviewed draft">
      <h3>Exact boundaries for this save</h3><dl className="financial-policy-facts">
        <div><dt>Source zone</dt><dd>{reviewed.dates.timeZone}</dd></div>
        <div><dt>Entered start</dt><dd>{reviewed.dates.startsLocal}</dd></div><div><dt>Start UTC</dt><dd>{reviewed.draft.startsAt}</dd></div>
        <div><dt>Entered expiry</dt><dd>{reviewed.dates.expiresLocal}</dd></div><div><dt>Expiry UTC</dt><dd>{reviewed.draft.expiresAt}</dd></div>
      </dl><p className="review-note">These exact dates and the checked document and scope will be saved. A new edit requires another review and preparation check.</p>
    </section>}
  </section>;
}
