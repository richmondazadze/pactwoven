import { BaseUnitsSchema, IdSchema, InstantSchema } from '../../../packages/contracts/src/core.js';
import { HashSchema, ToolPurchaseBindingSchema, type ToolPurchaseBinding } from '../../../packages/contracts/src/financial.js';
import { FINANCE_DEVNET_ASSET, SolanaPublicKeySchema, SolanaSignatureSchema } from '../../../packages/contracts/src/finance-provenance.js';
import { canonicalJson, commandDigest } from '../../../packages/domain/src/canonical.js';
import { paidToolChallengeHash } from './quote-binding.js';
import { EQUIPMENT_OPTIMIZER } from './equipment-optimizer.js';

export type PaidToolScope = { organizationId: string; siteId: string; rootTaskId: string; instructionRevision: number };
export type PaidToolPermission = { id: string; scope: PaidToolScope; actorId: string; identityEvidenceRef: string;
  quoteHash: string; maximumBaseUnits: string; maximumFeeLamports: string; approvedAt: string; expiresAt: string };
export type PaidToolReservation = { id: string; amountBaseUnits: string; feeLamports: string; budgetVersion: number };
export type PaidToolMessage = { messageHash: string; blockhash: string; lastValidBlockHeight: string; feeLamports: string };
export type PaidToolAttempt = { id: string; messageHash: string; wireHash: string; signature: string; blockhash: string; lastValidBlockHeight: string };
export type PaidToolPayment = { signature: string; slot: string; finalizedAt: string; transferEvidenceRef: string;
  recipient: string; mint: string; tokenProgram: string; amountBaseUnits: string; genesis: string };
export type PaidToolDelivery = { artifactRef: string; resultHash: string; requestHash: string; resourceHash: string;
  paymentSignature: string; verifiedAt: string };
export type PaidToolStatus = 'authorized' | 'reserved' | 'signing' | 'signed' | 'submitting' | 'payment_pending' | 'outcome_unknown' | 'payment_confirmed' | 'completed' | 'cancelled';
export type PaidToolReceipt = { commandKey: string; commandHash: string; previousVersion: number; version: number; recordedAt: string; status: PaidToolStatus };
export type PaidToolOperation = { id: string; scope: PaidToolScope; quote: ToolPurchaseBinding; permission: PaidToolPermission;
  version: number; status: PaidToolStatus; createdAt: string; reservation: PaidToolReservation | null; message: PaidToolMessage | null;
  attempt: PaidToolAttempt | null; payment: PaidToolPayment | null; delivery: PaidToolDelivery | null; receipts: PaidToolReceipt[] };
export type PaidToolCommand = { operationId: string; commandKey: string; expectedVersion: number } & (
  { kind: 'reserve'; reservation: PaidToolReservation } | { kind: 'prepare_sign'; message: PaidToolMessage } |
  { kind: 'retain_signed'; attempt: PaidToolAttempt } | { kind: 'prepare_broadcast' } | { kind: 'mark_submitted' } | { kind: 'mark_unknown' } |
  { kind: 'confirm_payment'; payment: PaidToolPayment } | { kind: 'accept_delivery'; delivery: PaidToolDelivery } |
  { kind: 'cancel_before_signing' });

/** Context is resolved by PRIVATE authenticated adapters/locked DB state.
 * It must never be accepted from a browser, agent, provider body or public API.
 * This pure oracle neither establishes those facts nor grants signing access. */
export type PaidToolContext = { now: string; principal: 'policy' | 'signer' | 'broadcaster' | 'chain_observer' | 'delivery_verifier' | 'operator';
  scope: PaidToolScope; actorId: string; permissionCurrent: boolean; rootActive: boolean };
