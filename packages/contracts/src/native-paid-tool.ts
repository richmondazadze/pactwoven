import { z } from 'zod';
import { BaseUnitsSchema, IdSchema, InstantSchema } from './core';
import { FINANCE_DEVNET_ASSET, SolanaPublicKeySchema, SolanaSignatureSchema } from './finance-provenance';

const units = z.strictObject({ baseUnits: BaseUnitsSchema, decimals: z.literal(6), symbol: z.literal('devnet USDC') });
const fee = z.strictObject({ baseUnits: BaseUnitsSchema, decimals: z.literal(9), symbol: z.literal('test SOL') });
export const EquipmentOutputSchema = z.strictObject({
  service: z.literal('equipment_optimizer_v1'), provenance: z.literal('controlled_demo_catalogue'), currency: z.literal('USD'),
  status: z.enum(['feasible', 'no_feasible_package']), selectedOfferIds: z.array(z.string().regex(/^[a-z0-9_-]{1,64}$/)).max(12),
  totalMinor: z.number().int().min(0).max(12_000_000_000).nullable(),
  supplied: z.strictObject({ seats: z.number().int().min(0).max(6000), microphones: z.number().int().min(0).max(192),
    projectors: z.number().int().min(0).max(96) }).nullable(),
  evaluatedPackages: z.number().int().min(1).max(4095), requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  catalogueHash: z.string().regex(/^[0-9a-f]{64}$/),
}).superRefine((value, ctx) => {
  if (new Set(value.selectedOfferIds).size !== value.selectedOfferIds.length ||
    (value.status === 'feasible' ? !value.selectedOfferIds.length || value.totalMinor === null || value.supplied === null :
      value.selectedOfferIds.length > 0 || value.totalMinor !== null || value.supplied !== null))
    ctx.addIssue({ code: 'custom', message: 'The equipment result must match its recorded outcome.' });
});

/** Explicit public projection. Private message/wire bytes, provider bodies,
 * account observation IDs and internal authority records are never fields. */
export const NativePaidToolViewSchema = z.strictObject({
  scope: z.strictObject({ environment: z.literal('development'), organizationId: IdSchema, siteId: IdSchema }),
  rootTaskId: IdSchema, instructionRevision: z.number().int().min(0).max(16), operationId: IdSchema,
  version: z.number().int().min(1).max(33), asOf: InstantSchema,
  state: z.enum(['authorized','reserved','signing','signed','submitting','payment_pending','outcome_unknown','payment_confirmed','completed','cancelled']),
  resultApplicability: z.enum(['current','historical','unavailable']),
  title: z.literal('Equipment package optimizer'), statusText: z.string().min(1).max(160),
  purpose: z.literal('Compare equipment packages from the controlled demo catalogue.'),
  notice: z.string().min(1).max(500), network: z.literal('Solana devnet'), amount: units,
  asset: z.strictObject({ mint: z.literal(FINANCE_DEVNET_ASSET.mint), tokenProgram: z.literal(FINANCE_DEVNET_ASSET.tokenProgram),
    genesis: z.literal(FINANCE_DEVNET_ASSET.genesis) }),
  feeCeiling: fee, feePaid: fee.nullable(), approvedAt: InstantSchema, permissionExpiresAt: InstantSchema, revokedAt: InstantSchema.nullable(),
  allowance: z.strictObject({ limit: units, held: units, spent: units, unallocated: units }),
  recipient: z.strictObject({ label: z.literal('Pactwoven demo computation service'), tokenAccount: SolanaPublicKeySchema, owner: SolanaPublicKeySchema }),
  transaction: z.strictObject({ signature: SolanaSignatureSchema, state: z.enum(['signed','submitted','unknown','finalized']),
    finalizedAt: InstantSchema.nullable(), slot: BaseUnitsSchema.nullable() }).nullable(),
  delivery: z.strictObject({ receivedAt: InstantSchema, result: EquipmentOutputSchema }).nullable(),
  actions: z.array(z.enum(['check','cancel','revoke'])).max(3),
});
export type NativePaidToolView = z.infer<typeof NativePaidToolViewSchema>;
