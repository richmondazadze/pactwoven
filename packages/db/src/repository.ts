import { and, desc, eq, ilike, lt, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import {
  ActorContextSchema, CreateResponsibilityCommandSchema, IdempotencyKeySchema, OperationSchema,
  PageQuerySchema, ResponsibilitySchema, RoleSchema, SessionSchema,
  type ActorContext, type Command, type CreateResponsibilityPayload, type DomainEvent, type Environment,
  type Operation, type Responsibility, type Session,
} from '@pactwoven/contracts';
import { assertCreationVersion, assertResponsibilityCreator, assertResponsibilityReader, commandDigest, DomainError } from '@pactwoven/domain';
import * as schema from './schema.js';

export type VerifiedIdentity = {
  subject: string;
  externalOrganizationId: string;
  externalOrganizationName: string;
  externalMembershipId: string;
  externalRole: string;
  membershipObservedAt: string;
  sessionId: string;
  authenticatedAt: string;
};
export type ResponsibilityPage = { items: Responsibility[]; nextCursor: string | null };
export type ResponsibilityQuery = { limit?: number | undefined; cursor?: string | undefined; q?: string | undefined };
export interface FoundationRepository {
  getSession(identity: VerifiedIdentity, correlationId: string): Promise<Session>;
  listResponsibilities(actor: ActorContext, query: ResponsibilityQuery): Promise<ResponsibilityPage>;
  getResponsibility(actor: ActorContext, id: string): Promise<Responsibility>;
  createResponsibility(actor: ActorContext, idempotencyKey: string, command: Command<CreateResponsibilityPayload>): Promise<Operation>;
}

export async function assertUnprivilegedPool(pool: Pool): Promise<void> {
  const result = await pool.query<{ switched_role: boolean; privileged: boolean; owns_schema: boolean; owns_table: boolean; can_create: boolean }>(`
    SELECT current_user <> session_user AS switched_role,
      EXISTS (SELECT 1 FROM pg_roles privileged_role
      WHERE (privileged_role.rolsuper OR privileged_role.rolbypassrls OR privileged_role.rolcreaterole)
        AND pg_has_role(current_user, privileged_role.oid, 'MEMBER')) AS privileged,
      EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = 'pactwoven' AND pg_has_role(current_user, n.nspowner, 'MEMBER')) AS owns_schema,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pactwoven' AND c.relkind IN ('r','p') AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS owns_table,
      has_schema_privilege(current_user, 'pactwoven', 'CREATE') AS can_create
    FROM pg_roles r WHERE r.rolname = current_user
  `);
  const role = result.rows[0];
  if (!role || role.switched_role || role.privileged || role.owns_schema || role.owns_table || role.can_create) {
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'The API requires a non-owner, non-privileged database role.');
  }
}

