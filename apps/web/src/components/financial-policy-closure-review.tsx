'use client';
import { useLayoutEffect } from 'react';
import type { FinancialPolicyQualifiedClosure } from '../lib/financial-policy-contract';
import type { FinancialPolicyClosureReview } from '../lib/financial-policy-closure-client';
import { useArrival } from './motion';
import { Disclosure } from './ui';

export const financialPolicyClosureHeadingId = (requestHash: string) => `financial-policy-closure-${requestHash}`;

function Pins({ expected }: { expected: FinancialPolicyClosureReview['request']['expected'] }) {
  return <dl className="financial-policy-facts">
    <div><dt>Organization</dt><dd>{expected.organizationId} · {expected.environment}</dd></div>
    <div><dt>Reviewed actor</dt><dd>{expected.actor.actorId} · membership version {expected.actor.membershipVersion}</dd></div>
    <div><dt>Organization epoch</dt><dd>{expected.organizationEpoch}</dd></div>
    {expected.draftScope ? <>
      <div><dt>Responsibility</dt><dd>{expected.draftScope.authority.responsibility.id} · version {expected.draftScope.authority.responsibility.version}</dd></div>
      <div><dt>Authority basis</dt><dd>{expected.draftScope.authority.family} · generation {expected.draftScope.authority.generation}<code>{expected.draftScope.authorityHash}</code></dd></div>
      <div><dt>Site basis</dt><dd>{expected.draftScope.site.id} · generation {expected.draftScope.site.generation}<code>{expected.draftScope.site.recordHash}</code></dd></div>
    </> : <div><dt>Scope</dt><dd>Organization policy text</dd></div>}
  </dl>;
}
export function FinancialPolicyOriginalClosureReview({ review }: { review: FinancialPolicyClosureReview }) {
  const heading = useArrival(review, 200);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, [heading, review]);
  return <section className="financial-authoring-local-review" aria-label="Review original request closure">
    <div ref={heading} tabIndex={-1}><h3>Review closing this original request</h3></div>
    <p>The last explicit lookup returned no recorded result. That lookup does not cancel the original.</p>
    <p>Closing permanently prevents this original key from being saved. If the original commits first, the service returns its actual saved result instead. An existing policy is never deleted or cancelled.</p>
    <p className="review-note">Use this when the original input is unavailable. Closure creates no policy version, spending authority or available funds. Clearing this tab’s reminder remains a separate action after inspecting the result.</p>
    <Disclosure title="Reviewed access and basis details"><Pins expected={review.request.expected}/></Disclosure>
    <p className="review-note">These current pins were selected for this closure only. Review expires at {new Date(review.expiresAt).toISOString()} UTC.</p>
  </section>;
}
export function FinancialPolicyClosureReceiptReview({ closure }: { closure: FinancialPolicyQualifiedClosure }) {
  return <section className="financial-policy-receipt" aria-label="Immutable original request closure">
    <h3 id={financialPolicyClosureHeadingId(closure.locator.publicRequestHash)} tabIndex={-1}>Original request permanently closed</h3>
    <p>This receipt prevents the original request key from committing. It is not a policy receipt and cannot select policy text or authorize spending.</p>
    <dl className="financial-policy-facts"><div><dt>Closure receipt</dt><dd>{closure.id}</dd></div>
      <div><dt>Closed at</dt><dd>{closure.closedAt} UTC</dd></div>
      <div><dt>Closure record reference</dt><dd><code>{closure.recordHash}</code></dd></div></dl>
    <Disclosure title="Historical access and basis details"><Pins expected={closure.expected}/></Disclosure>
    <p className="review-note">These immutable pins describe the closure when it was recorded. They do not describe today’s membership or authority. Clear only this matching tab reminder separately, then check fresh context and preparation before a new save.</p>
  </section>;
}
