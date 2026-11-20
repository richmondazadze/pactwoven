import { describe, expect, it } from 'vitest';
import { FINANCE_DEVNET_ASSET } from '../../../packages/contracts/src/finance-provenance.js';
import { paidToolChallengeHash } from './quote-binding.js';
import { createPaidToolOperation, planPaidToolOperation, type PaidToolContext, type PaidToolOperation, type PaidToolCommand } from './operation.js';

const now = '2026-11-19T16:00:00Z', expiry = '2026-11-19T16:05:00Z';
const hash = 'a'.repeat(64), blockhash = '11111111111111111111111111111111', signature = '1'.repeat(64);
const scope = { organizationId: 'org', siteId: 'site', rootTaskId: 'root', instructionRevision: 1 };
const context = (principal: PaidToolContext['principal'], extra: Partial<PaidToolContext> = {}): PaidToolContext =>
  ({ now, principal, scope, actorId: 'operator', permissionCurrent: true, rootActive: true, ...extra });
async function initial() {
  const ref = { id: 'ref', version: 1, hash };
  const challenge = { id: 'quote', providerId: 'equipment_optimizer_v1', resourceHash: hash, requestHash: hash,
    payee: { id: 'payee', version: 1, environment: 'development' as const, network: 'solana-devnet', recipient: blockhash,
      assetId: 'devnet_usdc', mint: FINANCE_DEVNET_ASSET.mint, tokenProgram: FINANCE_DEVNET_ASSET.tokenProgram, verificationRef: 'payee_proof' },
    amountBaseUnits: '10000', expiresAt: expiry };
  const quote = { providerId: challenge.providerId, resource: ref, request: ref,
    challenge: { ...challenge, hash: await paidToolChallengeHash(challenge) }, allowlistPolicy: ref, deliveryPolicy: ref };
  return createPaidToolOperation('operation', quote, { id: 'permission', scope, actorId: 'operator', identityEvidenceRef: 'identity_proof',
    quoteHash: quote.challenge.hash, maximumBaseUnits: '10000', maximumFeeLamports: '10000', approvedAt: now, expiresAt: expiry }, now);
}
const base = (state: PaidToolOperation, commandKey: string) => ({ operationId: state.id, expectedVersion: state.version, commandKey });
async function reserved() {
  const state = await initial();
  return (await planPaidToolOperation(state, { ...base(state, 'reserve'), kind: 'reserve', reservation: { id: 'reservation', amountBaseUnits: '10000', feeLamports: '5000', budgetVersion: 1 } }, context('policy'))).state;
}
async function signing() {
  const state = await reserved();
  return (await planPaidToolOperation(state, { ...base(state, 'prepare'), kind: 'prepare_sign', message: { messageHash: hash, blockhash, lastValidBlockHeight: '100', feeLamports: '5000' } }, context('signer'))).state;
}
async function signed() {
  const state = await signing();
  return (await planPaidToolOperation(state, { ...base(state, 'signed'), kind: 'retain_signed', attempt: { id: 'attempt', messageHash: hash,
    wireHash: hash, signature, blockhash, lastValidBlockHeight: '100' } }, context('signer'))).state;
}
async function submitted() {
  let state = await signed();
  state = (await planPaidToolOperation(state, { ...base(state, 'dispatch'), kind: 'prepare_broadcast' }, context('broadcaster'))).state;
  return (await planPaidToolOperation(state, { ...base(state, 'submitted'), kind: 'mark_submitted' }, context('broadcaster'))).state;
}
async function confirmed() {
  const state = await submitted();
  return (await planPaidToolOperation(state, { ...base(state, 'confirmed'), kind: 'confirm_payment', payment: {
    signature, slot: '100', finalizedAt: now, transferEvidenceRef: 'transfer_proof', recipient: blockhash, ...FINANCE_DEVNET_ASSET, amountBaseUnits: '10000',
  } }, context('chain_observer'))).state;
}
describe('paid-tool candidate lifecycle', () => {
  it('distinguishes prepared signature, submission, finality and delivery', async () => {
    expect((await signed()).status).toBe('signed');
    expect((await submitted()).payment).toBeNull();
    const state = await confirmed(); expect(state.status).toBe('payment_confirmed'); expect(state.delivery).toBeNull();
    const completed = await planPaidToolOperation(state, { ...base(state, 'delivery'), kind: 'accept_delivery', delivery: {
      artifactRef: 'artifact', resultHash: hash, requestHash: hash, resourceHash: hash, paymentSignature: signature, verifiedAt: now,
    } }, context('delivery_verifier'));
    expect(completed.state.status).toBe('completed'); expect(completed.state.attempt!.signature).toBe(signature);
    expect(completed.state.receipts).toHaveLength(7); expect(Object.isFrozen(completed.state.quote.challenge)).toBe(true);
  });
  it('retains unknown reservation and forbids new signing or cancellation', async () => {
    let state = await signing();
    state = (await planPaidToolOperation(state, { ...base(state, 'unknown'), kind: 'mark_unknown' }, context('signer'))).state;
    expect(state.reservation!.amountBaseUnits).toBe('10000');
    await expect(planPaidToolOperation(state, { ...base(state, 'cancel'), kind: 'cancel_before_signing' }, context('operator'))).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await expect(planPaidToolOperation(state, { ...base(state, 'again'), kind: 'prepare_sign', message: state.message! }, context('signer'))).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });
  it('allows exact duplicate recovery after expiry without repeating transition', async () => {
    const before = await signed(); const command: PaidToolCommand = { ...base(before, 'dispatch'), kind: 'prepare_broadcast' };
    const first = await planPaidToolOperation(before, command, context('broadcaster'));
    const recovered = await planPaidToolOperation(first.state, command, context('broadcaster', { now: expiry, permissionCurrent: false, rootActive: false }));
    expect(recovered.kind).toBe('replay'); expect(recovered.receipt).toEqual(first.receipt); expect(recovered.state.version).toBe(first.state.version);
    await expect(planPaidToolOperation(first.state, { ...command, kind: 'mark_unknown' }, context('broadcaster'))).rejects.toMatchObject({ code: 'KEY_CONFLICT' });
  });
  it('blocks new dispatch when root paused or permission expired/revoked', async () => {
    const state = await signed();
    for (const change of [{ rootActive: false }, { permissionCurrent: false }, { now: expiry }]) {
      await expect(planPaidToolOperation(state, { ...base(state, 'dispatch'), kind: 'prepare_broadcast' }, context('broadcaster', change))).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    }
  });
  it('retains late signatures after expiry without authorizing broadcast', async () => {
    const state = await signing();
    const late = await planPaidToolOperation(state, { ...base(state, 'signed'), kind: 'retain_signed', attempt: {
      id: 'attempt', messageHash: hash, wireHash: hash, signature, blockhash, lastValidBlockHeight: '100',
    } }, context('signer', { now: expiry, permissionCurrent: false }));
    expect(late.state.status).toBe('signed');
    await expect(planPaidToolOperation(late.state, { ...base(late.state, 'dispatch'), kind: 'prepare_broadcast' }, context('broadcaster', { now: expiry }))).rejects.toThrow();
  });
  it('reconciles payment after revocation but refuses wrong chain or amount', async () => {
    const state = await submitted();
    const payment = { signature, slot: '100', finalizedAt: now, transferEvidenceRef: 'transfer_proof', recipient: blockhash, ...FINANCE_DEVNET_ASSET, amountBaseUnits: '10000' };
    expect((await planPaidToolOperation(state, { ...base(state, 'final'), kind: 'confirm_payment', payment }, context('chain_observer', { permissionCurrent: false, rootActive: false, now: expiry }))).state.status).toBe('payment_confirmed');
    for (const change of [{ amountBaseUnits: '9999' }, { genesis: blockhash }, { recipient: FINANCE_DEVNET_ASSET.mint }]) {
      await expect(planPaidToolOperation(state, { ...base(state, 'bad'), kind: 'confirm_payment', payment: { ...payment, ...change } }, context('chain_observer'))).rejects.toThrow();
    }
  });
  it('rejects false delivery and wrong source principal', async () => {
    const state = await confirmed(); const delivery = { artifactRef: 'artifact', resultHash: hash, requestHash: hash, resourceHash: hash, paymentSignature: signature, verifiedAt: now };
    await expect(planPaidToolOperation(state, { ...base(state, 'delivery'), kind: 'accept_delivery', delivery: { ...delivery, requestHash: 'b'.repeat(64) } }, context('delivery_verifier'))).rejects.toThrow();
    await expect(planPaidToolOperation(state, { ...base(state, 'delivery'), kind: 'accept_delivery', delivery }, context('operator'))).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
  });
  it('rejects changed scope/revision/version and excess reservation', async () => {
    const state = await initial(); const command: PaidToolCommand = { ...base(state, 'reserve'), kind: 'reserve', reservation: { id: 'r', amountBaseUnits: '10001', feeLamports: '5000', budgetVersion: 1 } };
    await expect(planPaidToolOperation(state, command, context('policy'))).rejects.toThrow();
    await expect(planPaidToolOperation(state, { ...command, expectedVersion: 2 }, context('policy'))).rejects.toMatchObject({ code: 'VERSION_CHANGED' });
    await expect(planPaidToolOperation(state, command, context('policy', { scope: { ...scope, instructionRevision: 2 } }))).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
  });
});
