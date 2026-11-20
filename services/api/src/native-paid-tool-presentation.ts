import { DomainError } from '@pactwoven/domain';
import type { Session } from '@pactwoven/contracts';
import { InstantSchema } from '../../../packages/contracts/src/core';
import { NativePaidToolViewSchema, EquipmentOutputSchema, type NativePaidToolView } from '../../../packages/contracts/src/native-paid-tool';
import { PaidToolSnapshotSchema } from '../../../packages/db/src/paid-tool-schema';
import { commandDigest } from '../../../packages/domain/src/canonical';

const unavailable = () => new DomainError('EVIDENCE_STALE', 409, 'Refresh this payment before taking the next step.');
const labels: Record<NativePaidToolView['state'], string> = {
  authorized: 'Payment approved', reserved: 'Allowance reserved', signing: 'Preparing the payment', signed: 'Payment prepared',
  submitting: 'Sending payment', payment_pending: 'Awaiting chain confirmation', outcome_unknown: 'Payment outcome needs checking',
  payment_confirmed: 'Payment confirmed · waiting for the service', completed: 'Computation delivered', cancelled: 'Payment cancelled',
};

/** Input must come from the authenticated human repository. This is a view,
 * never a spend permission or a substitute for private chain verification. */
export async function projectNativePaidTool(session: Session, rootTaskId: string, siteId: string, raw: unknown, now: string,
  context: { currentInstructionRevision: number; evidenceAvailable: boolean }): Promise<NativePaidToolView> {
  const time = Date.parse(InstantSchema.parse(now)), value = PaidToolSnapshotSchema.parse(raw), review = value.review;
  if (session.actor.environment !== 'development' || session.actor.principalKind !== 'human' ||
    review.organizationId !== session.actor.organizationId || review.rootTaskId !== rootTaskId || review.siteId !== siteId ||
    !session.actor.siteIds.includes(siteId) || !session.sites.some(site => site.id === siteId))
    throw new DomainError('FORBIDDEN', 403, 'Your current workspace access does not permit this payment.');
  if (!Number.isSafeInteger(context.currentInstructionRevision) || context.currentInstructionRevision < review.instructionRevision ||
    context.currentInstructionRevision > 16 || typeof context.evidenceAvailable !== 'boolean') throw unavailable();
  const resultApplicability = !context.evidenceAvailable ? 'unavailable' : context.currentInstructionRevision === review.instructionRevision ? 'current' : 'historical';
  const postPayment = ['payment_confirmed','completed'].includes(value.status);
  const hasAttempt = ['signed','submitting','payment_pending','payment_confirmed','completed'].includes(value.status);
  if (Boolean(value.payment) !== postPayment || Boolean(value.delivery) !== (value.status === 'completed') ||
    value.status === 'signing' && !value.message ||
    hasAttempt && !value.attempt || value.attempt && !value.message ||
    ['authorized','reserved','cancelled'].includes(value.status) && (value.message || value.attempt) ||
    Date.parse(value.approvedAt) > time || value.revokedAt && Date.parse(value.revokedAt) > time) throw unavailable();
  if (value.attempt && (value.attempt.messageHash !== value.message!.messageHash || value.attempt.blockhash !== value.message!.blockhash ||
    value.attempt.lastValidBlockHeight !== value.message!.lastValidBlockHeight)) throw unavailable();
  if (value.payment && (!value.attempt || value.payment.signature !== value.attempt.signature ||
    value.payment.messageHash !== value.attempt.messageHash || value.payment.amountBaseUnits !== review.amountBaseUnits ||
    value.payment.sourceAccount !== review.sourceAccount || value.payment.sourceOwner !== review.sourceOwner ||
    value.payment.destinationAccount !== review.destinationAccount || value.payment.destinationOwner !== review.destinationOwner ||
    value.payment.feeLamports !== value.message!.feeLamports || BigInt(value.payment.feeLamports) > BigInt(review.maximumFeeLamports) ||
    Date.parse(value.payment.observedAt) > time || Date.parse(value.payment.observedAt) < Date.parse(value.approvedAt))) throw unavailable();
  let delivery: NativePaidToolView['delivery'] = null;
  if (value.delivery) {
    const result = EquipmentOutputSchema.parse(value.delivery.resultBody);
    if (!value.payment || value.delivery.paymentSignature !== value.payment.signature || result.requestHash !== value.delivery.requestHash ||
      value.delivery.resultHash !== await commandDigest({ namespace: 'pactwoven.paid-tools.delivery.v1', result }) ||
      value.delivery.resourceHash !== await commandDigest({ namespace: 'pactwoven.paid-tools.resource.v1', service: 'equipment_optimizer_v1',
        computation: 'minimum_total_then_fewest_offers_then_sorted_ids', oneOfEachOffer: true, catalogueHash: result.catalogueHash }) ||
      Date.parse(value.delivery.verifiedAt) > time || Date.parse(value.delivery.verifiedAt) < Date.parse(value.payment.observedAt)) throw unavailable();
    if (context.evidenceAvailable) delivery = { receivedAt: value.delivery.verifiedAt, result };
  }
  const amount = (baseUnits: string) => ({ baseUnits, decimals: 6 as const, symbol: 'devnet USDC' as const });
  const fee = (baseUnits: string) => ({ baseUnits, decimals: 9 as const, symbol: 'test SOL' as const });
  const held = !postPayment && !['authorized','cancelled'].includes(value.status);
  const activePermission = !value.revokedAt && time < Date.parse(review.expiresAt);
  const actions: NativePaidToolView['actions'] = ['check'];
  if (session.actor.actionSiteIds.includes(siteId)) {
    if (['authorized','reserved'].includes(value.status)) actions.push('cancel');
    if (activePermission && !['cancelled','completed'].includes(value.status)) actions.push('revoke');
  }
  return NativePaidToolViewSchema.parse({
    scope: { environment: 'development', organizationId: review.organizationId, siteId }, rootTaskId,
    instructionRevision: review.instructionRevision, operationId: value.operationId, version: value.version, asOf: now,
    state: value.status, resultApplicability, title: 'Equipment package optimizer', statusText: labels[value.status],
    purpose: 'Compare equipment packages from the controlled demo catalogue.',
    notice: value.status === 'outcome_unknown' ? 'The allowance stays reserved while the original payment is checked. Do not send another payment.' :
      !activePermission && !['completed','payment_confirmed','cancelled'].includes(value.status) ?
      'Payment permission has ended. This record may reflect earlier progress. Check the original payment before taking another action.' :
      !context.evidenceAvailable ? 'The payment record is retained. The computation result is unavailable until its access and evidence can be checked.' :
      resultApplicability === 'historical' ? 'This purchase belongs to earlier task instructions. Its result has not been adopted into the current plan.' :
      value.status === 'payment_confirmed' ? 'The chain confirms payment. The computation has not been delivered yet.' :
      'Test tokens pay for this computation. Catalogue prices are sample USD estimates; no equipment is being ordered.',
    network: 'Solana devnet', asset: { mint: review.mint, tokenProgram: review.tokenProgram, genesis: review.genesis },
    amount: amount(review.amountBaseUnits), feeCeiling: fee(review.maximumFeeLamports),
    feePaid: value.payment ? fee(value.payment.feeLamports) : null, approvedAt: value.approvedAt,
    permissionExpiresAt: review.expiresAt, revokedAt: value.revokedAt,
    allowance: { limit: amount(review.amountBaseUnits), held: amount(held ? review.amountBaseUnits : '0'),
      spent: amount(postPayment ? review.amountBaseUnits : '0'), unallocated: amount(postPayment || held ? '0' : review.amountBaseUnits) },
    recipient: { label: 'Pactwoven demo computation service', tokenAccount: review.destinationAccount, owner: review.destinationOwner },
    transaction: value.attempt ? { signature: value.attempt.signature, state: value.payment ? 'finalized' :
      value.status === 'payment_pending' ? 'submitted' : value.status === 'outcome_unknown' || value.status === 'submitting' ? 'unknown' : 'signed',
      finalizedAt: value.payment?.observedAt ?? null, slot: value.payment?.slot ?? null } : null,
    delivery, actions,
  });
}
