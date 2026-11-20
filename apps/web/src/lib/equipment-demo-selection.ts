import { z } from 'zod';
import { BaseUnitsSchema } from '../../../../packages/contracts/src/core';

/** UI-only planning selection. An exact purchase review remains a separate action. */
export const EquipmentDemoCeilingSchema = z.strictObject({
  maximumComputationBaseUnits: BaseUnitsSchema.refine(value => BigInt(value) > 0n),
  maximumFeeLamports: BaseUnitsSchema.refine(value => BigInt(value) > 0n),
  authorization: z.literal('separate_quote_required'),
});
export type EquipmentDemoCeiling = z.infer<typeof EquipmentDemoCeilingSchema>;
export function sameEquipmentDemoCeiling(a: EquipmentDemoCeiling | null, b: EquipmentDemoCeiling) {
  return a !== null && EquipmentDemoCeilingSchema.safeParse(a).success && a.authorization === b.authorization &&
    a.maximumComputationBaseUnits === b.maximumComputationBaseUnits && a.maximumFeeLamports === b.maximumFeeLamports;
}
