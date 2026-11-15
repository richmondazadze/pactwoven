import { integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { Operation } from '@pactwoven/contracts';

export const pactwoven = pgSchema('pactwoven');
export const organizations = pactwoven.table('organizations', {
  environment: text('environment').notNull(), id: text('id').notNull(), externalOrganizationId: text('external_organization_id').notNull(),
  name: text('name').notNull(), status: text('status').notNull(), authorityEpoch: integer('authority_epoch').notNull(),
}, table => [primaryKey({ columns: [table.environment, table.id] })]);
export const memberships = pactwoven.table('memberships', {
  environment: text('environment').notNull(), organizationId: text('organization_id').notNull(), actorId: text('actor_id').notNull(),
  externalSubject: text('external_subject').notNull(), roles: text('roles').array().notNull(), status: text('status').notNull(),
  externalMembershipId: text('external_membership_id'), grantBasis: text('grant_basis').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
}, table => [primaryKey({ columns: [table.environment, table.organizationId, table.actorId] })]);
export const sites = pactwoven.table('sites', {
  environment: text('environment').notNull(), organizationId: text('organization_id').notNull(), id: text('id').notNull(),
  name: text('name').notNull(), timeZone: text('time_zone').notNull(),
}, table => [primaryKey({ columns: [table.environment, table.organizationId, table.id] })]);
export const responsibilities = pactwoven.table('responsibilities', {
  environment: text('environment').notNull(), organizationId: text('organization_id').notNull(), id: text('id').notNull(),
  ownerId: text('owner_id').notNull(), siteId: text('site_id').notNull(), title: text('title').notNull(), description: text('description').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }).notNull(), timeZone: text('time_zone').notNull(),
  requirements: jsonb('requirements').notNull(), acceptancePolicy: text('acceptance_policy').notNull(),
  version: integer('row_version').notNull(), executionState: text('execution_state').notNull(), authorityState: text('authority_state'),
  coverageState: text('coverage_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date', precision: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date', precision: 3 }).notNull(),
}, table => [primaryKey({ columns: [table.environment, table.organizationId, table.id] })]);
export const operations = pactwoven.table('operations', {
  environment: text('environment').notNull(), organizationId: text('organization_id').notNull(), id: text('id').notNull(),
  actorId: text('actor_id').notNull(), kind: text('kind').notNull(), idempotencyKey: text('idempotency_key').notNull(),
  commandHash: text('command_hash').notNull(), aggregateId: text('aggregate_id').notNull(),
  response: jsonb('response').$type<Operation>().notNull(),
}, table => [primaryKey({ columns: [table.environment, table.organizationId, table.id] }),
  uniqueIndex('operations_environment_organization_id_kind_idempotency_key_key').on(table.environment, table.organizationId, table.kind, table.idempotencyKey)]);
export const outboxEvents = pactwoven.table('outbox_events', {
  environment: text('environment').notNull(), organizationId: text('organization_id').notNull(), id: text('id').notNull(),
  aggregateId: text('aggregate_id').notNull(), aggregateVersion: integer('aggregate_version').notNull(),
  eventType: text('event_type').notNull(), payload: jsonb('payload').notNull(),
}, table => [primaryKey({ columns: [table.environment, table.organizationId, table.id] })]);