export class PaidToolOperationError extends Error {
  constructor(readonly code: 'INVALID' | 'SCOPE_CHANGED' | 'AUTHORITY_UNAVAILABLE' | 'VERSION_CHANGED' | 'KEY_CONFLICT' | 'STATE_CONFLICT') {
    super(`Paid-tool operation rejected: ${code}`); this.name = 'PaidToolOperationError';
  }
}
const assert = (value: unknown, code: PaidToolOperationError['code'] = 'INVALID'): void => { if (!value) throw new PaidToolOperationError(code); };
const time = (value: string) => Date.parse(InstantSchema.parse(value));
const amount = (value: string) => BigInt(BaseUnitsSchema.parse(value));
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function scope(input: PaidToolScope): PaidToolScope {
  assert(input && typeof input === 'object' && Object.keys(input).sort().join(',') === 'instructionRevision,organizationId,rootTaskId,siteId');
  IdSchema.parse(input.organizationId); IdSchema.parse(input.siteId); IdSchema.parse(input.rootTaskId);
  assert(Number.isSafeInteger(input.instructionRevision) && input.instructionRevision >= 0);
  return structuredClone(input);
}
function message(input: PaidToolMessage): PaidToolMessage {
  assert(Object.keys(input).sort().join(',') === 'blockhash,feeLamports,lastValidBlockHeight,messageHash');
  HashSchema.parse(input.messageHash); SolanaPublicKeySchema.parse(input.blockhash); amount(input.lastValidBlockHeight); amount(input.feeLamports);
  return structuredClone(input);
}
function attempt(input: PaidToolAttempt): PaidToolAttempt {
  assert(Object.keys(input).sort().join(',') === 'blockhash,id,lastValidBlockHeight,messageHash,signature,wireHash');
  IdSchema.parse(input.id); HashSchema.parse(input.messageHash); HashSchema.parse(input.wireHash); SolanaSignatureSchema.parse(input.signature);
  SolanaPublicKeySchema.parse(input.blockhash); amount(input.lastValidBlockHeight);
  return structuredClone(input);
}
function freeze<T>(input: T): T {
  if (input && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); }
  return input;
}

/** Separate paid-tool permission only. Original advisory task grant is never
 * changed. This constructs candidate state; authenticated admission + atomic
 * shared budget reservation are required before the service can sign. */
export async function createPaidToolOperation(id: string, quoteInput: ToolPurchaseBinding, permissionInput: PaidToolPermission, nowInput: string): Promise<PaidToolOperation> {
  IdSchema.parse(id); const quote = ToolPurchaseBindingSchema.parse(quoteInput), permission = structuredClone(permissionInput), now = time(nowInput);
  assert(Object.keys(permission).sort().join(',') === 'actorId,approvedAt,expiresAt,id,identityEvidenceRef,maximumBaseUnits,maximumFeeLamports,quoteHash,scope');
  scope(permission.scope); IdSchema.parse(permission.id); IdSchema.parse(permission.actorId); IdSchema.parse(permission.identityEvidenceRef);
  HashSchema.parse(permission.quoteHash); const { hash, ...challenge } = quote.challenge;
  assert(quote.providerId === EQUIPMENT_OPTIMIZER && quote.providerId === challenge.providerId && quote.resource.hash === challenge.resourceHash &&
    quote.request.hash === challenge.requestHash && hash === await paidToolChallengeHash(challenge) && permission.quoteHash === hash);
  assert(challenge.payee.environment === 'development' && challenge.payee.network === 'solana-devnet' &&
    challenge.payee.mint === FINANCE_DEVNET_ASSET.mint && challenge.payee.tokenProgram === FINANCE_DEVNET_ASSET.tokenProgram);
  SolanaPublicKeySchema.parse(challenge.payee.recipient);
  assert(amount(challenge.amountBaseUnits) > 0n && amount(challenge.amountBaseUnits) <= amount(permission.maximumBaseUnits) && amount(permission.maximumFeeLamports) > 0n);
  assert(time(permission.approvedAt) <= now && time(permission.expiresAt) > now && time(permission.approvedAt) < time(permission.expiresAt) &&
    time(permission.expiresAt) <= time(challenge.expiresAt));
  return freeze({ id, scope: scope(permission.scope), quote, permission, version: 1, status: 'authorized', createdAt: nowInput,
    reservation: null, message: null, attempt: null, payment: null, delivery: null, receipts: [] });
}

/** Candidate transitions only. A DB adapter must validate/reconstruct retained
 * state, lock permission/root/shared asset budget, verify source evidence,
 * commit receipt and CAS atomically, then expose the result. Never sign/send
 * directly from this returned object. One signing attempt is allowed; unknown
 * outcomes retain the reservation and have NO automatic retry/release route. */
