import { z } from 'zod';
import { IdSchema } from './core';
import { HashSchema } from './financial';

export const NativePaidEquipmentResponseSchema = z.strictObject({
  scope: z.strictObject({ environment: z.literal('development'), organizationId: IdSchema, siteId: IdSchema }),
  rootTaskId: IdSchema, operationId: IdSchema, instructionRevision: z.number().int().min(0).max(16),
  selection: z.strictObject({
    status: z.enum(['feasible', 'no_feasible_package']),
    currency: z.literal('USD'), provenance: z.literal('controlled_demo_catalogue'),
    catalogueHash: HashSchema, requestHash: HashSchema,
    budgetMinor: z.number().int().min(0).max(1_000_000_000),
    totalMinor: z.number().int().min(0).max(12_000_000_000).nullable(),
    items: z.array(z.strictObject({
      id: z.string().regex(/^[a-z0-9_-]{1,64}$/), label: z.string().min(1).max(120),
      seats: z.number().int().min(0).max(500), microphones: z.number().int().min(0).max(16),
      projectors: z.number().int().min(0).max(8), priceMinor: z.number().int().min(0).max(1_000_000_000),
    })).max(12),
  }).superRefine((value, ctx) => {
    if (new Set(value.items.map(item => item.id)).size !== value.items.length ||
      (value.status === 'feasible' ? value.items.length === 0 || value.totalMinor === null ||
        value.items.reduce((sum, item) => sum + item.priceMinor, 0) !== value.totalMinor || value.totalMinor > value.budgetMinor
        : value.items.length !== 0 || value.totalMinor !== null))
      ctx.addIssue({ code: 'custom', message: 'Selected equipment must match the computed outcome.' });
  }),
});
export type NativePaidEquipmentResponse = z.infer<typeof NativePaidEquipmentResponseSchema>;
