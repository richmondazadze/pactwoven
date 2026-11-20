import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, InstantSchema } from '@pactwoven/contracts';
import { canonicalJson, immutable } from '@pactwoven/domain';
import { SupplierPrivatePrincipalBindingSchema } from '../../../packages/db/src/supplier-relationship-persistence-schema.js';
import { readDatabaseBinding, WorkerConfigurationError, type HyperdriveBinding } from './worker-config.js';

export const supplierWorkerDatabaseBindings = Object.freeze({
  buyer: { verifier: 'SUPPLIER_BUYER_VERIFIER_DATABASE', authorizer: 'SUPPLIER_BUYER_AUTHORIZER_DATABASE' },
  supplier: { verifier: 'SUPPLIER_SUPPLIER_VERIFIER_DATABASE', authorizer: 'SUPPLIER_SUPPLIER_AUTHORIZER_DATABASE' },
} as const);
export type SupplierWorkerBindings = Record<string, unknown>;
const laneSchema = z.strictObject({ externalOrganizationId: IdSchema, binding: SupplierPrivatePrincipalBindingSchema });
const lanesSchema = z.strictObject({ buyer: laneSchema, supplier: laneSchema });
const databaseSchema = z.custom<HyperdriveBinding>(value => typeof value === 'object' && value !== null);
const bindingsSchema = z.strictObject({
  APP_ENVIRONMENT: z.literal('development'), WORKER_ROLE: z.literal('supplier'),
  ALLOWED_ORIGINS: z.string().min(1).max(16_384),
  CLERK_SECRET_KEY: z.string().regex(/^sk_test_[A-Za-z0-9_-]+$/),
  CLERK_PUBLISHABLE_KEY: z.string().regex(/^pk_test_[A-Za-z0-9_-]+$/),
  CLERK_ISSUER: z.url().max(2048), SUPPLIER_RELATIONSHIP_LANES: z.string().min(1).max(65_536),
  SUPPLIER_BUYER_VERIFIER_DATABASE: databaseSchema, SUPPLIER_BUYER_AUTHORIZER_DATABASE: databaseSchema,
  SUPPLIER_SUPPLIER_VERIFIER_DATABASE: databaseSchema, SUPPLIER_SUPPLIER_AUTHORIZER_DATABASE: databaseSchema,
});

/** Private deployment data contains bindings, never caller-provided identity.
 * Proxy metadata cannot prove Neon origin identity; each opened pool and every
 * supplier transaction independently check the actual origin principal. */
export function readSupplierWorkerConfig(input: SupplierWorkerBindings, now = new Date().toISOString()) {
  try {
    const values = bindingsSchema.parse(input), at = Date.parse(InstantSchema.parse(now));
    const allowedOrigins = values.ALLOWED_ORIGINS.split(',');
    if (new Set(allowedOrigins).size !== allowedOrigins.length) throw new WorkerConfigurationError();
    for (const origin of allowedOrigins) {
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password || (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new WorkerConfigurationError();
    }
    const issuer = values.CLERK_ISSUER, issuerUrl = new URL(issuer);
    if (issuerUrl.origin !== issuer || issuerUrl.protocol !== 'https:' || !issuerUrl.hostname.endsWith('.clerk.accounts.dev') ||
        atob(values.CLERK_PUBLISHABLE_KEY.slice(8)) !== `${issuerUrl.hostname}$`) throw new WorkerConfigurationError();
    const lanes = lanesSchema.parse(JSON.parse(values.SUPPLIER_RELATIONSHIP_LANES));
    if (lanes.buyer.externalOrganizationId === lanes.supplier.externalOrganizationId ||
        lanes.buyer.binding.effectiveOrganizationId === lanes.supplier.binding.effectiveOrganizationId ||
        lanes.buyer.binding.reference.id === lanes.supplier.binding.reference.id) throw new WorkerConfigurationError();
    const names = new Set<string>(), oids = new Set<number>(), connections = new Set<string>();
    const connectionStrings = { buyer: { verifier: '', authorizer: '' }, supplier: { verifier: '', authorizer: '' } };
    for (const party of ['buyer', 'supplier'] as const) {
      const binding = lanes[party].binding, { reference: { hash, ...reference }, ...body } = binding;
      if (binding.environment !== 'development' || binding.status !== 'ACTIVE' || Date.parse(binding.validFrom) > at ||
          at >= Date.parse(binding.expiresAt) || hash !== createHash('sha256').update(canonicalJson({
            namespace: 'pactwoven/supplier-private-binding/v1', binding: { ...body, reference },
          }), 'utf8').digest('hex')) throw new WorkerConfigurationError();
      for (const capability of ['verifier', 'authorizer'] as const) {
        const principal = binding[capability];
        const connection = readDatabaseBinding(values[supplierWorkerDatabaseBindings[party][capability]]);
        const canonical = new URL(connection).href;
        if (names.has(principal.name) || oids.has(principal.oid) || connections.has(canonical)) throw new WorkerConfigurationError();
        names.add(principal.name); oids.add(principal.oid); connections.add(canonical);
        connectionStrings[party][capability] = connection;
      }
    }
    return immutable({ environment: 'development' as const, issuer, secretKey: values.CLERK_SECRET_KEY, allowedOrigins,
      pair: { environment: 'development' as const, buyerOrganizationId: lanes.buyer.binding.effectiveOrganizationId,
        supplierOrganizationId: lanes.supplier.binding.effectiveOrganizationId }, lanes, connectionStrings });
  } catch { throw new WorkerConfigurationError(); }
}
