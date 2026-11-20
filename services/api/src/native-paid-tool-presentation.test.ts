import { describe, expect, it } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import type { PaidToolSnapshot } from '../../../packages/db/src/paid-tool-schema';
import { FINANCE_DEVNET_ASSET, encodeSolanaBase58 } from '../../../packages/contracts/src/finance-provenance';
import { commandDigest } from '../../../packages/domain/src/canonical';
import { projectNativePaidTool } from './native-paid-tool-presentation';

const at = '2026-11-19T16:00:00Z', later = '2026-11-19T16:01:00Z';
const hash = '1'.repeat(64), address = (n: number) => encodeSolanaBase58(new Uint8Array(32).fill(n));
const signature = encodeSolanaBase58(new Uint8Array(64).fill(7));
const session: Session = { actor: { actorId: 'operator', principalKind: 'human', organizationId: 'org', environment: 'development',
  roles: ['owner'], siteIds: ['site'], actionSiteIds: ['site'], sessionId: 'session', authenticatedAt: at, correlationId: 'correlation' },
  organization: { id: 'org', name: 'Company', authorityEpoch: 1 }, sites: [{ id: 'site', name: 'Office', timeZone: 'America/Chicago' }] };
function fixture(status: PaidToolSnapshot['status'] = 'authorized'): PaidToolSnapshot {
  const value: PaidToolSnapshot = { operationId: 'purchase', version: 1, status, approvedAt: at, revokedAt: null,
    review: { id: 'review', organizationId: 'org', siteId: 'site', rootTaskId: 'root', instructionRevision: 0,
      quoteId: 'quote', quoteHash: hash, providerId: 'equipment_optimizer_v1', amountBaseUnits: '10000', maximumFeeLamports: '15000',
      sourceAccount: address(1), sourceOwner: address(2), feePayer: address(2), destinationAccount: address(3), destinationOwner: address(4),
      ...FINANCE_DEVNET_ASSET, expiresAt: '2026-11-19T16:05:00Z', reviewHash: hash }, message: null, attempt: null, payment: null, delivery: null };
  if (!['authorized','reserved','cancelled'].includes(status)) value.message = { messageHash: hash, messageBase64: 'private-message-bytes',
    currentBlockHeight: '200', heightObservedAt: at, heightEvidenceRef: 'private-height-evidence', heightEvidenceHash: hash,
    blockhash: address(5), lastValidBlockHeight: '300', feeLamports: '5000', sourceObservationId: 'private-source-observation', feeObservationId: 'private-fee-observation' };
  if (['signed','submitting','payment_pending','outcome_unknown','payment_confirmed','completed'].includes(status)) value.attempt = {
    id: 'private-attempt', messageHash: hash, wireHash: hash, signature, blockhash: address(5), lastValidBlockHeight: '300' };
  if (['payment_confirmed','completed'].includes(status)) value.payment = { status: 'finalized_transfer', signature, slot: '123', observedAt: later,
    ...FINANCE_DEVNET_ASSET, sourceAccount: address(1), sourceOwner: address(2), destinationAccount: address(3), destinationOwner: address(4),
    amountBaseUnits: '10000', feeLamports: '5000', messageHash: hash, transactionEvidenceRef: 'private-tx-evidence', transactionEvidenceHash: hash,
    statusEvidenceRef: 'private-status-evidence', statusEvidenceHash: hash };
  return value;
}
const project = (value: PaidToolSnapshot, context = { currentInstructionRevision: 0, evidenceAvailable: true }, now = later) =>
  projectNativePaidTool(session, 'root', 'site', value, now, context);
