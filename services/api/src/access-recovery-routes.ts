import type { Hono } from 'hono';
import { AccessRecoveryQuerySchema, AccessRecoveryResultSchema, CloseAccessRecoveryIntentSchema,
  CloseAccessRecoveryResultSchema, IdempotencyKeySchema, type AccessRecoveryGateway } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';

export function registerAccessRecoveryRoutes(app: Hono<ApiEnv>, gateway: AccessRecoveryGateway | undefined): void {
  const service = () => { if (!gateway) throw new DomainError('SETUP_REQUIRED', 503, 'Access request recovery is not configured.'); return gateway; };
  const token = (value: string | undefined) => {
    const result = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(value ?? '')?.[1];
    if (!result) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.'); return result;
  };
  function unavailable(): never { throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'The original access request result could not be verified.'); }
  app.all('/v1/member-access/recovery', async c => {
    if (c.req.method !== 'GET') throw new DomainError('NOT_FOUND', 404, 'Resource not found.');
    const entries = [...new URL(c.req.url).searchParams];
    if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new DomainError('VALIDATION_FAILED', 422, 'Each recovery query field must appear once.');
    const query = AccessRecoveryQuerySchema.parse(Object.fromEntries(entries));
    const parsed = AccessRecoveryResultSchema.safeParse(await service().get(token(c.req.header('Authorization')), query, c.get('correlationId')));
    if (!parsed.success) unavailable();
    const result = parsed.data, identity = c.get('identity');
    if (result.kind !== query.kind || result.key !== query.key || result.externalOrganizationId !== identity.externalOrganizationId || result.reviewer.externalMembershipId !== identity.externalMembershipId) unavailable();
    return c.json(result);
  });
  app.all('/v1/member-access/recovery/close', async c => {
    if (c.req.method !== 'POST') throw new DomainError('NOT_FOUND', 404, 'Resource not found.');
    if (new URL(c.req.url).search) throw new DomainError('VALIDATION_FAILED', 422, 'Recovery closure does not accept query fields.');
    const key = IdempotencyKeySchema.parse(c.req.header('Idempotency-Key')), intent = CloseAccessRecoveryIntentSchema.parse(c.get('requestBody'));
    const parsed = CloseAccessRecoveryResultSchema.safeParse(await service().close(token(c.req.header('Authorization')), key, intent, c.get('correlationId')));
    if (!parsed.success) unavailable();
    const result = parsed.data, identity = c.get('identity');
    if (result.kind !== intent.kind || result.key !== key || result.environment !== intent.expectedEnvironment || result.organizationId !== intent.expectedOrganizationId ||
        result.reviewer.actorId !== intent.expectedActorId || result.reviewer.externalMembershipId !== intent.expectedExternalMembershipId ||
        result.externalOrganizationId !== identity.externalOrganizationId || result.reviewer.externalMembershipId !== identity.externalMembershipId) unavailable();
    return c.json(result);
  });
}
