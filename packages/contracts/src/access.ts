import { z } from 'zod';
import { commandSchema, IdSchema, InstantSchema, IdempotencyKeySchema } from './core';

export const AccessRoleSchema = z.enum(['owner', 'operations', 'finance', 'receiver', 'auditor']);
const sites = z.array(IdSchema).max(100).refine(items => new Set(items).size === items.length, 'Site grants must be unique');
export const AccessScopeSchema = z.strictObject({
  roles: z.array(AccessRoleSchema).min(1).max(5).refine(items => new Set(items).size === items.length, 'Role grants must be unique'),
  siteIds: sites, actionSiteIds: sites, expiresAt: InstantSchema.nullable(),
});
export type AccessScope = z.infer<typeof AccessScopeSchema>;
export const GrantAccessPayloadSchema = AccessScopeSchema.extend({ externalMembershipId: IdSchema, externalSubject: IdSchema });
export const ReviseAccessPayloadSchema = AccessScopeSchema;
export const RevokeAccessPayloadSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) });
const currentAccessAuthority = (command: { expectedVersion: number; mandateVersion: number | null; authorityEpoch: number | null }) =>
  command.mandateVersion === null && command.authorityEpoch !== null && command.authorityEpoch <= 2_147_483_647 && command.expectedVersion <= 2_147_483_647;
export const GrantAccessCommandSchema = commandSchema(GrantAccessPayloadSchema).refine(currentAccessAuthority, 'Current organization authority is required')
  .refine(command => command.expectedVersion === 0, 'A new member requires version zero');
export const ReviseAccessCommandSchema = commandSchema(ReviseAccessPayloadSchema).refine(currentAccessAuthority, 'Current organization authority is required')
  .refine(command => command.expectedVersion > 0, 'An existing member version is required');
export const RevokeAccessCommandSchema = commandSchema(RevokeAccessPayloadSchema).refine(currentAccessAuthority, 'Current organization authority is required')
  .refine(command => command.expectedVersion > 0, 'An existing member version is required');
export type GrantAccessCommand = z.infer<typeof GrantAccessCommandSchema>;
export type ReviseAccessCommand = z.infer<typeof ReviseAccessCommandSchema>;
export type RevokeAccessCommand = z.infer<typeof RevokeAccessCommandSchema>;
export const MemberCandidateSchema = z.strictObject({
  externalOrganizationId: IdSchema,
  externalMembershipId: IdSchema, externalSubject: IdSchema, displayName: z.string().min(1).max(180),
  externalRole: z.string().min(1).max(128), observedAt: InstantSchema,
});
export type MemberCandidate = z.infer<typeof MemberCandidateSchema>;
export const MemberAccessSchema = AccessScopeSchema.extend({
  actorId: IdSchema, externalMembershipId: IdSchema, externalSubject: IdSchema, displayName: z.string().min(1).max(180),
  status: z.enum(['active', 'suspended', 'revoked']), version: z.number().int().min(1).max(2_147_483_647),
});
export type MemberAccess = z.infer<typeof MemberAccessSchema>;
export const AccessQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().regex(/^(0|[1-9][0-9]{0,5})$/).optional(),
});
export type AccessQuery = z.infer<typeof AccessQuerySchema>;
export const AccessOperationQuerySchema = z.strictObject({ kind: z.enum(['grant', 'revise', 'revoke']), key: IdempotencyKeySchema });
export type AccessOperationQuery = z.infer<typeof AccessOperationQuerySchema>;
export const MemberCandidatePageSchema = z.strictObject({ items: z.array(MemberCandidateSchema).max(100), nextCursor: z.string().nullable(), observedAt: InstantSchema });
export const MemberAccessPageSchema = z.strictObject({ items: z.array(MemberAccessSchema).max(100), nextCursor: z.string().nullable(), observedAt: InstantSchema, authorityEpoch: z.number().int().nonnegative() });
export type MemberCandidatePage = z.infer<typeof MemberCandidatePageSchema>;
export type MemberAccessPage = z.infer<typeof MemberAccessPageSchema>;
