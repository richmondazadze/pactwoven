import type { Pool } from 'pg';
import { z } from 'zod';
import { EnvironmentSchema, IdSchema, InstantSchema, type Environment } from '../../contracts/src/core';
import { NativeGoogleConnectionSchema, NativeGoogleSessionSchema, NativeGoogleError, type NativeGoogleConnection, type NativeGoogleSession } from '../../contracts/src/native-google';
import { GoogleDiscoveryBaselineSchema, GoogleDiscoveryBeginSchema, GoogleDiscoveryEventSchema, GoogleDiscoveryLeaseSchema, GoogleDiscoveryOverviewSchema, GoogleDiscoveryPrepareSchema, GoogleDiscoveryRequestKeySchema, GoogleDiscoveryReviewSchema, GoogleDiscoveryTicketSchema, type GoogleDiscoveryBegin, type GoogleDiscoveryEvent, type GoogleDiscoveryPrepare } from '../../contracts/src/native-google-discovery';

/** API and provider-reader are separate protected logins. Neither has table grants. */
export class PostgresNativeGoogleDiscoveryRepository {
  constructor(private readonly pools: { api: Pool; reader: Pool }, private readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  private session(value: NativeGoogleSession) { const parsed = NativeGoogleSessionSchema.parse(value); if (parsed.actor.environment !== this.environment) throw new NativeGoogleError('GOOGLE_DENIED'); return parsed; }
  private async call<T>(lane: 'api' | 'reader', name: string, values: unknown[], schema: z.ZodType<T>): Promise<T> {
    try { const result = await this.pools[lane].query<{ response: unknown }>(`SELECT pactwoven.${name}(${values.map((_, index) => '$' + (index + 1)).join(',')}) response`, values); if (result.rows.length !== 1) throw Error(); return schema.parse(result.rows[0]!.response); }
    catch (error) { const code = (error as { code?: string })?.code; throw new NativeGoogleError(code === 'NG003' ? 'GOOGLE_CONFLICT' : code === 'NG010' ? 'GOOGLE_INTEGRATION_REQUIRED' : ['NG001', 'NG004', 'NG008', 'ND001', 'NC001'].includes(code ?? '') ? 'GOOGLE_DENIED' : 'GOOGLE_OUTCOME_UNKNOWN'); }
  }
  overview(session: NativeGoogleSession) { return this.call('api', 'native_google_discovery_overview', [this.environment, this.session(session)], GoogleDiscoveryOverviewSchema); }
  begin(session: NativeGoogleSession, input: GoogleDiscoveryBegin) { return this.call('api', 'native_google_discovery_begin', [this.environment, this.session(session), GoogleDiscoveryBeginSchema.parse(input)], GoogleDiscoveryTicketSchema); }
  claim(id: string, operationId: string) { return this.call('reader', 'native_google_discovery_claim', [this.environment, IdSchema.parse(id), IdSchema.parse(operationId)], GoogleDiscoveryLeaseSchema); }
  reserveRefresh(id: string, operationId: string) { return this.call('reader', 'native_google_discovery_reserve_refresh', [this.environment, IdSchema.parse(id), IdSchema.parse(operationId)], NativeGoogleConnectionSchema); }
  completeRefresh(id: string, operationId: string, connection: NativeGoogleConnection) { return this.call('reader', 'native_google_discovery_complete_refresh', [this.environment, IdSchema.parse(id), IdSchema.parse(operationId), NativeGoogleConnectionSchema.parse(connection)], GoogleDiscoveryLeaseSchema); }
  complete(id: string, operationId: string, session: NativeGoogleSession, event: GoogleDiscoveryEvent, observedAt: string) { return this.call('reader', 'native_google_discovery_complete', [this.environment, IdSchema.parse(id), IdSchema.parse(operationId), this.session(session), GoogleDiscoveryEventSchema.parse(event), InstantSchema.parse(observedAt)], GoogleDiscoveryBaselineSchema); }
  fail(id: string, operationId: string) { return this.call('reader', 'native_google_discovery_fail', [this.environment, IdSchema.parse(id), IdSchema.parse(operationId)], z.literal(true)); }
  prepare(session: NativeGoogleSession, key: string, input: GoogleDiscoveryPrepare) { return this.call('api', 'native_google_discovery_prepare', [this.environment, this.session(session), GoogleDiscoveryRequestKeySchema.parse(key), GoogleDiscoveryPrepareSchema.parse(input)], GoogleDiscoveryReviewSchema); }
}