export async function assertRuntimePool(pool: Pool): Promise<void> {
  await assertUnprivilegedPool(pool);
  const result = await pool.query<{ can_provision: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_roles r WHERE r.rolname = 'pactwoven_provisioner'
      AND (pg_has_role(current_user,r.oid,'MEMBER') OR pg_has_role(session_user,r.oid,'MEMBER')))
    OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pactwoven' AND p.proname = 'bootstrap_organization'
      AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS can_provision`);
  if (result.rows[0]?.can_provision) {
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'The API runtime must not have identity provisioning authority.');
  }
}

export async function createRuntimePool(connectionString: string): Promise<Pool> {
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on('error', () => { console.error('A runtime database connection became unavailable.'); });
  try { await assertRuntimePool(pool); return pool; } catch (error) { await pool.end(); throw error; }
}

const CursorSchema = z.strictObject({
  organizationId: z.string(), environment: z.string(), createdAt: z.iso.datetime(), id: z.string().min(1).max(128),
});

function rowToResponsibility(row: typeof schema.responsibilities.$inferSelect): Responsibility {
  return ResponsibilitySchema.parse({
    id: row.id, organizationId: row.organizationId, environment: row.environment,
    title: row.title, description: row.description, ownerId: row.ownerId, siteId: row.siteId,
    window: { startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), timeZone: row.timeZone },
    requirements: row.requirements, acceptancePolicy: row.acceptancePolicy,
    version: row.version, executionState: row.executionState, authorityState: row.authorityState, coverageState: row.coverageState,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  });
}

export class PostgresFoundationRepository implements FoundationRepository {
  constructor(private readonly pool: Pool, private readonly environment: Environment) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = new Error('Transaction rollback failed'); }
      throw error;
    } finally { client.release(broken); }
  }

  private async setScope(client: PoolClient, actor: ActorContext): Promise<void> {
    if (actor.environment !== this.environment) throw new DomainError('FORBIDDEN', 403, 'Environment does not match this service.');
    await client.query(`SELECT set_config('pactwoven.environment',$1,true), set_config('pactwoven.organization_id',$2,true),
      set_config('pactwoven.actor_id',$3,true), set_config('pactwoven.session_id',$4,true)`,
    [this.environment, actor.organizationId, actor.actorId, actor.sessionId]);
  }

  private async currentActor(client: PoolClient, actor: ActorContext): Promise<ActorContext> {
    await this.setScope(client, actor);
    const current = await client.query<{ roles: unknown }>('SELECT roles FROM pactwoven.lock_actor()');
    if (!current.rows[0]) throw new DomainError('FORBIDDEN', 403, 'Your organization membership or session is no longer active.');
    const siteRows = await drizzle(client).select({ id: schema.sites.id }).from(schema.sites)
      .where(and(eq(schema.sites.environment, this.environment), eq(schema.sites.organizationId, actor.organizationId)));
    return ActorContextSchema.parse({ ...actor, roles: z.array(RoleSchema).parse(current.rows[0].roles), siteIds: siteRows.map(site => site.id) });
  }

  async getSession(identity: VerifiedIdentity, correlationId: string): Promise<Session> {
    return this.transaction(async client => {
      await client.query(`SELECT set_config('pactwoven.environment',$1,true), set_config('pactwoven.external_subject',$2,true),
        set_config('pactwoven.external_organization_id',$3,true), set_config('pactwoven.session_id',$4,true),
        set_config('pactwoven.external_membership_id',$5,true), set_config('pactwoven.external_role',$6,true)`,
      [this.environment, identity.subject, identity.externalOrganizationId, identity.sessionId, identity.externalMembershipId, identity.externalRole]);
      const membership = await client.query<{ organization_id: string; organization_name: string; authority_epoch: number; actor_id: string; roles: unknown }>(
        'SELECT * FROM pactwoven.resolve_identity()');
      const member = membership.rows[0];
      if (!member) {
        const setup = await client.query<{ required: boolean }>('SELECT pactwoven.organization_setup_required() AS required');
        if (setup.rows[0]?.required) throw new DomainError('ORGANIZATION_SETUP_REQUIRED', 409, 'Finish setting up the selected organization.');
        throw new DomainError('FORBIDDEN', 403, 'No active organization membership is available for this session.');
      }
      const actor = await this.currentActor(client, ActorContextSchema.parse({
        actorId: member.actor_id, principalKind: 'human', organizationId: member.organization_id,
        environment: this.environment, roles: member.roles, siteIds: [], sessionId: identity.sessionId,
        authenticatedAt: identity.authenticatedAt, correlationId,
      }));
      const siteRows = await drizzle(client).select({ id: schema.sites.id, name: schema.sites.name, timeZone: schema.sites.timeZone })
        .from(schema.sites).where(and(eq(schema.sites.environment, this.environment), eq(schema.sites.organizationId, actor.organizationId))).orderBy(schema.sites.name);
      const organizationRows = await drizzle(client).select({ id: schema.organizations.id, name: schema.organizations.name, authorityEpoch: schema.organizations.authorityEpoch })
        .from(schema.organizations).where(and(eq(schema.organizations.environment, this.environment), eq(schema.organizations.id, actor.organizationId)));
      return SessionSchema.parse({ actor, organization: organizationRows[0], sites: siteRows });
    });
  }

  async listResponsibilities(actor: ActorContext, query: ResponsibilityQuery): Promise<ResponsibilityPage> {
    const parsed = PageQuerySchema.parse(query);
    let cursor: z.infer<typeof CursorSchema> | undefined;
    if (parsed.cursor) {
      try { cursor = CursorSchema.parse(JSON.parse(Buffer.from(parsed.cursor, 'base64url').toString('utf8'))); }
      catch { throw new DomainError('VALIDATION_FAILED', 422, 'The page cursor is invalid.'); }
      if (cursor.organizationId !== actor.organizationId || cursor.environment !== actor.environment) {
        throw new DomainError('VALIDATION_FAILED', 422, 'The page cursor does not belong to this organization.');
      }
    }
    return this.transaction(async client => {
      const current = await this.currentActor(client, actor);
      assertResponsibilityReader(current);
      const table = schema.responsibilities;
      const conditions = [eq(table.environment, this.environment), eq(table.organizationId, current.organizationId)];
      if (parsed.q) conditions.push(ilike(table.title, `%${parsed.q.replace(/[\\%_]/g, '\\$&')}%`));
      if (cursor) conditions.push(or(lt(table.createdAt, new Date(cursor.createdAt)), and(eq(table.createdAt, new Date(cursor.createdAt)), lt(table.id, cursor.id)))!);
      const rows = await drizzle(client).select().from(table).where(and(...conditions)).orderBy(desc(table.createdAt), desc(table.id)).limit(parsed.limit + 1);
      const items = rows.slice(0, parsed.limit).map(rowToResponsibility);
      const last = items.at(-1);
      const nextCursor = rows.length > parsed.limit && last
        ? Buffer.from(JSON.stringify({ organizationId: current.organizationId, environment: this.environment, createdAt: last.createdAt, id: last.id })).toString('base64url')
        : null;
      return { items, nextCursor };
    });
  }

  async getResponsibility(actor: ActorContext, id: string): Promise<Responsibility> {
    return this.transaction(async client => {
      const current = await this.currentActor(client, actor);
      assertResponsibilityReader(current);
      const row = await drizzle(client).select().from(schema.responsibilities).where(and(
        eq(schema.responsibilities.environment, this.environment), eq(schema.responsibilities.organizationId, current.organizationId), eq(schema.responsibilities.id, id),
      )).limit(1);
      if (!row[0]) throw new DomainError('NOT_FOUND', 404, 'Responsibility not found.');
      return rowToResponsibility(row[0]);
    });
  }

  async createResponsibility(actor: ActorContext, idempotencyKey: string, command: Command<CreateResponsibilityPayload>): Promise<Operation> {
    const input = CreateResponsibilityCommandSchema.parse(command);
    const parsed = { ...input, payload: { ...input.payload, window: { ...input.payload.window,
      startsAt: new Date(input.payload.window.startsAt).toISOString(), endsAt: new Date(input.payload.window.endsAt).toISOString(),
    } } };
    IdempotencyKeySchema.parse(idempotencyKey);
    assertCreationVersion(parsed.expectedVersion, parsed.mandateVersion, parsed.authorityEpoch);
    const hash = await commandDigest({ schemaVersion: 1, kind: 'responsibility.create', environment: this.environment, organizationId: actor.organizationId, actorId: actor.actorId, command: parsed });
    return this.transaction(async client => {
      const current = await this.currentActor(client, actor);
      assertResponsibilityCreator(current, parsed.payload.siteId);
      const db = drizzle(client);
      const responsibilityId = crypto.randomUUID();
      const operation: Operation = {
        id: crypto.randomUUID(), environment: this.environment, status: 'succeeded', aggregateId: responsibilityId, aggregateVersion: 1,
        financialState: null, evidenceRefs: [], nextCheckAt: null, error: null,
      };
      const inserted = await db.insert(schema.operations).values({
        environment: this.environment, organizationId: current.organizationId, id: operation.id, actorId: current.actorId,
        kind: 'responsibility.create', idempotencyKey, commandHash: hash, aggregateId: responsibilityId, response: operation,
      }).onConflictDoNothing({ target: [schema.operations.environment, schema.operations.organizationId, schema.operations.kind, schema.operations.idempotencyKey] }).returning({ id: schema.operations.id });
      if (inserted.length === 0) {
        const existing = await db.select().from(schema.operations).where(and(
          eq(schema.operations.environment, this.environment), eq(schema.operations.organizationId, current.organizationId),
          eq(schema.operations.kind, 'responsibility.create'), eq(schema.operations.idempotencyKey, idempotencyKey),
        )).limit(1);
        if (!existing[0] || existing[0].commandHash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'This request key was already used for a different command.');
        return OperationSchema.parse(existing[0].response);
      }
      const now = new Date();
      const payload = parsed.payload;
      await db.insert(schema.responsibilities).values({
        environment: this.environment, organizationId: current.organizationId, id: responsibilityId, ownerId: current.actorId,
        siteId: payload.siteId, title: payload.title, description: payload.description, startsAt: new Date(payload.window.startsAt),
        endsAt: new Date(payload.window.endsAt), timeZone: payload.window.timeZone, requirements: payload.requirements,
        acceptancePolicy: payload.acceptancePolicy, version: 1, executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN', createdAt: now, updatedAt: now,
      });
      const event: DomainEvent<{ responsibilityId: string }> = {
        eventId: crypto.randomUUID(), schemaVersion: 1, environment: this.environment, organizationId: current.organizationId,
        aggregateType: 'responsibility', aggregateId: responsibilityId, aggregateVersion: 1, type: 'responsibility.created',
        source: 'api', sourceEventId: null, occurredAt: now.toISOString(), observedAt: now.toISOString(),
        causationId: operation.id, correlationId: current.correlationId, payload: { responsibilityId },
      };
      await db.insert(schema.outboxEvents).values({ environment: this.environment, organizationId: current.organizationId, id: event.eventId,
        aggregateId: responsibilityId, aggregateVersion: 1, eventType: event.type, payload: event });
      return operation;
    });
  }
}
