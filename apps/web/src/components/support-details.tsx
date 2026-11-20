'use client';
import { useEffect, useRef, useState } from 'react';
import { copySupportDetails, supportDetailEntries, supportDetailText, type SupportContext, type SupportReferences } from '../lib/presentation';
import { Icon } from './icon';
import { ActionLabel } from './ui';
import '../app/support-details.css';

export function SupportDetails({ context, error, references = {}, label = 'Support details', copyLabel = 'Copy support details' }: {
  context: SupportContext; error?: unknown; references?: SupportReferences; label?: string; copyLabel?: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'unavailable'>('idle');
  const details = useRef<HTMLDetailsElement>(null);
  const entries = supportDetailEntries(context, error, references);
  const text = supportDetailText(context, error, references);
  useEffect(() => setCopyState('idle'), [text]);
  async function copy() {
    if (copyState === 'copying') return;
    setCopyState('copying');
    const result = await copySupportDetails(text, navigator.clipboard);
    setCopyState(result);
    if (result === 'unavailable' && details.current) { details.current.open = true; details.current.querySelector('summary')?.focus(); }
  }
  return <div className="support-information"><button type="button" className="button secondary support-copy" disabled={copyState === 'copying'} onClick={() => void copy()}><Icon name={copyState === 'copied' ? 'circle-check' : 'clipboard'} size={15} /><ActionLabel label={copyState === 'copied' ? 'Copied' : copyLabel} reserve={[copyLabel, 'Copied']} /></button><span className="support-copy-status" role="status" aria-live="polite">{copyState === 'copied' ? 'Support details copied.' : copyState === 'unavailable' ? 'Copy is unavailable. Select the details below to copy them manually.' : ''}</span><details ref={details} className="support-disclosure"><summary>{label}<Icon name="chevron-down" size={15} /></summary><dl>{entries.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl><p>These references help find the original record or request. Sign-in credentials and your draft text are not included.</p></details></div>;
}
