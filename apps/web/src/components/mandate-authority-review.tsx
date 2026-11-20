'use client';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { MandateAuthorityCapsule, MandateAuthorityReceipt } from '../lib/mandate-authority';
import { revealAccessTarget } from '../lib/access-viewport';
import { useMotion } from './motion';
import { Alert, Disclosure, Panel } from './ui';
import { MandateTime } from './mandate-read-shared';
import { MandateResumeReview } from './mandate-resume-review';

export function useAuthorityReveal(scopeKey: string, hidden: boolean, busy: boolean, targets: Record<string, RefObject<HTMLDivElement | null>>, identities: Record<string, string>) {
  const [revision, update] = useState(0), pending = useRef<{ target: string; identity: string; scopeKey: string } | null>(null), alive = useRef(false), current = useRef({ scopeKey, hidden }); current.current = { scopeKey, hidden };
  const { mode, keyboard } = useMotion();
  const reveal = useEffectEvent((target: HTMLElement | null) => revealAccessTarget(target, { mode, keyboard: keyboard.current, prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches, hidden: document.hidden }));
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; pending.current = null; }; }, []);
  useEffect(() => { const hide = () => { if (document.hidden) pending.current = null; }; document.addEventListener('visibilitychange', hide); return () => document.removeEventListener('visibilitychange', hide); }, []);
  useLayoutEffect(() => {
    const intent = pending.current; if (!intent) return;
    if (hidden || document.hidden || scopeKey !== intent.scopeKey) { pending.current = null; return; }
    if (busy) return;
    pending.current = null;
    if (identities[intent.target] === intent.identity) reveal(targets[intent.target]?.current ?? null);
  }, [revision, busy, hidden, scopeKey, targets, identities]);
  return (target: string, identity: string) => { if (!alive.current || document.hidden || current.current.hidden || current.current.scopeKey !== scopeKey) { pending.current = null; return; } pending.current = { target, identity, scopeKey }; update(n => n + 1); };
}
export function MandateAuthorityReview({ capsule }: { capsule: MandateAuthorityCapsule }) {
  if (capsule.intent.action === 'RESUME') return <MandateResumeReview capsule={capsule}/>;
  const e = 'envelope' in capsule.observation.data ? capsule.observation.data.envelope : capsule.observation.data, { intent } = capsule;
  return <div className="mandate-authority-review"><Panel title={intent.action === 'PAUSE' ? 'Pause the accepted authority' : 'Permanently revoke the accepted authority'}>
    <p>{intent.action === 'PAUSE' ? 'Pausing stops new use under this accepted authority.' : 'Revoking permanently ends new use under this accepted authority. There is no undo; a new proposal would need its own authorization.'} Existing obligations and recorded activity remain.</p>
    <dl className="mandate-review-facts"><div><dt>Current responsibility</dt><dd>{e.responsibility.title} · version {intent.responsibility.version}</dd></div><div><dt>Accepted mandate</dt><dd>Version {intent.mandate.version}</dd></div><div><dt>Reviewed authority</dt><dd>{e.head!.state} · epoch {intent.head.mandateEpoch}</dd></div><div><dt>Recorded transition requested</dt><dd>{capsule.nextHead.state} · epoch {capsule.nextHead.mandateEpoch}</dd></div><div><dt>Terms still expire</dt><dd><MandateTime value={capsule.nextHead.expiresAt}/></dd></div></dl>
    <h3>Reason to record</h3><p className="mandate-policy-text">{intent.reason}</p><p className="review-note">Accepted terms, mandate version and expiry stay unchanged. This control does not cancel previous decisions, orders, payments or messages. No multi-factor step is required for this stop.</p>
  </Panel><Disclosure title="Exact authority control references"><dl className="review-key-values"><div><dt>Mandate / accepted hash</dt><dd>{intent.mandate.id}<br/>{intent.mandate.hash}</dd></div><div><dt>Original head / hash</dt><dd>Version {intent.head.mandateVersion} · epoch {intent.head.mandateEpoch}<br/>{intent.head.hash}</dd></div><div><dt>Responsibility / current organization epoch</dt><dd>{intent.responsibility.id} · version {intent.responsibility.version}<br/>{intent.responsibility.hash}<br/>Organization epoch {intent.expectedOrganizationEpoch}</dd></div><div><dt>Original request</dt><dd>{capsule.key}</dd></div><div><dt>Expected recorded head</dt><dd>Epoch {capsule.expectedTarget.version}<br/>{capsule.expectedTarget.hash}</dd></div></dl></Disclosure></div>;
}
export function MandateAuthorityReceiptView({ receipt }: { receipt: MandateAuthorityReceipt }) {
  const action = receipt.recordedState === 'PAUSED' ? 'Pause' : receipt.recordedState === 'REVOKED' ? 'Revocation' : 'Resume';
  return <Alert title={`${action} recorded`} tone="blue"><p>The exact original transition was verified for accepted mandate version {receipt.locator.mandate.version}, producing head epoch {receipt.locator.expectedTarget.version}. This is a historical receipt. Check Current effective authority for the latest status.</p><p>Recorded <MandateTime value={receipt.result.observedAt}/>. Existing obligations and recorded activity remain.</p></Alert>;
}
