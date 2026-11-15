import { Hono } from 'hono';
import { z } from 'zod';
import { CreateResponsibilityCommandSchema, OrganizationBootstrapCommandSchema, IdempotencyKeySchema, IdSchema, PageQuerySchema, SCHEMA_VERSION, type AccessRecoveryGateway, type MandateGateway, type Session } from '@pactwoven/contracts';
import type { FoundationRepository, OrganizationProvisioner, VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import type { IdentityVerifier } from './auth.js';
import type { AccessGateway } from './access-service.js';
import { registerAccessRoutes } from './access-routes.js';
import { registerMandateRoutes } from './mandate-routes.js';
import { registerAccessRecoveryRoutes } from './access-recovery-routes.js';
import { custodySetupBodyLimit, readCustodySetupJson, registerCustodySetupRoutes } from './custody-setup-routes.js';
import type { CustodySetupGateway } from './custody-setup-service.js';

export type AppDependencies = {
  repository?: FoundationRepository;
  provisioner?: OrganizationProvisioner;
  verifyIdentity?: IdentityVerifier;
  accessGateway?: AccessGateway;
  mandateGateway?: MandateGateway;
  accessRecoveryGateway?: AccessRecoveryGateway;
  custodySetupGateway?: CustodySetupGateway;
  allowedOrigins: readonly string[];
};
export type ApiEnv = { Variables: { session: Session; identity: VerifiedIdentity; correlationId: string; requestBody: unknown } };
const allowedRequestHeaders = ['authorization', 'content-type', 'idempotency-key', 'x-correlation-id'];
const maximumBodyBytes = 64 * 1024;
const bodyDeadlineMilliseconds = 5_000;

async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 415, 'Send a JSON request body.');
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBodyBytes)) {
    throw new DomainError('BODY_TOO_LARGE', 413, 'The request body exceeds the allowed size.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError('VALIDATION_FAILED', 422, 'A JSON request body is required.');
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DomainError('REQUEST_TIMEOUT', 408, 'The request body took too long to arrive.')), bodyDeadlineMilliseconds);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBodyBytes) {
        throw new DomainError('BODY_TOO_LARGE', 413, 'The request body exceeds the allowed size.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof DomainError) throw error;
    throw new DomainError('VALIDATION_FAILED', 422, 'The request body is not valid JSON.');
  } finally { clearTimeout(timer!); reader.releaseLock(); }
}

