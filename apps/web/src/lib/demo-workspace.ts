import { z } from 'zod';
import type { NativeWorkActivity } from '../../../../packages/contracts/src/native-work-activity';

export type DemoWorkspaceTarget = 'plan' | 'team' | 'result';
export const demoWorkspaceStages: ReadonlyArray<{ id: DemoWorkspaceTarget; title: string; empty: string }> = [
  { id: 'plan', title: 'Make a plan', empty: 'The plan appears when the team records it.' },
  { id: 'team', title: 'Do the work', empty: 'Agent contributions appear here as work progresses.' },
  { id: 'result', title: 'Bring it together', empty: 'The finished result will appear here.' },
];
export const demoActionLabels = { queued: 'Ready to start', active: 'Working', waiting: 'Waiting', paused: 'Paused',
  cancelled: 'Cancelled', completed: 'Complete', needs_review: 'Needs your attention' } as const;

/** A recorded snapshot describes focus, never a fabricated browser click or percentage. */
export function demoAgentFocus(activity: NativeWorkActivity, observing: boolean, now: number) {
  if (!observing || activity.freshness !== 'current' || !Number.isFinite(now) || Date.parse(activity.expiresAt) <= now || Date.parse(activity.freshUntil) <= now) return [];
  return activity.agents.flatMap(agent => {
    const action = activity.actions.filter(item => item.actorId === agent.id && item.state === 'active')
      .sort((left, right) => (right.recordedAt ? Date.parse(right.recordedAt) : 0) - (left.recordedAt ? Date.parse(left.recordedAt) : 0))[0];
    return action ? [{ actorId: agent.id, label: agent.label, target: action.target, actionId: action.id }] : [];
  });
}

export function demoWorkspaceAnnouncement(previous: NativeWorkActivity | undefined, next: NativeWorkActivity, observing: boolean) {
  if (!observing || next.freshness !== 'current') return '';
  if (previous && (previous.rootTaskId !== next.rootTaskId || Date.parse(previous.asOf) > Date.parse(next.asOf) ||
    previous.revision.controlVersion > next.revision.controlVersion)) return '';
  const changed = next.actions.filter(action => !previous?.actions.some(old => old.id === action.id && old.state === action.state && old.label === action.label));
  return changed.slice(0, 2).map(action => `${next.agents.find(agent => agent.id === action.actorId)?.label ?? 'The team'}: ${action.label}. ${demoActionLabels[action.state]}.`).join(' ');
}

export function demoTextPreview(text: string, limit = 280) {
  if (text.length <= limit) return { text, shortened: false };
  const boundary = text.lastIndexOf(' ', limit);
  return { text: `${text.slice(0, boundary > limit / 2 ? boundary : limit).trimEnd()}…`, shortened: true };
}

const amountSchema = z.strictObject({ units: z.string().regex(/^(0|[1-9]\d{0,38})$/), decimals: z.number().int().min(0).max(18),
  symbol: z.string().min(1).max(24), assetLabel: z.string().min(1).max(160) });
export const DemoPaymentCardSchema = z.strictObject({
  id: z.string().min(1).max(256), serviceName: z.string().min(1).max(180), purpose: z.string().min(1).max(1000),
  state: z.enum(['quoted','needs_approval','authorized','submitted','confirmed','delivered','rejected','failed','unknown']),
  amount: amountSchema, remaining: amountSchema.nullable(), networkFee: amountSchema.nullable(),
  network: z.literal('Solana devnet'), recipientLabel: z.string().min(1).max(180),
  recordedAt: z.iso.datetime(), validUntil: z.iso.datetime(),
  transactionSignature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/).nullable(),
  availableActions: z.array(z.enum(['review','approve','reject','pay','check'])).max(5),
  notice: z.string().min(1).max(1000).nullable(),
}).superRefine((payment, context) => {
  const permitted: readonly string[] = {
    quoted: ['review'], needs_approval: ['approve','reject'], authorized: ['pay'], submitted: ['check'],
    confirmed: ['check'], delivered: [], rejected: [], failed: ['check'], unknown: ['check'],
  }[payment.state];
  if (payment.availableActions.some(action => !permitted.includes(action)) || new Set(payment.availableActions).size !== payment.availableActions.length)
    context.addIssue({ code: 'custom', message: 'Actions must match the recorded payment state.' });
  if (['submitted','confirmed','delivered'].includes(payment.state) && !payment.transactionSignature)
    context.addIssue({ code: 'custom', message: 'A submitted payment needs its recorded transaction reference.' });
});
export type DemoPaymentCard = z.infer<typeof DemoPaymentCardSchema>;
export type DemoPaymentAction = DemoPaymentCard['availableActions'][number];

export function demoExactAmount(amount: DemoPaymentCard['amount']) {
  const value = amountSchema.parse(amount), padded = value.units.padStart(value.decimals + 1, '0');
  const integer = value.decimals ? padded.slice(0, -value.decimals) : padded;
  const fraction = value.decimals ? padded.slice(-value.decimals).replace(/0+$/, '') : '';
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''} ${value.symbol}`;
}

export const demoPaymentLabels: Record<DemoPaymentCard['state'], string> = {
  quoted: 'Service quote ready', needs_approval: 'Your approval is needed', authorized: 'Payment permitted',
  submitted: 'Sent · awaiting confirmation', confirmed: 'Payment confirmed · awaiting service', delivered: 'Service delivered',
  rejected: 'Payment declined', failed: 'Payment needs checking', unknown: 'Payment outcome unknown',
};
export const demoPaymentActionLabels: Record<DemoPaymentAction,string> = {
  review: 'Review payment', approve: 'Approve this payment', reject: 'Decline', pay: 'Pay permitted amount', check: 'Check payment status',
};

/** UI exposure is subordinate to server permission; handlers must revalidate the exact payment. */
export function demoPaymentActions(payment: DemoPaymentCard, observing: boolean, pending: boolean, now: number) {
  if (!observing || pending || !Number.isFinite(now)) return [];
  // A quote expiring stops new authorization/spend, never recovery of an existing payment.
  return Date.parse(payment.validUntil) <= now ? payment.availableActions.filter(action => action === 'check') : payment.availableActions;
}
