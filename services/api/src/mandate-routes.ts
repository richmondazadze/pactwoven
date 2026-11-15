import type { Hono } from 'hono';
import { CreateMandateDocumentRequestSchema, IdempotencyKeySchema, IdSchema, MandateAuthorityIntentSchema,
  MandateCollectionQuerySchema, MandateDecisionIntentSchema, MandateDocumentQuerySchema, MandateOperationQuerySchema, MandateReviewQuerySchema,
  ProposeMandateCommandSchema, type MandateGateway } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';

export function registerMandateRoutes(app: Hono<ApiEnv>, gateway: MandateGateway | undefined): void {
  const service = () => { if (!gateway) throw new DomainError('SETUP_REQUIRED', 503, 'Mandate management is not configured.'); return gateway; };
  const token = (authorization: string | undefined) => {
    const value = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(authorization ?? '')?.[1];
    if (!value) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.');
    return value;
  };
  const query = (url: string) => {
    const entries = [...new URL(url).searchParams];
    if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new DomainError('VALIDATION_FAILED', 422, 'Each mandate query field must appear once.');
    return Object.fromEntries(entries);
  };
  const mutationKey = (header: string | undefined, url: string) => {
    if (new URL(url).search) throw new DomainError('VALIDATION_FAILED', 422, 'Mandate changes do not accept query fields.');
    return IdempotencyKeySchema.parse(header);
  };
  app.get('/v1/responsibilities/:id/mandates', async c => c.json(await service().list(token(c.req.header('Authorization')), IdSchema.parse(c.req.param('id')),
    MandateCollectionQuerySchema.parse(query(c.req.url)), c.get('correlationId'))));
  app.get('/v1/responsibilities/:id/mandates/:proposalId', async c => c.json(await service().review(token(c.req.header('Authorization')), IdSchema.parse(c.req.param('id')),
    IdSchema.parse(c.req.param('proposalId')), MandateReviewQuerySchema.parse(query(c.req.url)), c.get('correlationId'))));
  app.get('/v1/mandate-operations', async c => c.json(await service().operation(token(c.req.header('Authorization')), MandateOperationQuerySchema.parse(query(c.req.url)), c.get('correlationId'))));
  app.get('/v1/responsibilities/:id/mandate-policy-documents/:documentId', async c => c.json(await service().readDocument(token(c.req.header('Authorization')), IdSchema.parse(c.req.param('id')),
    IdSchema.parse(c.req.param('documentId')), MandateDocumentQuerySchema.parse(query(c.req.url)), c.get('correlationId'))));
  app.post('/v1/responsibilities/:id/mandate-policy-documents', async c => c.json(await service().createDocument(token(c.req.header('Authorization')), IdSchema.parse(c.req.param('id')),
    mutationKey(c.req.header('Idempotency-Key'), c.req.url), CreateMandateDocumentRequestSchema.parse(c.get('requestBody')), c.get('correlationId')), 201));
  app.post('/v1/responsibilities/:id/mandate-proposals', async c => c.json(await service().propose(token(c.req.header('Authorization')), IdSchema.parse(c.req.param('id')),
    mutationKey(c.req.header('Idempotency-Key'), c.req.url), ProposeMandateCommandSchema.parse(c.get('requestBody')), c.get('correlationId')), 201));
  app.post('/v1/responsibilities/:id/mandate-proposals/:proposalId/decision', async c => c.json(await service().decide(token(c.req.header('Authorization')), IdSchema.parse(c.req.param('id')),
    IdSchema.parse(c.req.param('proposalId')), mutationKey(c.req.header('Idempotency-Key'), c.req.url), MandateDecisionIntentSchema.parse(c.get('requestBody')), c.get('correlationId'))));
  app.post('/v1/responsibilities/:id/mandates/:mandateId/authority', async c => c.json(await service().control(token(c.req.header('Authorization')), IdSchema.parse(c.req.param('id')),
    IdSchema.parse(c.req.param('mandateId')), mutationKey(c.req.header('Idempotency-Key'), c.req.url), MandateAuthorityIntentSchema.parse(c.get('requestBody')), c.get('correlationId'))));
}
