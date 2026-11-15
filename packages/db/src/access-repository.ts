import { Pool } from 'pg';
import { z } from 'zod';
import { AccessQuerySchema, AccessOperationQuerySchema, GrantAccessCommandSchema, ReviseAccessCommandSchema, RevokeAccessCommandSchema,
  MemberAccessPageSchema, MemberCandidateSchema, OperationSchema,
  type AccessQuery, type AccessOperationQuery, type GrantAccessCommand, type ReviseAccessCommand, type RevokeAccessCommand,
  type MemberCandidate, type MemberAccess, type MemberAccessPage, type Operation, type Environment } from '@pactwoven/contracts';
import { commandDigest, DomainError, validateAccessScope } from '@pactwoven/domain';
import { assertUnprivilegedPool, type VerifiedIdentity } from './repository.js';

// Internal verified evidence only. No public request accepts this object.
export const AccessMfaEvidenceSchema = z.strictObject({
  id: z.uuid(), purpose: z.literal('member_access'), subject: z.string().min(1).max(128),
  externalOrganizationId: z.string().min(1).max(128), externalMembershipId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256), issuer: z.string().url(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  tokenIssuedAt: z.iso.datetime(), firstFactorAgeMinutes: z.number().int().nonnegative().max(1_000_000),
  secondFactorAgeMinutes: z.number().int().nonnegative().max(1_000_000),
  verifiedAt: z.iso.datetime(), observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
});
export type AccessMfaEvidence = z.infer<typeof AccessMfaEvidenceSchema>;
export type VerifiedStepUpIdentity = { identity: VerifiedIdentity; evidence: AccessMfaEvidence };
export type AccessMutation =
  | { kind: 'grant'; command: GrantAccessCommand; target: MemberCandidate }
  | { kind: 'revise'; actorId: string; command: ReviseAccessCommand; target: MemberCandidate }
  | { kind: 'revoke'; actorId: string; command: RevokeAccessCommand; target: null };
