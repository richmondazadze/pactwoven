'use client';
import { FinancialPolicyTextSchema } from '@pactwoven/contracts';
import { ActionLabel } from './ui';

export class FinancialPolicyAuthoringInputError extends Error {
  constructor(readonly field: string, message: string) { super(message); }
}
/** Only user-entered text is normalized, before review. Received server text is never repaired. */
export function reviewFinancialPolicyDocument(value: string): Readonly<{ text: string; changed: boolean }> {
  const text = value.replace(/\r\n?/g, '\n').normalize('NFC');
  if (!FinancialPolicyTextSchema.safeParse(text).success)
    throw new FinancialPolicyAuthoringInputError('policy-text', 'Enter nonblank policy text, up to 20,000 characters, without unsupported control characters.');
  return Object.freeze({ text, changed: text !== value });
}
export function FinancialPolicyDocumentEditor({ text, disabled, reviewed, error, onChange, onReview }: {
  text: string; disabled: boolean; reviewed: string | null; error: string | null;
  onChange: (text: string) => void; onReview: () => void;
}) {
  return <section className="financial-authoring-editor" aria-label="Policy text editor">
    <label htmlFor="policy-text">Full financial-mandate text</label>
    <p id="policy-text-help" className="review-note">Write the complete terms. Review normalizes line endings and Unicode before you check preparation. Nothing is saved while you type.</p>
    <textarea id="policy-text" value={text} maxLength={40000} rows={14} disabled={disabled}
      aria-describedby={`policy-text-help${error ? ' policy-text-error' : ''}`} aria-invalid={Boolean(error)}
      onChange={event => onChange(event.target.value)} spellCheck/>
    {error && <p id="policy-text-error" className="financial-authoring-error">{error}</p>}
    <button type="button" className="button secondary" disabled={disabled} onClick={onReview}><ActionLabel label="Review exact text" reserve={['Review exact text']}/></button>
    {reviewed !== null && <section className="financial-authoring-local-review" aria-label="Exact locally reviewed text">
      <h3>Exact text for this save</h3><p className="financial-policy-text">{reviewed}</p>
      <p className="review-note">Any edit removes this review and the preparation check. The final save is a separate action.</p>
    </section>}
  </section>;
}
