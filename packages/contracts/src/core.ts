import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const EnvironmentSchema = z.enum(['simulation', 'development', 'staging', 'production']);
export type Environment = z.infer<typeof EnvironmentSchema>;
export const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const InstantSchema = z.iso.datetime({ offset: true });
export const RoleSchema = z.enum(['owner', 'operations', 'finance', 'receiver', 'supplier_admin', 'supplier_dispatcher', 'auditor', 'support', 'service']);
export type Role = z.infer<typeof RoleSchema>;
export const BaseUnitsSchema = z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).pipe(z.string().refine(value => BigInt(value) <= 18_446_744_073_709_551_615n, 'Amount exceeds unsigned 64-bit range'));
export const MoneySchema = z.strictObject({ assetId: IdSchema, amountBaseUnits: BaseUnitsSchema });
export type Money = z.infer<typeof MoneySchema>;
export const AssetSchema = z.strictObject({
  id: IdSchema, environment: EnvironmentSchema, network: z.string().min(1),
  mint: z.string().min(1), tokenProgram: z.string().min(1), symbol: z.string().min(1).max(16),
  decimals: z.number().int().min(0).max(18),
});
export type Asset = z.infer<typeof AssetSchema>;

export const ActorContextSchema = z.strictObject({
  actorId: IdSchema,
  principalKind: z.enum(['human', 'service']),
  organizationId: IdSchema,
  environment: EnvironmentSchema,
  roles: z.array(RoleSchema).min(1),
  siteIds: z.array(IdSchema),
  sessionId: z.string().min(1).max(256),
  authenticatedAt: InstantSchema,
  correlationId: z.string().min(1).max(128),
});
export type ActorContext = z.infer<typeof ActorContextSchema>;