export interface AccessRepository {
  listMembers(identity: VerifiedIdentity, query: AccessQuery): Promise<MemberAccessPage>;
  getMember(identity: VerifiedIdentity, actorId: string): Promise<MemberAccess>;
  getOperation(identity: VerifiedIdentity, query: AccessOperationQuery): Promise<Operation>;
  changeAccess(verified: VerifiedStepUpIdentity, idempotencyKey: string, mutation: AccessMutation, correlationId: string): Promise<Operation>;
}
export async function assertAccessPool(pool: Pool): Promise<void> {
  await assertUnprivilegedPool(pool);
  const result = await pool.query<{ access: boolean; other: boolean; tables: boolean }>(`SELECT
    pg_has_role(current_user,'pactwoven_access_provisioner','MEMBER') AS access,
    (pg_has_role(current_user,'pactwoven_runtime','MEMBER') OR pg_has_role(current_user,'pactwoven_provisioner','MEMBER')
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven'
        AND p.proname='bootstrap_organization' AND has_function_privilege(current_user,p.oid,'EXECUTE'))) AS other,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven' AND c.relkind IN ('r','p')
      AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS tables`);
  const row = result.rows[0];
  if (!row?.access || row.other || row.tables) throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Member access requires its isolated function-only database role.');
}
export async function createAccessPool(connectionString: string): Promise<Pool> {
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statement_timeout: 5_000 });
  pool.on('error', () => { console.error('An access-management connection became unavailable.'); });
  try { await assertAccessPool(pool); return pool; } catch (error) { await pool.end(); throw error; }
}
function databaseError(error: unknown): never {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const errors = {
    PA001: ['FORBIDDEN', 403, 'Current owner access and a verified member are required.'],
    PA002: ['VERSION_CONFLICT', 409, 'Access or organization authority changed. Refresh before reviewing again.'],
    PA003: ['IDEMPOTENCY_CONFLICT', 409, 'This request key was already used for a different change.'],
    PA004: ['VALIDATION_FAILED', 422, 'Check the member access details.'],
    PA005: ['STEP_UP_REQUIRED', 403, 'Verify both authentication factors again before changing access.'],
  } as const;
  if (typeof code === 'string' && Object.hasOwn(errors, code)) {
    const [name, status, message] = errors[code as keyof typeof errors];
    throw new DomainError(name, status, message);
  }
  throw error;
}
export class PostgresAccessRepository implements AccessRepository {
  constructor(private readonly pool: Pool, private readonly environment: Environment) {}
  async listMembers(identity: VerifiedIdentity, input: AccessQuery): Promise<MemberAccessPage> {
    const query = AccessQuerySchema.parse(input);
    try {
      const result = await this.pool.query<{ response: unknown }>('SELECT pactwoven.read_member_access($1,$2::jsonb,$3,$4,NULL) AS response',
        [this.environment, JSON.stringify(identity), Number(query.cursor ?? '0'), query.limit]);
      return MemberAccessPageSchema.parse(result.rows[0]?.response);
    } catch (error) { return databaseError(error); }
  }
  async changeAccess(verified: VerifiedStepUpIdentity, idempotencyKey: string, mutation: AccessMutation, correlationId: string): Promise<Operation> {
    const evidence = AccessMfaEvidenceSchema.parse(verified.evidence);
    const command = mutation.kind === 'grant' ? GrantAccessCommandSchema.parse(mutation.command)
      : mutation.kind === 'revise' ? ReviseAccessCommandSchema.parse(mutation.command) : RevokeAccessCommandSchema.parse(mutation.command);
    if (mutation.kind !== 'revoke') {
      const { roles, siteIds, actionSiteIds, expiresAt } = command.payload as GrantAccessCommand['payload'];
      validateAccessScope({ roles, siteIds, actionSiteIds, expiresAt }, new Date().toISOString());
    }
    const target = mutation.target ? MemberCandidateSchema.parse(mutation.target) : null;
    const actorId = mutation.kind === 'grant' ? null : mutation.actorId;
    const hash = await commandDigest({ schemaVersion: 1, kind: `member.${mutation.kind}`, environment: this.environment,
      externalOrganizationId: verified.identity.externalOrganizationId, subject: verified.identity.subject, actorId, command });
    try {
      const result = await this.pool.query<{ response: unknown }>('SELECT pactwoven.change_member_access($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10) AS response',
        [this.environment, JSON.stringify(verified.identity), JSON.stringify(evidence), target ? JSON.stringify(target) : null,
          mutation.kind, actorId, JSON.stringify(command), idempotencyKey, hash, correlationId]);
      return OperationSchema.parse(result.rows[0]?.response);
    } catch (error) { return databaseError(error); }
  }
  async getMember(identity: VerifiedIdentity, actorId: string): Promise<MemberAccess> {
    try {
      const result = await this.pool.query<{ response: unknown }>('SELECT pactwoven.read_member_access($1,$2::jsonb,0,1,$3) AS response',
        [this.environment, JSON.stringify(identity), actorId]);
      const member = MemberAccessPageSchema.parse(result.rows[0]?.response).items[0];
      if (!member) throw new DomainError('NOT_FOUND', 404, 'Member not found.');
      return member;
    } catch (error) { return databaseError(error); }
  }
  async getOperation(identity: VerifiedIdentity, input: AccessOperationQuery): Promise<Operation> {
    const query = AccessOperationQuerySchema.parse(input);
    try {
      const result = await this.pool.query<{ response: unknown }>('SELECT pactwoven.read_access_operation($1,$2::jsonb,$3,$4) AS response',
        [this.environment, JSON.stringify(identity), query.kind, query.key]);
      if (!result.rows[0]?.response) throw new DomainError('NOT_FOUND', 404, 'No committed access change was found for this request.');
      return OperationSchema.parse(result.rows[0].response);
    } catch (error) { return databaseError(error); }
  }
}
