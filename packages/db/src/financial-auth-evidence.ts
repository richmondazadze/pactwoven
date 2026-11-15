import { z } from 'zod';
import { EnvironmentSchema, IdSchema, HashSchema, FinancialPolicyActorSchema, FinancialPolicyInstantSchema, FinancialPolicyUuidSchema,
  FinancialPolicyDecisionIntentSchema } from '@pactwoven/contracts';

const common = { schemaVersion: z.literal(1), id: FinancialPolicyUuidSchema, environment: EnvironmentSchema, organizationId: IdSchema,
  actor: FinancialPolicyActorSchema, observedAt: FinancialPolicyInstantSchema, expiresAt: FinancialPolicyInstantSchema,
  externalOrganizationId: IdSchema, externalRole: z.string().min(1).max(128), issuer: z.string().url().max(512), tokenHash: HashSchema,
  tokenIssuedAt: FinancialPolicyInstantSchema, sessionExpiresAt: FinancialPolicyInstantSchema };
export const FinancialIdentityEvidenceSchema = z.strictObject({ ...common, kind: z.literal('identity'), purpose: z.literal('financial_policy_observation') });
export const FinancialMfaEvidenceSchema = z.strictObject({ ...common, kind: z.literal('mfa'), purpose: z.literal('financial_policy_authorization'),
  intent: FinancialPolicyDecisionIntentSchema, intentHash: HashSchema, requestHash: HashSchema,
  firstFactorAgeMinutes: z.number().int().min(0).max(1_000_000), secondFactorAgeMinutes: z.number().int().min(0).max(1_000_000),
  verifiedAt: FinancialPolicyInstantSchema });
/** Private verified-provider input; neither schema parsing nor possession of this object proves identity. */
export const FinancialAuthEvidenceSchema = z.discriminatedUnion('kind', [FinancialIdentityEvidenceSchema, FinancialMfaEvidenceSchema]);
export type FinancialAuthEvidence = z.infer<typeof FinancialAuthEvidenceSchema>;