export async function planPaidToolOperation(original: PaidToolOperation, input: PaidToolCommand, contextInput: PaidToolContext) {
  const state = structuredClone(original), command = structuredClone(input), context = structuredClone(contextInput);
  const fields: Record<PaidToolCommand['kind'], string | null> = { reserve: 'reservation', prepare_sign: 'message', retain_signed: 'attempt',
    prepare_broadcast: null, mark_submitted: null, mark_unknown: null, confirm_payment: 'payment', accept_delivery: 'delivery', cancel_before_signing: null };
  assert(Object.hasOwn(fields, command.kind));
  assert(Object.keys(command).sort().join(',') === ['operationId', 'commandKey', 'expectedVersion', 'kind', ...(fields[command.kind] ? [fields[command.kind]!] : [])].sort().join(','));
  IdSchema.parse(command.operationId); IdSchema.parse(command.commandKey); assert(command.operationId === state.id, 'SCOPE_CHANGED');
  assert(equal(scope(context.scope), state.scope), 'SCOPE_CHANGED');
  assert(context.actorId === state.permission.actorId, 'AUTHORITY_UNAVAILABLE');
  const now = time(context.now), commandHash = await commandDigest({ namespace: 'pactwoven.paid-tool-command.v1', command });
  const prior = state.receipts.find(receipt => receipt.commandKey === command.commandKey);
  if (prior) { assert(prior.commandHash === commandHash, 'KEY_CONFLICT'); return freeze({ kind: 'replay' as const, state, receipt: prior }); }
  assert(Number.isSafeInteger(command.expectedVersion) && command.expectedVersion === state.version, 'VERSION_CHANGED');
  assert(state.version === state.receipts.length + 1 && state.receipts.length < 32 && now >= time(state.receipts.at(-1)?.recordedAt ?? state.createdAt));
  const requirePrincipal = (...principals: PaidToolContext['principal'][]) => assert(principals.includes(context.principal), 'AUTHORITY_UNAVAILABLE');
  const fresh = () => assert(context.permissionCurrent && context.rootActive && now < time(state.permission.expiresAt) && now < time(state.quote.challenge.expiresAt), 'AUTHORITY_UNAVAILABLE');
  switch (command.kind) {
    case 'reserve': {
      requirePrincipal('policy'); fresh(); assert(state.status === 'authorized' && state.reservation === null, 'STATE_CONFLICT');
      const reservation = command.reservation;
      assert(Object.keys(reservation).sort().join(',') === 'amountBaseUnits,budgetVersion,feeLamports,id'); IdSchema.parse(reservation.id);
      assert(reservation.amountBaseUnits === state.quote.challenge.amountBaseUnits && amount(reservation.feeLamports) > 0n &&
        amount(reservation.feeLamports) <= amount(state.permission.maximumFeeLamports) && Number.isSafeInteger(reservation.budgetVersion) && reservation.budgetVersion > 0);
      state.reservation = structuredClone(reservation); state.status = 'reserved'; break;
    }
    case 'prepare_sign': {
      requirePrincipal('signer'); fresh(); assert(state.status === 'reserved' && state.message === null && state.attempt === null, 'STATE_CONFLICT');
      const prepared = message(command.message);
      assert(amount(prepared.feeLamports) <= amount(state.reservation!.feeLamports));
      state.message = prepared; state.status = 'signing'; break;
    }
    case 'retain_signed': {
      requirePrincipal('signer'); assert((state.status === 'signing' || state.status === 'outcome_unknown') && state.message && state.attempt === null, 'STATE_CONFLICT');
      const signed = attempt(command.attempt);
      assert(signed.messageHash === state.message!.messageHash && signed.blockhash === state.message!.blockhash && signed.lastValidBlockHeight === state.message!.lastValidBlockHeight);
      // Late signer responses must be retained even after expiry/revocation.
      state.attempt = signed; state.status = 'signed'; break;
    }
    case 'prepare_broadcast':
      requirePrincipal('broadcaster'); fresh(); assert(state.status === 'signed' && state.attempt, 'STATE_CONFLICT');
      state.status = 'submitting'; break;
    case 'mark_submitted':
      requirePrincipal('broadcaster'); assert(['submitting', 'outcome_unknown'].includes(state.status) && state.attempt, 'STATE_CONFLICT');
      state.status = 'payment_pending'; break;
    case 'mark_unknown':
      requirePrincipal('signer', 'broadcaster', 'chain_observer'); assert(['signing', 'submitting', 'payment_pending', 'outcome_unknown'].includes(state.status), 'STATE_CONFLICT');
      state.status = 'outcome_unknown'; break;
    case 'confirm_payment': {
      requirePrincipal('chain_observer'); assert(['payment_pending', 'outcome_unknown'].includes(state.status) && state.attempt && state.payment === null, 'STATE_CONFLICT');
      const payment = command.payment;
      assert(Object.keys(payment).sort().join(',') === 'amountBaseUnits,finalizedAt,genesis,mint,recipient,signature,slot,tokenProgram,transferEvidenceRef');
      SolanaSignatureSchema.parse(payment.signature); IdSchema.parse(payment.transferEvidenceRef); amount(payment.slot);
      assert(payment.signature === state.attempt!.signature && payment.recipient === state.quote.challenge.payee.recipient &&
        payment.mint === FINANCE_DEVNET_ASSET.mint && payment.tokenProgram === FINANCE_DEVNET_ASSET.tokenProgram &&
        payment.genesis === FINANCE_DEVNET_ASSET.genesis && payment.amountBaseUnits === state.quote.challenge.amountBaseUnits &&
        time(payment.finalizedAt) <= now && time(payment.finalizedAt) >= time(state.createdAt));
      // Reconciliation survives revoked permission; it cannot authorize sends.
      state.payment = structuredClone(payment); state.status = 'payment_confirmed'; break;
    }
    case 'accept_delivery': {
      requirePrincipal('delivery_verifier'); assert(state.status === 'payment_confirmed' && state.payment && state.delivery === null, 'STATE_CONFLICT');
      const delivery = command.delivery;
      assert(Object.keys(delivery).sort().join(',') === 'artifactRef,paymentSignature,requestHash,resourceHash,resultHash,verifiedAt');
      IdSchema.parse(delivery.artifactRef); HashSchema.parse(delivery.resultHash);
      assert(delivery.requestHash === state.quote.request.hash && delivery.resourceHash === state.quote.resource.hash &&
        delivery.paymentSignature === state.payment!.signature && time(delivery.verifiedAt) >= time(state.payment!.finalizedAt) && time(delivery.verifiedAt) <= now);
      state.delivery = structuredClone(delivery); state.status = 'completed'; break;
    }
    case 'cancel_before_signing':
      requirePrincipal('operator'); assert(['authorized', 'reserved'].includes(state.status) && state.message === null && state.attempt === null, 'STATE_CONFLICT');
      // Adapter atomically releases a reservation only for this pre-sign case.
      state.status = 'cancelled'; break;
    default: throw new PaidToolOperationError('INVALID');
  }
  const receipt = { commandKey: command.commandKey, commandHash, previousVersion: state.version, version: state.version + 1, recordedAt: context.now, status: state.status };
  state.version++; state.receipts.push(receipt);
  return freeze({ kind: 'transition' as const, state, receipt });
}

