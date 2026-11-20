import { NativePaidToolViewSchema } from '../../../../packages/contracts/src/native-paid-tool';
import { FINANCE_DEVNET_ASSET, encodeSolanaBase58 } from '../../../../packages/contracts/src/finance-provenance';

export function paidToolFixture() {
  const amount = (baseUnits: string) => ({ baseUnits, decimals: 6 as const, symbol: 'devnet USDC' as const });
  return NativePaidToolViewSchema.parse({
    scope: { environment: 'development', organizationId: 'hidden-org', siteId: 'hidden-site' },
    rootTaskId: 'hidden-task', operationId: 'hidden-operation', instructionRevision: 0, version: 1,
    asOf: '2026-11-19T16:00:00Z', state: 'completed', resultApplicability: 'current',
    title: 'Equipment package optimizer', statusText: 'Payment confirmed and result delivered',
    purpose: 'Compare equipment packages from the controlled demo catalogue.',
    notice: 'This pays for a computation; no equipment is being ordered.', network: 'Solana devnet',
    amount: amount('10000'), asset: FINANCE_DEVNET_ASSET,
    feeCeiling: { baseUnits: '15000', decimals: 9, symbol: 'test SOL' }, feePaid: null,
    approvedAt: '2026-11-19T15:59:00Z', permissionExpiresAt: '2026-11-19T16:05:00Z', revokedAt: null,
    allowance: { limit: amount('10000'), held: amount('0'), spent: amount('10000'), unallocated: amount('0') },
    recipient: { label: 'Pactwoven demo computation service', tokenAccount: encodeSolanaBase58(new Uint8Array(32).fill(3)), owner: encodeSolanaBase58(new Uint8Array(32).fill(4)) },
    transaction: { signature: encodeSolanaBase58(new Uint8Array(64).fill(7)), state: 'finalized', finalizedAt: '2026-11-19T16:00:00Z', slot: '123' },
    delivery: { receivedAt: '2026-11-19T16:00:00Z', result: { service: 'equipment_optimizer_v1', provenance: 'controlled_demo_catalogue', currency: 'USD', status: 'feasible', selectedOfferIds: ['hidden-offer'], totalMinor: 50000, supplied: { seats: 20, microphones: 1, projectors: 1 }, evaluatedPackages: 7, requestHash: 'a'.repeat(64), catalogueHash: 'b'.repeat(64) } },
    actions: ['check'],
  });
}