export function createApp(dependencies: AppDependencies) {
  const app = new Hono<ApiEnv>();
  const origins = new Set(dependencies.allowedOrigins);
  if (origins.has('*')) throw new Error('A wildcard API origin is not allowed.');

  app.use('*', async (c, next) => {
    const suppliedId = c.req.header('X-Correlation-Id');
    const correlationId = suppliedId && /^[A-Za-z0-9_-]{1,128}$/.test(suppliedId) ? suppliedId : crypto.randomUUID();
    c.set('correlationId', correlationId);
    c.header('X-Correlation-Id', correlationId);
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Vary', 'Origin');
    const origin = c.req.header('Origin');
    if (origin) {
      if (!origins.has(origin)) throw new DomainError('FORBIDDEN', 403, 'This origin cannot access the API.');
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Expose-Headers', 'X-Correlation-Id, Location');
    }
    if (c.req.method === 'OPTIONS') {
      if (!origin) throw new DomainError('FORBIDDEN', 403, 'An allowed origin is required.');
      const method = c.req.header('Access-Control-Request-Method');
      const headers = (c.req.header('Access-Control-Request-Headers') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (!method || !['GET', 'POST'].includes(method) || headers.some(header => !allowedRequestHeaders.includes(header))) {
        throw new DomainError('FORBIDDEN', 403, 'This cross-origin request is not permitted.');
      }
      c.header('Access-Control-Allow-Methods', 'GET, POST');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Correlation-Id');
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }
    await next();
  });

  app.get('/health', c => c.json({ service: 'pactwoven-api', status: 'alive', schemaVersion: SCHEMA_VERSION }));

  app.use('/v1/*', async (c, next) => {
    if (!dependencies.verifyIdentity) {
      throw new DomainError('SETUP_REQUIRED', 503, 'Development identity and database access are not configured.');
    }
    const authorization = c.req.header('Authorization') ?? '';
    const token = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(authorization)?.[1];
    if (!token) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in to continue.');
    // Read the bounded body before the final live authorization lookup. A slow
    // upload must not preserve a session/member authorization that has expired.
    if (c.req.method === 'POST') {
      const custodyLimit = custodySetupBodyLimit(c.req.method, new URL(c.req.url).pathname);
      c.set('requestBody', custodyLimit === undefined
        ? await readJson(c.req.raw)
        : await readCustodySetupJson(c.req.raw, custodyLimit));
    }
    const identity = await dependencies.verifyIdentity(token);
    c.set('identity', identity);
    await next();
  });

  app.post('/v1/organizations/bootstrap', async c => {
    if (!dependencies.provisioner) throw new DomainError('SETUP_REQUIRED', 503, 'Organization setup is not configured.');
    const identity = c.get('identity');
    if (identity.externalRole !== 'org:admin') throw new DomainError('FORBIDDEN', 403, 'An organization administrator must finish setup.');
    const command = OrganizationBootstrapCommandSchema.parse(c.get('requestBody'));
    const key = IdempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    const operation = await dependencies.provisioner.bootstrapOrganization(identity, key, command, c.get('correlationId'));
    c.header('Location', '/v1/session');
    return c.json(operation, 201);
  });

  registerAccessRoutes(app, dependencies.accessGateway);
  registerAccessRecoveryRoutes(app, dependencies.accessRecoveryGateway);
  registerMandateRoutes(app, dependencies.mandateGateway);
  registerCustodySetupRoutes(app, dependencies.custodySetupGateway);

  app.use('/v1/*', async (c, next) => {
    if (!dependencies.repository) throw new DomainError('SETUP_REQUIRED', 503, 'Development database access is not configured.');
    const session = await dependencies.repository.getSession(c.get('identity'), c.get('correlationId'));
    c.set('session', session);
    await next();
  });

  app.get('/v1/session', c => c.json(c.get('session')));
  app.get('/v1/responsibilities', async c => {
    const query = PageQuerySchema.parse(c.req.query());
    return c.json(await dependencies.repository!.listResponsibilities(c.get('session').actor, query));
  });
  app.get('/v1/responsibilities/:id', async c => {
    const id = IdSchema.parse(c.req.param('id'));
    return c.json(await dependencies.repository!.getResponsibility(c.get('session').actor, id));
  });
  app.post('/v1/responsibilities', async c => {
    const idempotencyKey = IdempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    const command = CreateResponsibilityCommandSchema.parse(c.get('requestBody'));
    const operation = await dependencies.repository!.createResponsibility(c.get('session').actor, idempotencyKey, command);
    c.header('Location', `/v1/responsibilities/${encodeURIComponent(operation.aggregateId)}`);
    return c.json(operation, 201);
  });

  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found.', correlationId: c.get('correlationId') } }, 404));
  app.onError((error, c) => {
    const correlationId = c.get('correlationId') ?? crypto.randomUUID();
    if (error instanceof DomainError) {
      return c.json({ error: { code: error.code, message: error.message, correlationId, ...(error.fields ? { fields: error.fields } : {}) } }, error.status);
    }
    if (error instanceof z.ZodError) {
      const fields: Record<string, string[]> = {};
      for (const issue of error.issues) (fields[issue.path.join('.') || 'request'] ??= []).push(issue.message);
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'Check the highlighted request fields.', correlationId, fields } }, 422);
    }
    // Database/SDK exception strings may contain credentials or private values.
    return c.json({ error: { code: 'DURABLE_SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Your request has not been confirmed.', correlationId } }, 503);
  });
  return app;
}