async function delivered() {
  const value = fixture('completed'), resultBody = { service: 'equipment_optimizer_v1', provenance: 'controlled_demo_catalogue', currency: 'USD',
    status: 'feasible', selectedOfferIds: ['workshop'], totalMinor: 50000, supplied: { seats: 20, microphones: 1, projectors: 1 },
    evaluatedPackages: 7, requestHash: hash, catalogueHash: hash };
  value.delivery = { artifactRef: 'private-artifact', resultHash: await commandDigest({ namespace: 'pactwoven.paid-tools.delivery.v1', result: resultBody }),
    requestHash: hash, resourceHash: await commandDigest({ namespace: 'pactwoven.paid-tools.resource.v1', service: 'equipment_optimizer_v1',
      computation: 'minimum_total_then_fewest_offers_then_sorted_ids', oneOfEachOffer: true, catalogueHash: resultBody.catalogueHash }),
    paymentSignature: signature, verifiedAt: later, resultBody };
  return value;
}
describe('public paid-tool view', () => {
  it('keeps approved allowance distinct from confirmed spend', async () => {
    const value = await project(fixture());
    expect(value.statusText).toBe('Payment approved'); expect(value.transaction).toBeNull();
    expect(value.allowance.unallocated.baseUnits).toBe('10000'); expect(value.allowance.spent.baseUnits).toBe('0');
    expect(value.actions).toEqual(['check','cancel','revoke']);
  });
  it.each(['reserved','signing','signed','submitting','payment_pending','outcome_unknown'] as const)('retains exposure for %s', async state => {
    const value = await project(fixture(state));
    expect(value.allowance.held.baseUnits).toBe('10000'); expect(value.allowance.unallocated.baseUnits).toBe('0');
    expect(value.allowance.spent.baseUnits).toBe('0'); expect(value.delivery).toBeNull(); expect(value.feePaid).toBeNull();
  });
  it('offers reconciliation after expiry and revocation without resubmission', async () => {
    const input = fixture('outcome_unknown'); input.revokedAt = later;
    const value = await project(input, undefined, '2026-11-19T18:00:00Z');
    expect(value.actions).toEqual(['check']); expect(value.transaction?.state).toBe('unknown');
    expect(value.notice).toContain('Do not send another payment');
  });
  it('separates finality from actual service delivery and redacts private records', async () => {
    const value = await project(fixture('payment_confirmed'));
    expect(value.transaction?.state).toBe('finalized'); expect(value.delivery).toBeNull();
    expect(value.statusText).toContain('waiting for the service'); expect(value.allowance.spent.baseUnits).toBe('10000');
    expect(value.feePaid?.baseUnits).toBe('5000'); expect(JSON.stringify(value)).not.toContain('private-');
    expect(JSON.stringify(value)).not.toContain('messageBase64');
  });
  it('returns structured output with explicit catalogue and purchase labels', async () => {
    const value = await project(await delivered());
    expect(value.delivery?.result.totalMinor).toBe(50000); expect(value.delivery?.result.provenance).toBe('controlled_demo_catalogue');
    expect(value.amount.baseUnits).toBe('10000'); expect(value.notice).toContain('no equipment is being ordered');
  });
  it('marks earlier-revision output and withholds evidence-unavailable result bodies', async () => {
    const input = await delivered();
    const history = await project(input, { currentInstructionRevision: 1, evidenceAvailable: true });
    expect(history.resultApplicability).toBe('historical'); expect(history.notice).toContain('earlier task instructions');
    const withheld = await project(input, { currentInstructionRevision: 1, evidenceAvailable: false });
    expect(withheld.resultApplicability).toBe('unavailable'); expect(withheld.delivery).toBeNull();
    expect(withheld.transaction?.state).toBe('finalized'); expect(withheld.notice).not.toContain('not been delivered');
  });
  it.each(['recipient','signature','amount','fee','missing_finality'] as const)('refuses inconsistent %s payment records', async kind => {
    const value = fixture('payment_confirmed');
    if (kind === 'recipient') value.payment!.destinationAccount = address(8);
    if (kind === 'signature') value.payment!.signature = encodeSolanaBase58(new Uint8Array(64).fill(9));
    if (kind === 'amount') value.payment!.amountBaseUnits = '10001';
    if (kind === 'fee') value.payment!.feeLamports = '15001';
    if (kind === 'missing_finality') value.payment = null;
    await expect(project(value)).rejects.toMatchObject({ code: 'EVIDENCE_STALE' });
  });
  it('refuses changed delivery output instead of silently rendering it', async () => {
    const value = await delivered(); value.delivery!.resultBody.totalMinor = 1;
    await expect(project(value)).rejects.toMatchObject({ code: 'EVIDENCE_STALE' });
  });
  it.each(['organization','site','root','principal'] as const)('rejects foreign %s access', async kind => {
    const value = fixture(), actor = structuredClone(session);
    if (kind === 'organization') value.review.organizationId = 'foreign';
    if (kind === 'site') value.review.siteId = 'foreign';
    if (kind === 'root') value.review.rootTaskId = 'foreign';
    if (kind === 'principal') actor.actor.principalKind = 'service';
    await expect(projectNativePaidTool(actor, 'root', 'site', value, later, { currentInstructionRevision: 0, evidenceAvailable: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
