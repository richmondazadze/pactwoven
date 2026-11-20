import { z } from 'zod';
import { EnvironmentSchema, IdSchema, RoleSchema, HashSchema, IdempotencyKeySchema, FinancialPolicyActorSchema,
  FinancialPolicyInstantSchema, FinancialPolicyGenerationSchema, FinancialPolicyRefSchema, FinancialPolicyDocumentRefSchema,
  FinancialPolicyReadSchema, FinancialDraftScopeSchema, RegistryPinSchema, FinancialGovernanceControlRefSchema,
  FinancialBudgetPeriodSchema, FinancialPolicyBlockerSchema, FinancialPolicyCommandSchema, FinancialPolicyResultSchema } from '@pactwoven/contracts';
import { MandateIdentitySchema } from './mandate-schema.js';

/** Private authenticator output. Parsing this shape does not authenticate its source. */
export const FinancialPolicyReadObservationSchema = z.strictObject({
  identity: MandateIdentitySchema.extend({ membershipObservedAt: FinancialPolicyInstantSchema, authenticatedAt: FinancialPolicyInstantSchema }),
  observation: z.strictObject({ issuer: z.string().url().max(512), tokenHash: HashSchema, tokenIssuedAt: FinancialPolicyInstantSchema,
    observedAt: FinancialPolicyInstantSchema, expiresAt: FinancialPolicyInstantSchema }),
});
const ids = z.array(IdSchema).max(100).refine(v => v.every((x, i) => i === 0 || v[i - 1]! < x));
export const FinancialPolicyReaderScopeSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema,
  externalOrganizationId: IdSchema, actor: FinancialPolicyActorSchema, organizationEpoch: FinancialPolicyGenerationSchema,
  roles: z.array(RoleSchema).min(1).max(9), siteIds: ids, actionSiteIds: ids });
export const FinancialPolicyContextQuerySchema = z.strictObject({ responsibilityId: IdSchema.nullable(), assetKey: HashSchema.nullable(),
  documents: z.array(FinancialPolicyDocumentRefSchema).max(8).refine(v => v.every((x, i) => i === 0 || v[i - 1]!.id < x.id)) });
export const FinancialPolicyAssetContextSchema = z.strictObject({ pin: RegistryPinSchema, genesisHex: HashSchema,
  tokenProgramHex: HashSchema, mintHex: HashSchema, decimals: z.number().int().min(0).max(18), policy: IdSchema });
export const FinancialPolicyContextSchema = z.strictObject({ scope: FinancialPolicyReaderScopeSchema,
  responsibilityId: IdSchema.nullable(), configurationVisibility: z.enum(['full', 'references_only']), draftScope: FinancialDraftScopeSchema.nullable(), asset: FinancialPolicyAssetContextSchema.nullable(),
  control: FinancialGovernanceControlRefSchema.nullable(), acceptedConfiguration: FinancialPolicyReadSchema.nullable(),
  periods: z.array(FinancialBudgetPeriodSchema).max(50), documents: z.array(FinancialPolicyReadSchema).max(8),
  blockers: z.array(FinancialPolicyBlockerSchema).max(16), observedAt: FinancialPolicyInstantSchema, expiresAt: FinancialPolicyInstantSchema,
  effectiveAuthority: z.literal(false), financialState: z.null() });
export const FinancialGovernanceIndexQuerySchema = z.strictObject({ afterId: IdSchema.nullable(), limit: z.number().int().min(1).max(50) });
export const FinancialGovernanceIndexItemSchema = z.strictObject({ policy: FinancialPolicyReadSchema, control: FinancialGovernanceControlRefSchema,
  currentBudgetConfiguration: z.boolean() });
export const FinancialGovernanceIndexSchema = z.strictObject({ items: z.array(FinancialGovernanceIndexItemSchema).max(50), nextId: IdSchema.nullable() });
export const FinancialPolicyOriginalQuerySchema = z.strictObject({ responsibilityId: IdSchema.nullable(), kind: FinancialPolicyResultSchema.shape.kind,
  key: IdempotencyKeySchema, targetId: IdSchema }).refine(q => q.kind === 'save_document' ||
    (q.responsibilityId !== null) === (q.kind === 'save_draft' || q.kind === 'withdraw_draft'));
/** Stored command and result remain private, including original evidence IDs. */
export const FinancialPolicyOriginalSchema = z.strictObject({ command: FinancialPolicyCommandSchema, result: FinancialPolicyResultSchema });
export const FinancialPolicyProposerObservationSchema = z.strictObject({ proposal: FinancialPolicyRefSchema,
  control: FinancialGovernanceControlRefSchema, observation: FinancialPolicyRefSchema,
  observedAt: FinancialPolicyInstantSchema, expiresAt: FinancialPolicyInstantSchema });

export type FinancialPolicyReadObservation = z.infer<typeof FinancialPolicyReadObservationSchema>;
export type FinancialPolicyReaderScope = z.infer<typeof FinancialPolicyReaderScopeSchema>;
export type FinancialPolicyContextQuery = z.infer<typeof FinancialPolicyContextQuerySchema>;
export type FinancialPolicyContext = z.infer<typeof FinancialPolicyContextSchema>;
export type FinancialGovernanceIndexQuery = z.infer<typeof FinancialGovernanceIndexQuerySchema>;
export type FinancialGovernanceIndex = z.infer<typeof FinancialGovernanceIndexSchema>;
export type FinancialPolicyOriginalQuery = z.infer<typeof FinancialPolicyOriginalQuerySchema>;
export type FinancialPolicyOriginal = z.infer<typeof FinancialPolicyOriginalSchema>;
export type FinancialPolicyProposerObservation = z.infer<typeof FinancialPolicyProposerObservationSchema>;
export interface FinancialPolicyReaders {
  resolveObserver(environment: z.infer<typeof EnvironmentSchema>, observation: FinancialPolicyReadObservation): Promise<FinancialPolicyReaderScope>;
  context(identityEvidenceId: string, scope: FinancialPolicyReaderScope, query: FinancialPolicyContextQuery): Promise<FinancialPolicyContext>;
  governance(identityEvidenceId: string, scope: FinancialPolicyReaderScope, query: FinancialGovernanceIndexQuery): Promise<FinancialGovernanceIndex>;
  original(identityEvidenceId: string, scope: FinancialPolicyReaderScope, query: FinancialPolicyOriginalQuery): Promise<FinancialPolicyOriginal | null>;
  proposerObservation(identityEvidenceId: string, scope: FinancialPolicyReaderScope, proposal: z.infer<typeof FinancialPolicyRefSchema>): Promise<FinancialPolicyProposerObservation | null>;
}
