import { Pool } from 'pg';
import { z } from 'zod';
import {
  EnvironmentSchema, IdSchema, NativeDispatchClaimResultSchema, NativeDispatchClaimSchema,
  NativeDispatchMessageSchema, NativeDispatchPublicationSchema, NativeDispatchRecoverySchema,
  NativeTaskArtifactSchema, NativeTaskEventSchema, NativeTaskMessageSchema, NativeTaskStepSchema,
  type Environment, type NativeDispatchClaim, type NativeDispatchClaimResult, type NativeDispatchMessage,
  type NativeDispatchPublication, type NativeDispatchPublisherRepository, type NativeDispatchRecovery,
  type NativeDispatchWorkerRepository, type NativeTaskProgress,
} from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';

const LeaseSchema = z.number().int().min(1_000).max(300_000);
const LimitSchema = z.number().int().min(1).max(100);
const DelaySchema = z.number().int().min(0).max(86_400_000);
const YieldProgressSchema = z.strictObject({
  title: z.string().min(1).max(180).optional(), phase: z.string().min(1).max(180), status: z.literal('running').optional(),
  event: NativeTaskEventSchema.omit({ sequence: true, createdAt: true }).extend({ kind: z.enum(['progress', 'message', 'artifact']) }),
  steps: z.array(NativeTaskStepSchema).max(32).optional(),
  message: NativeTaskMessageSchema.omit({ createdAt: true }).extend({ role: z.literal('assistant') }).optional(),
  artifact: NativeTaskArtifactSchema.omit({ createdAt: true }).optional(),
  checkpoint: NativeDispatchClaimSchema.shape.claim.shape.checkpoint,
});
function failure(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'NT001') throw new DomainError('FORBIDDEN', 403, 'Current native service access is required.');
  if (code === 'NT004') throw new DomainError('VALIDATION_FAILED', 422, 'Invalid native dispatch request.');
  if (code === 'NT003') throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'Saved work identity has conflicting content.');
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Native dispatch was not confirmed. Preserve the existing delivery identity.');
}
class DispatchRepository {
  constructor(protected readonly pool: Pool, protected readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  protected message(input: NativeDispatchMessage): NativeDispatchMessage {
    const message = NativeDispatchMessageSchema.parse(input);
    if (message.environment !== this.environment) throw new DomainError('FORBIDDEN', 403, 'This delivery belongs to another environment.');
    return message;
  }
  protected async query<T>(sql: string, values: unknown[], schema: z.ZodType<T>): Promise<T> {
    try {
      const result = await this.pool.query<{ response: unknown }>(sql, values);
      if (result.rows.length !== 1) throw new Error('Missing dispatch response');
      return schema.parse(result.rows[0]?.response);
    } catch (error) { return failure(error); }
  }
}
export class PostgresNativeDispatchPublisherRepository extends DispatchRepository implements NativeDispatchPublisherRepository {
  async claimPublications(publisherId: string, limit: number, leaseMilliseconds: number): Promise<NativeDispatchPublication[]> {
    return this.query('SELECT pactwoven.native_dispatch_claim_publications($1,$2,$3,$4) AS response',
      [this.environment, IdSchema.parse(publisherId), LimitSchema.parse(limit), LeaseSchema.parse(leaseMilliseconds)],
      z.array(NativeDispatchPublicationSchema).max(100));
  }
  private publication(input: NativeDispatchPublication, ack: boolean, delayMilliseconds: number | null): Promise<boolean> {
    const publication = NativeDispatchPublicationSchema.parse(input); const message = this.message(publication.message);
    return this.query('SELECT pactwoven.native_dispatch_publication($1,$2,$3,$4::bigint,$5::uuid,$6,$7) AS response',
      [this.environment, message.organizationId, message.taskId, message.generation, publication.publicationToken, ack, delayMilliseconds], z.boolean());
  }
  acknowledgePublication(publication: NativeDispatchPublication): Promise<boolean> { return this.publication(publication, true, null); }
  retryPublication(publication: NativeDispatchPublication, delayMilliseconds: number): Promise<boolean> {
    return this.publication(publication, false, DelaySchema.parse(delayMilliseconds));
  }
  recoverDue(limit: number): Promise<NativeDispatchRecovery> {
    return this.query('SELECT pactwoven.native_dispatch_recover($1,$2) AS response', [this.environment, LimitSchema.parse(limit)], NativeDispatchRecoverySchema);
  }
}
export class PostgresNativeDispatchWorkerRepository extends DispatchRepository implements NativeDispatchWorkerRepository {
  async claimTarget(input: NativeDispatchMessage, workerId: string, leaseMilliseconds: number): Promise<NativeDispatchClaimResult> {
    const message = this.message(input);
    const result = await this.query('SELECT pactwoven.native_dispatch_claim_target($1,$2::jsonb,$3,$4) AS response',
      [this.environment, JSON.stringify(message), IdSchema.parse(workerId), LeaseSchema.parse(leaseMilliseconds)], NativeDispatchClaimResultSchema);
    if (result.kind === 'claimed') {
      NativeDispatchClaimSchema.parse({ claim: result.claim, dispatch: result.dispatch });
      if (result.dispatch.environment !== this.environment || result.dispatch.organizationId !== message.organizationId ||
        result.dispatch.taskId !== message.taskId || result.dispatch.generation !== message.generation) throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'The native delivery claim could not be verified.');
    }
    return result;
  }
  yieldClaim(input: NativeDispatchClaim, progress: NativeTaskProgress, delayMilliseconds = 0): Promise<boolean> {
    const work = NativeDispatchClaimSchema.parse(input); const message = this.message(work.dispatch);
    return this.query('SELECT pactwoven.native_dispatch_yield($1,$2::jsonb,$3::uuid,$4::jsonb,$5) AS response',
      [this.environment, JSON.stringify(message), work.claim.leaseToken, JSON.stringify(YieldProgressSchema.parse(progress)), DelaySchema.parse(delayMilliseconds)], z.boolean());
  }
}
