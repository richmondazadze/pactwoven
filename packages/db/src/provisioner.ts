import { Pool } from 'pg';
import { OrganizationBootstrapCommandSchema, IdempotencyKeySchema, OperationSchema,
  type Command, type Environment, type Operation, type OrganizationBootstrapPayload } from '@pactwoven/contracts';
import { assertCreationVersion, commandDigest, DomainError } from '@pactwoven/domain';
import { assertUnprivilegedPool, type VerifiedIdentity } from './repository.js';

export interface OrganizationProvisioner {
  bootstrapOrganization(identity: VerifiedIdentity, idempotencyKey: string,
    command: Command<OrganizationBootstrapPayload>, correlationId: string): Promise<Operation>;
}

export async function assertProvisionerPool(pool: Pool): Promise<void> {
  await assertUnprivilegedPool(pool);
  const result = await pool.query<{ provisioner: boolean; runtime: boolean; table_access: boolean }>(`
    SELECT pg_has_role(current_user,'pactwoven_provisioner','MEMBER') AS provisioner,
      pg_has_role(current_user,'pactwoven_runtime','MEMBER') AS runtime,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pactwoven' AND c.relkind IN ('r','p')
          AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS table_access
  `);
  const role = result.rows[0];
  if (!role?.provisioner || role.runtime || role.table_access) {
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Organization setup requires the isolated, function-only provisioner role.');
  }
}

export async function createProvisionerPool(connectionString: string): Promise<Pool> {
  const pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000 });
  pool.on('error', () => { console.error('An identity provisioning connection became unavailable.'); });
  try { await assertProvisionerPool(pool); return pool; } catch (error) { await pool.end(); throw error; }
}

export class PostgresOrganizationProvisioner implements OrganizationProvisioner {
  constructor(private readonly pool: Pool, private readonly environment: Environment) {}

  async bootstrapOrganization(identity: VerifiedIdentity, idempotencyKey: string,
    command: Command<OrganizationBootstrapPayload>, correlationId: string): Promise<Operation> {
    const parsed = OrganizationBootstrapCommandSchema.parse(command);
    IdempotencyKeySchema.parse(idempotencyKey);
    assertCreationVersion(parsed.expectedVersion, parsed.mandateVersion, parsed.authorityEpoch);
    if (identity.externalRole !== 'org:admin') throw new DomainError('FORBIDDEN', 403, 'An organization administrator must finish setup.');
    const hash = await commandDigest({ schemaVersion: 1, kind: 'organization.bootstrap', environment: this.environment,
      externalOrganizationId: identity.externalOrganizationId, subject: identity.subject,
      externalMembershipId: identity.externalMembershipId, command: parsed });
    try {
      const result = await this.pool.query<{ response: unknown }>(
        'SELECT pactwoven.bootstrap_organization($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS response',
        [this.environment, identity.externalOrganizationId, identity.externalOrganizationName, identity.subject,
          identity.externalMembershipId, identity.externalRole, identity.sessionId,
          parsed.payload.initialSite.name, parsed.payload.initialSite.timeZone, idempotencyKey, hash, correlationId]);
      return OperationSchema.parse(result.rows[0]?.response);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code === 'PW001') throw new DomainError('FORBIDDEN', 403, 'Your current membership cannot set up this organization.');
      if (code === 'PW002') throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'This request key was already used for a different command.');
      if (code === 'PW003') throw new DomainError('ORGANIZATION_ALREADY_CONFIGURED', 409, 'This organization is configured. Refresh your session to continue.');
      if (code === 'PW004') throw new DomainError('VALIDATION_FAILED', 422, 'Check the organization and initial site details.');
      throw error;
    }
  }
}
