import type { Hono } from 'hono';
import { AccessQuerySchema, AccessOperationQuerySchema, GrantAccessCommandSchema, ReviseAccessCommandSchema, RevokeAccessCommandSchema, IdempotencyKeySchema, IdSchema } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import type { AccessGateway } from './access-service.js';
import type { ApiEnv } from './app.js';

export function registerAccessRoutes(app: Hono<ApiEnv>, gateway: AccessGateway | undefined): void {
  const service = () => {
    if (!gateway) throw new DomainError('SETUP_REQUIRED', 503, 'Member access management is not configured.');
    return gateway;
  };
  const token = (authorization: string | undefined) => {
    const value = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(authorization ?? '')?.[1];
    if (!value) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.');
    return value;
  };
  app.get('/v1/members/candidates', async c => c.json(await service().listCandidates(token(c.req.header('Authorization')), AccessQuerySchema.parse(c.req.query()), c.get('correlationId'))));
  app.get('/v1/members', async c => c.json(await service().listMembers(token(c.req.header('Authorization')), AccessQuerySchema.parse(c.req.query()), c.get('correlationId'))));
  app.get('/v1/member-access/operations', async c => c.json(await service().getOperation(token(c.req.header('Authorization')), AccessOperationQuerySchema.parse(c.req.query()), c.get('correlationId'))));
  app.post('/v1/members/grant', async c => c.json(await service().grant(token(c.req.header('Authorization')), IdempotencyKeySchema.parse(c.req.header('Idempotency-Key')),
    GrantAccessCommandSchema.parse(c.get('requestBody')), c.get('correlationId')), 201));
  app.post('/v1/members/:id/revise-access', async c => c.json(await service().revise(token(c.req.header('Authorization')), IdSchema.parse(c.req.param('id')),
    IdempotencyKeySchema.parse(c.req.header('Idempotency-Key')), ReviseAccessCommandSchema.parse(c.get('requestBody')), c.get('correlationId')), 200));
  app.post('/v1/members/:id/revoke', async c => c.json(await service().revoke(token(c.req.header('Authorization')), IdSchema.parse(c.req.param('id')),
    IdempotencyKeySchema.parse(c.req.header('Idempotency-Key')), RevokeAccessCommandSchema.parse(c.get('requestBody')), c.get('correlationId')), 200));
}