export const ExecutionStateSchema = z.enum(['DRAFT', 'READY_FOR_AUTHORIZATION', 'ACTIVE', 'CLOSING', 'CLOSED']);
export const AuthorityStateSchema = z.enum(['ACTIVE', 'PAUSED', 'REVOKED', 'EXPIRED']);
export const CoverageStateSchema = z.enum(['UNKNOWN', 'ASSESSING', 'PARTIAL', 'READY', 'DEGRADED', 'UNAVAILABLE', 'STALE']);
export const FinancialStateSchema = z.enum(['PREPARED', 'AUTHORIZED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'RECONCILED', 'OUTCOME_UNKNOWN', 'REJECTED', 'FAILED', 'EXPIRED']);
export const OfferStateSchema = z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED']);
export const CommitmentStateSchema = z.enum(['PROPOSED', 'ACCEPTANCE_PENDING', 'ACCEPTED', 'RESERVATION_PENDING', 'RESERVED', 'ACTIVATION_PENDING', 'ACTIVE', 'FULFILLMENT_PENDING', 'FULFILLED', 'EXPIRED', 'FAILED', 'CANCELLATION_PENDING', 'CANCELLED', 'DISPUTED']);
export const AcceptanceStateSchema = z.enum(['AWAITING_EVIDENCE', 'UNDER_REVIEW', 'ACCEPTED', 'PARTIALLY_ACCEPTED', 'DISPUTED', 'SETTLEMENT_PENDING', 'SETTLED']);
export const DecisionStateSchema = z.enum(['OPEN', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED']);
export const RefundStateSchema = z.enum(['EXPECTED', 'REQUESTED', 'PENDING', 'CONFIRMED', 'RECONCILED', 'FAILED', 'DISPUTED', 'OUTCOME_UNKNOWN']);

export const ServiceWindowSchema = z.strictObject({
  startsAt: InstantSchema, endsAt: InstantSchema,
  timeZone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Use a valid IANA time zone'),
}).refine(value => Date.parse(value.endsAt) > Date.parse(value.startsAt), 'End must follow start');

export const RequirementSchema = z.strictObject({
  id: IdSchema, description: z.string().trim().min(1).max(1000),
  quantity: z.number().int().positive().max(1_000_000), unit: z.string().trim().min(1).max(48),
  evidenceRule: z.string().trim().max(2000),
});
export const CreateResponsibilityPayloadSchema = z.strictObject({
  title: z.string().trim().min(1).max(180), description: z.string().trim().max(5000),
  siteId: IdSchema, window: ServiceWindowSchema,
  requirements: z.array(RequirementSchema).max(100), acceptancePolicy: z.string().trim().max(5000),
});
export type CreateResponsibilityPayload = z.infer<typeof CreateResponsibilityPayloadSchema>;
export const ResponsibilitySchema = CreateResponsibilityPayloadSchema.extend({
  id: IdSchema, organizationId: IdSchema, ownerId: IdSchema, environment: EnvironmentSchema,
  version: z.number().int().positive(), executionState: ExecutionStateSchema,
  authorityState: AuthorityStateSchema.nullable(), coverageState: CoverageStateSchema,
  createdAt: InstantSchema, updatedAt: InstantSchema,
});
export type Responsibility = z.infer<typeof ResponsibilitySchema>;

export function commandSchema<T extends z.ZodType>(payload: T) {
  return z.strictObject({
    expectedVersion: z.number().int().min(0), mandateVersion: z.number().int().positive().nullable(),
    authorityEpoch: z.number().int().min(0).nullable(), payload,
  });
}
export const CreateResponsibilityCommandSchema = commandSchema(CreateResponsibilityPayloadSchema);
export type Command<T> = { expectedVersion: number; mandateVersion: number | null; authorityEpoch: number | null; payload: T };
export const IdempotencyKeySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const OperationSchema = z.strictObject({
  id: IdSchema, environment: EnvironmentSchema,
  status: z.enum(['accepted', 'pending', 'succeeded', 'failed', 'unknown']),
  aggregateId: IdSchema, aggregateVersion: z.number().int().min(0),
  financialState: FinancialStateSchema.nullable(),
  evidenceRefs: z.array(IdSchema), nextCheckAt: InstantSchema.nullable(),
  error: z.strictObject({ code: z.string(), retryable: z.boolean(), detailRef: IdSchema.nullable() }).nullable(),
});
export type Operation = z.infer<typeof OperationSchema>;
export const ApiErrorSchema = z.strictObject({ error: z.strictObject({
  code: z.string(), message: z.string(), correlationId: z.string(),
  fields: z.record(z.string(), z.array(z.string())).optional(),
}) });
export type ApiError = z.infer<typeof ApiErrorSchema>;
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(), q: z.string().trim().max(120).optional(),
});
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
}
export const ResponsibilityPageSchema = pageSchema(ResponsibilitySchema);
export const SiteSchema = z.strictObject({ id: IdSchema, name: z.string().min(1), timeZone: z.string().min(1) });
export const SessionSchema = z.strictObject({
  actor: ActorContextSchema,
  organization: z.strictObject({ id: IdSchema, name: z.string().min(1), authorityEpoch: z.number().int().min(0) }),
  sites: z.array(SiteSchema),
});
export type Session = z.infer<typeof SessionSchema>;

export const OrganizationBootstrapPayloadSchema = z.strictObject({
  initialSite: z.strictObject({
    name: z.string().trim().min(1).max(180),
    timeZone: z.string().min(1).max(100).refine(value => {
      try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
    }, 'Use a valid IANA time zone'),
  }),
});
export type OrganizationBootstrapPayload = z.infer<typeof OrganizationBootstrapPayloadSchema>;
export const OrganizationBootstrapCommandSchema = commandSchema(OrganizationBootstrapPayloadSchema);

export type DomainEvent<T> = {
  eventId: string; schemaVersion: number; environment: Environment; organizationId: string;
  aggregateType: string; aggregateId: string; aggregateVersion: number; type: string;
  source: string; sourceEventId: string | null; occurredAt: string; observedAt: string;
  causationId: string | null; correlationId: string; payload: T;
};
