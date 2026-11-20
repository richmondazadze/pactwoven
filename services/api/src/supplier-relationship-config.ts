import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, InstantSchema } from '@pactwoven/contracts';
import { canonicalJson, immutable } from '@pactwoven/domain';
import { SupplierPrivatePrincipalBindingSchema } from '../../../packages/db/src/supplier-relationship-persistence-schema.js';

const laneSchema = z.strictObject({
  externalOrganizationId: IdSchema,
  verifierDatabaseUrl: z.string().min(1).max(8192), authorizerDatabaseUrl: z.string().min(1).max(8192),
  binding: SupplierPrivatePrincipalBindingSchema,
});
const lanesSchema = z.strictObject({ buyer: laneSchema, supplier: laneSchema });
type Lane = z.infer<typeof laneSchema>;
export type SupplierRelationshipDevelopmentConfiguration = {
  environment: 'development'; issuer: string;
  pair: { environment: 'development'; buyerOrganizationId: string; supplierOrganizationId: string };
  lanes: { buyer: Lane; supplier: Lane };
};
export class SupplierRelationshipConfigurationError extends Error {
  constructor() { super('Invalid supplier development configuration. Check the protected paired bindings.'); }
}
const reservedUrls = [
  'DATABASE_URL', 'PROVISIONER_DATABASE_URL', 'ACCESS_DATABASE_URL', 'MANDATE_DATABASE_URL',
  'CUSTODY_SETUP_WRITER_DATABASE_URL', 'CUSTODY_SETUP_VERIFIER_DATABASE_URL',
  'FINANCIAL_POLICY_AUTHORIZER_DATABASE_URL', 'FINANCIAL_POLICY_VERIFIER_DATABASE_URL',
] as const;
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
function database(input: string): URL {
  const value = new URL(input);
  if (!['postgres:', 'postgresql:'].includes(value.protocol) || value.pathname !== '/pactwoven_dev' ||
    !value.username || !value.password || value.hash) throw new SupplierRelationshipConfigurationError();
  const seen = new Set<string>();
  for (const [key, entry] of value.searchParams) {
    if (seen.has(key) || !['sslmode', 'channel_binding'].includes(key) ||
      (key === 'sslmode' && entry !== 'verify-full') || (key === 'channel_binding' && entry !== 'require')) throw new SupplierRelationshipConfigurationError();
    seen.add(key);
  }
  if (!loopback.has(value.hostname) && (!value.hostname.endsWith('.neon.tech') || value.searchParams.get('sslmode') !== 'verify-full')) {
    throw new SupplierRelationshipConfigurationError();
  }
  return value;
}
function correctBindingHash(binding: Lane['binding']): boolean {
  const { reference: { hash, ...reference }, ...body } = binding;
  return hash === createHash('sha256').update(canonicalJson({ namespace: 'pactwoven/supplier-private-binding/v1',
    binding: { ...body, reference } }), 'utf8').digest('hex');
}

/** Pure protected configuration. Missing configuration disables the feature;
 * parsing neither enrolls principals nor proves the target database's grants. */
export function readSupplierRelationshipDevelopmentConfig(values: Record<string, string | undefined>, now = new Date().toISOString()): SupplierRelationshipDevelopmentConfiguration | undefined {
  if (values.SUPPLIER_RELATIONSHIP_LANES === undefined) return undefined;
  try {
    if ((values.APP_ENVIRONMENT ?? 'development') !== 'development') throw new SupplierRelationshipConfigurationError();
    const at = Date.parse(InstantSchema.parse(now)), raw = z.string().min(1).max(65_536).parse(values.SUPPLIER_RELATIONSHIP_LANES);
    const lanes = lanesSchema.parse(JSON.parse(raw)), base = database(z.string().min(1).parse(values.DATABASE_URL));
    const issuer = z.url().max(2048).parse(values.CLERK_ISSUER), issuerUrl = new URL(issuer);
    if (issuerUrl.origin !== issuer || issuerUrl.protocol !== 'https:' || !issuerUrl.hostname.endsWith('.clerk.accounts.dev')) throw new SupplierRelationshipConfigurationError();
    const names = new Set<string>(), oids = new Set<number>();
    for (const key of reservedUrls) if (values[key] !== undefined) names.add(decodeURIComponent(database(values[key]!).username));
    if (lanes.buyer.externalOrganizationId === lanes.supplier.externalOrganizationId ||
      lanes.buyer.binding.effectiveOrganizationId === lanes.supplier.binding.effectiveOrganizationId ||
      lanes.buyer.binding.reference.id === lanes.supplier.binding.reference.id) throw new SupplierRelationshipConfigurationError();
    for (const lane of [lanes.buyer, lanes.supplier]) {
      const binding = lane.binding;
      if (binding.environment !== 'development' || binding.status !== 'ACTIVE' || Date.parse(binding.validFrom) > at ||
        at >= Date.parse(binding.expiresAt) || !correctBindingHash(binding)) throw new SupplierRelationshipConfigurationError();
      for (const capability of ['verifier', 'authorizer'] as const) {
        const field = capability === 'verifier' ? 'verifierDatabaseUrl' : 'authorizerDatabaseUrl';
        const connection = database(lane[field]), name = decodeURIComponent(connection.username), principal = binding[capability];
        if (connection.host !== base.host || connection.pathname !== base.pathname || name !== principal.name || names.has(name) || oids.has(principal.oid)) {
          throw new SupplierRelationshipConfigurationError();
        }
        names.add(name); oids.add(principal.oid); lane[field] = connection.href;
      }
    }
    return immutable({ environment: 'development', issuer, pair: { environment: 'development',
      buyerOrganizationId: lanes.buyer.binding.effectiveOrganizationId, supplierOrganizationId: lanes.supplier.binding.effectiveOrganizationId }, lanes });
  } catch { throw new SupplierRelationshipConfigurationError(); }
}
