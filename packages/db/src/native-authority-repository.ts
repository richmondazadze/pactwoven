import { Pool } from 'pg';
import { z } from 'zod';
import { EnvironmentSchema, NativeDispatchMessageSchema, NativeAuthorityPrepareResultSchema, NativeAuthorityResultSchema,
  NativeAuthorityVerdictSchema, NativeProviderIssuerSchema, type Environment, type NativeDispatchMessage,
  type NativeAuthorityRepository, type NativeAuthorityPrepareResult, type NativeAuthorityResult, type NativeAuthorityVerdict } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';

function failure(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'NT001') throw new DomainError('FORBIDDEN', 403, 'Current task authority is required.');
  if (code === 'NT004') throw new DomainError('VALIDATION_FAILED', 422, 'The authority observation could not be accepted.');
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Current task authority has not been confirmed.');
}
export class PostgresNativeAuthorityRepository implements NativeAuthorityRepository {
  constructor(private readonly pool: Pool, private readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  async prepare(input: NativeDispatchMessage, expectedIssuer: string): Promise<NativeAuthorityPrepareResult> {
    const dispatch = NativeDispatchMessageSchema.parse(input), issuer = NativeProviderIssuerSchema.parse(expectedIssuer);
    if (dispatch.environment !== this.environment) throw new DomainError('FORBIDDEN', 403, 'This task belongs to another environment.');
    try {
      const rows = await this.pool.query<{ response: unknown }>('SELECT pactwoven.native_provider_authority_prepare($1,$2::jsonb,$3) AS response',
        [this.environment, JSON.stringify(dispatch), issuer]);
      if (rows.rows.length !== 1) throw new Error('Missing authority preparation');
      const prepared = NativeAuthorityPrepareResultSchema.parse(rows.rows[0]?.response);
      if (prepared.kind === 'prepared' && (prepared.providerIssuer !== issuer || JSON.stringify(prepared.dispatch) !== JSON.stringify(dispatch))) {
        throw new Error('Authority preparation changed scope');
      }
      return prepared;
    } catch (error) { return failure(error); }
  }
  async finish(nonce: string, input: NativeAuthorityVerdict): Promise<NativeAuthorityResult> {
    const token = z.uuid().parse(nonce), verdict = NativeAuthorityVerdictSchema.parse(input);
    try {
      const rows = await this.pool.query<{ response: unknown }>('SELECT pactwoven.native_provider_authority_finish($1,$2::uuid,$3::jsonb) AS response',
        [this.environment, token, JSON.stringify(verdict)]);
      if (rows.rows.length !== 1) throw new Error('Missing authority result');
      return NativeAuthorityResultSchema.parse(rows.rows[0]?.response);
    } catch (error) { return failure(error); }
  }
}
