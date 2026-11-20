import { NativePaidToolViewSchema, type NativePaidToolView } from '../../../../packages/contracts/src/native-paid-tool';

export type PaidToolAction = NativePaidToolView['actions'][number];
export type PaidToolActionRequest = { action: PaidToolAction; operationId: string; version: number };

/** Decimal string arithmetic avoids rounding token base units through Number. */
export function paidToolAmount(value: { baseUnits: string; decimals: number; symbol: string }): string {
  const digits = value.baseUnits.padStart(value.decimals + 1, '0');
  const whole = digits.slice(0, -value.decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits.slice(-value.decimals).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ${value.symbol}`;
}
export function paidToolReceipt(value: unknown): NativePaidToolView | null {
  const parsed = NativePaidToolViewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function paidToolReceiptKey(view: NativePaidToolView): string {
  return JSON.stringify([view.scope, view.rootTaskId, view.operationId, view.version, view.instructionRevision, view.state, view.permissionExpiresAt, view.revokedAt, view.resultApplicability, view.actions]);
}
export const paidToolActionLabels: Record<PaidToolAction, string> = {
  check: 'Check payment and delivery', cancel: 'Cancel this purchase', revoke: 'Revoke permission',
};
export function paidToolConfirmation(action: Exclude<PaidToolAction, 'check'>): string {
  return action === 'cancel'
    ? 'Cancel this purchase before signing. No equipment order is involved. The server will check that cancellation is still possible.'
    : 'Stop future actions under this permission. This does not reverse a signed or submitted payment, return funds, or remove its receipt.';
}
