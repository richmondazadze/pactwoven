import { NativeWorkActivitySchema, type NativeWorkActivity } from '../../../../packages/contracts/src/native-work-activity';
import { DemoPaymentCardSchema } from './demo-workspace';

export function demoActivityFixture(): NativeWorkActivity {
  return NativeWorkActivitySchema.parse({ rootTaskId: '00000000-0000-4000-8000-000000000001',
    asOf: '2026-11-19T17:00:00.000Z', recordedAt: '2026-11-19T17:00:00.000Z', freshUntil: '2026-11-19T17:00:10.000Z', expiresAt: '2026-11-19T18:00:00.000Z',
    revision: { controlVersion: 1, checkpointVersion: 1, generation: 1, instructionRevision: 0 }, freshness: 'current', observation: 'snapshot',
    agents: [{ id: '00000000-0000-4000-8000-000000000002', role: 'coordinator', label: 'Coordinator' },
      { id: '00000000-0000-4000-8000-000000000003', role: 'research', label: 'Research specialist' }],
    actions: [{ id: '00000000-0000-4000-8000-000000000004', actorId: '00000000-0000-4000-8000-000000000002', kind: 'coordinate', target: 'plan', state: 'active', label: 'Review available sources', recordedAt: '2026-11-19T17:00:00.000Z' },
      { id: '00000000-0000-4000-8000-000000000005', actorId: '00000000-0000-4000-8000-000000000003', kind: 'review', target: 'team', state: 'active', label: 'Compare source details', recordedAt: null }], externalEffects: 'forbidden' });
}
export function demoPaymentFixture() {
  return DemoPaymentCardSchema.parse({ id:'private-payment-record', serviceName:'Test data service', purpose:'Retrieve the selected comparison dataset.',
    state:'needs_approval', amount:{units:'1250000',decimals:6,symbol:'TEST',assetLabel:'Test token · no cash value'}, remaining:null, networkFee:null,
    network:'Solana devnet', recipientLabel:'Selected test service', recordedAt:'2026-11-19T17:00:00.000Z',validUntil:'2026-11-19T17:05:00.000Z',
    transactionSignature:null,availableActions:['approve','reject'],notice:null });
}