export interface PaidToolRepository {
  /** Original selector only. Command, current scope/identity, quotes, budget,
   * verifier evidence and context come from private locked persisted records. */
  apply(selection: { scope: PaidToolScope; operationId: string; commandKey: string; commandHash: string }): Promise<{ state: PaidToolOperation; receipt: PaidToolReceipt }>;
  recover(selection: { scope: PaidToolScope; operationId: string; commandKey: string; commandHash: string }): Promise<{ state: PaidToolOperation; receipt: PaidToolReceipt } | null>;
}
export interface PaidToolPrivatePorts {
  /** Signer must recheck permission/budget/fence, independently decode exact
   * SPL transferChecked bytes, retain signed bytes before returning. */
  signer: { signStoredPermit(permitId: string): Promise<{ attemptId: string }> };
  /** Broadcast uses only already-retained original bytes, with its own current
   * dispatch fence. A returned signature is NOT payment confirmation. */
  broadcaster: { submitStoredAttempt(attemptId: string): Promise<{ disposition: 'submitted' | 'unknown' }> };
  chainObserver: { reconcileStoredAttempt(attemptId: string): Promise<{ disposition: 'finalized' | 'unknown'; evidenceRef: string }> };
  /** Provider gate independently verifies payment, unique redemption and exact
   * request/resource; delivery result is persisted/recovered by original key. */
  provider: { redeemStoredPurchase(operationId: string): Promise<{ artifactRef: string }> };
}
