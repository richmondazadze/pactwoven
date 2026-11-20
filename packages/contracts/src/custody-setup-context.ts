import { z } from 'zod';
import { IdSchema } from './core';
import { CustodyInstantSchema, CustodyOwnerSchema } from './custody-setup';

// A short-lived authenticated observation for local recovery display. It is
// neither setup consent nor a specification, signing or spending capability.
export const CustodyApiRecoveryContextSchema = z.strictObject({
  schemaVersion: z.literal(1), environment: z.literal('development'),
  organizationId: IdSchema, externalOrganizationId: IdSchema,
  responsibilityId: IdSchema, owner: CustodyOwnerSchema,
  observedAt: CustodyInstantSchema, expiresAt: CustodyInstantSchema,
}).refine(value => Date.parse(value.expiresAt) > Date.parse(value.observedAt)
  && Date.parse(value.expiresAt) - Date.parse(value.observedAt) <= 20_000,
  'Recovery context must have a positive lifetime of at most twenty seconds.');
export type CustodyApiRecoveryContext = z.infer<typeof CustodyApiRecoveryContextSchema>;
