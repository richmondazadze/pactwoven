import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/domain';
import { SupplierPrivatePrincipalBindingSchema } from '../../../packages/db/src/supplier-relationship-persistence-schema.js';
import { supplierWorkerDatabaseBindings } from './supplier-worker-config.js';

const id = z.string().regex(/^[a-f0-9]{32}$/).refine(value => value !== '0'.repeat(32));
const configSchema = z.strictObject({
  $schema: z.string(), name: z.string(), main: z.string(), compatibility_date: z.literal('2026-11-14'),
  compatibility_flags: z.tuple([z.literal('nodejs_compat')]), workers_dev: z.boolean(), preview_urls: z.literal(false),
  routes: z.tuple([]), send_metrics: z.literal(false), observability: z.strictObject({ enabled: z.literal(false) }),
  vars: z.strictObject({ APP_ENVIRONMENT: z.literal('development'), WORKER_ROLE: z.enum(['api', 'provisioner', 'mandate']),
    ALLOWED_ORIGINS: z.string().min(1), EXPECTED_DATABASE_USER: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional(),
    EXPECTED_ACCESS_DATABASE_USER: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional(),
    EXPECTED_MANDATE_DATABASE_USER: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional() }),
  services: z.array(z.strictObject({ binding: z.string(), service: z.string() })).optional(),
  hyperdrive: z.array(z.strictObject({ binding: z.enum(['DATABASE', 'ACCESS_DATABASE', 'MANDATE_DATABASE']), id })).min(1).max(2),
});
const financialDatabaseNames = ['FINANCIAL_POLICY_AUTHORIZER_DATABASE', 'FINANCIAL_POLICY_VERIFIER_DATABASE',
  'CUSTODY_SETUP_WRITER_DATABASE', 'CUSTODY_SETUP_VERIFIER_DATABASE'] as const;
const principalName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const financialConfigSchema = configSchema.extend({
  vars: z.strictObject({ APP_ENVIRONMENT: z.literal('development'), WORKER_ROLE: z.literal('financial'),
    ALLOWED_ORIGINS: z.string().min(1),
    EXPECTED_FINANCIAL_POLICY_AUTHORIZER_DATABASE_USER: principalName,
    EXPECTED_FINANCIAL_POLICY_VERIFIER_DATABASE_USER: principalName,
    EXPECTED_CUSTODY_SETUP_WRITER_DATABASE_USER: principalName,
    EXPECTED_CUSTODY_SETUP_VERIFIER_DATABASE_USER: principalName }),
  hyperdrive: z.array(z.strictObject({ binding: z.enum(financialDatabaseNames), id })).length(4),
});
const supplierDatabaseNames = [supplierWorkerDatabaseBindings.buyer.verifier, supplierWorkerDatabaseBindings.buyer.authorizer,
  supplierWorkerDatabaseBindings.supplier.verifier, supplierWorkerDatabaseBindings.supplier.authorizer] as const;
const supplierConfigSchema = configSchema.extend({
  vars: z.strictObject({ APP_ENVIRONMENT: z.literal('development'), WORKER_ROLE: z.literal('supplier'),
    ALLOWED_ORIGINS: z.string().min(1).max(16_384), SUPPLIER_RELATIONSHIP_LANES: z.string().min(1).max(65_536) }),
  hyperdrive: z.array(z.strictObject({ binding: z.enum(supplierDatabaseNames), id })).length(4),
});
const supplierLaneSchema = z.strictObject({ externalOrganizationId: IdSchema, binding: SupplierPrivatePrincipalBindingSchema });
const supplierLanesSchema = z.strictObject({ buyer: supplierLaneSchema, supplier: supplierLaneSchema });
const encryptedSecretSchema = z.strictObject({ name: z.string(), type: z.literal('secret_text') });

/** Deployment pins the same private JSON shape/hash/interval as the runtime.
 * This cannot attest a current DB binding or Clerk membership; runtime checks do. */
function supplierDeploymentUsers(json: string): Record<typeof supplierDatabaseNames[number], string> {
  try {
    const lanes = supplierLanesSchema.parse(JSON.parse(json)), now = Date.now();
    if (lanes.buyer.externalOrganizationId === lanes.supplier.externalOrganizationId ||
        lanes.buyer.binding.effectiveOrganizationId === lanes.supplier.binding.effectiveOrganizationId ||
        lanes.buyer.binding.reference.id === lanes.supplier.binding.reference.id) throw new Error();
    const names = new Set<string>(), oids = new Set<number>();
    const users = {} as Record<typeof supplierDatabaseNames[number], string>;
    for (const party of ['buyer', 'supplier'] as const) {
      const binding = lanes[party].binding, { reference: { hash, ...reference }, ...body } = binding;
      if (binding.environment !== 'development' || binding.status !== 'ACTIVE' || Date.parse(binding.validFrom) > now ||
          now >= Date.parse(binding.expiresAt) || hash !== createHash('sha256').update(canonicalJson({
            namespace: 'pactwoven/supplier-private-binding/v1', binding: { ...body, reference },
          }), 'utf8').digest('hex')) throw new Error();
      for (const capability of ['verifier', 'authorizer'] as const) {
        const principal = binding[capability], name = principalName.parse(principal.name);
        if (names.has(name) || oids.has(principal.oid)) throw new Error();
        names.add(name); oids.add(principal.oid); users[supplierWorkerDatabaseBindings[party][capability]] = name;
      }
    }
    return users;
  } catch { throw new Error('Supplier Worker identity lanes are incomplete or unsafe.'); }
}
const hyperdriveSchema = z.object({
  id, caching: z.object({ disabled: z.literal(true) }),
  origin: z.object({ database: z.literal('pactwoven_dev'), user: z.string(),
    scheme: z.enum(['postgres', 'postgresql']), host: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+neon\.tech$/),
    port: z.literal(5432) }),
  origin_connection_limit: z.number().int().min(5).max(10),
  mtls: z.object({ sslmode: z.literal('verify-full') }),
});

/** Consume fresh control-plane observations before deploy; runtime bindings do
 * not reveal caching or origin TLS configuration. Never print input values. */
export function assertDevelopmentWorkerDeployment(input: unknown): void {
  const parsed = z.object({ api: configSchema, provisioner: configSchema, mandate: configSchema,
    financial: financialConfigSchema.optional(), supplier: supplierConfigSchema.optional(), hyperdrives: z.array(hyperdriveSchema),
    workerSecrets: z.strictObject({ api: z.array(z.string()), provisioner: z.array(z.string()), mandate: z.array(z.string()),
      financial: z.array(z.string()).optional(), supplier: z.array(encryptedSecretSchema).optional() }),
  }).safeParse(input);
  if (!parsed.success) throw new Error('Development Worker deployment configuration is incomplete or unsafe.');
  const { api, provisioner, mandate, financial, supplier, hyperdrives, workerSecrets } = parsed.data;
  const publicNames = ['CLERK_ISSUER', 'CLERK_PUBLISHABLE_KEY'];
  const privateNames = [...publicNames, 'CLERK_SECRET_KEY'];
  for (const [actual, expected] of [[workerSecrets.api, publicNames], [workerSecrets.provisioner, privateNames], [workerSecrets.mandate, privateNames]]) {
    if (actual!.length !== expected!.length || new Set(actual).size !== actual!.length || expected!.some(name => !actual!.includes(name))) {
      throw new Error('Development Worker secret placement is invalid.');
    }
  }
  if (financial ? !workerSecrets.financial || workerSecrets.financial.length !== privateNames.length ||
    new Set(workerSecrets.financial).size !== privateNames.length || privateNames.some(name => !workerSecrets.financial!.includes(name))
    : workerSecrets.financial !== undefined) throw new Error('Financial Worker secret placement is invalid.');
  if (supplier ? !workerSecrets.supplier || workerSecrets.supplier.length !== privateNames.length ||
    new Set(workerSecrets.supplier.map(secret => secret.name)).size !== privateNames.length ||
    privateNames.some(name => !workerSecrets.supplier!.some(secret => secret.name === name))
    : workerSecrets.supplier !== undefined) throw new Error('Supplier Worker encrypted secret placement is invalid.');
  if (api.name !== 'pactwoven-api-development' || api.main !== 'src/worker.ts' || api.vars.WORKER_ROLE !== 'api' || !api.workers_dev ||
      provisioner.name !== 'pactwoven-provisioner-development' || provisioner.main !== 'src/provisioner-worker.ts' ||
      provisioner.vars.WORKER_ROLE !== 'provisioner' || provisioner.workers_dev || provisioner.services?.length ||
      api.services?.length !== 2 + Number(Boolean(financial)) + Number(Boolean(supplier)) ||
      api.services.filter(binding => binding.binding === 'IDENTITY_PROVISIONER' && binding.service === provisioner.name).length !== 1 ||
      api.services.filter(binding => binding.binding === 'MANDATE_AUTHORITY' && binding.service === mandate.name).length !== 1 ||
      !api.vars.EXPECTED_DATABASE_USER || !provisioner.vars.EXPECTED_DATABASE_USER ||
      api.vars.EXPECTED_MANDATE_DATABASE_USER !== undefined || provisioner.vars.EXPECTED_MANDATE_DATABASE_USER !== undefined ||
      mandate.name !== 'pactwoven-mandate-development' || mandate.main !== 'src/mandate-worker.ts' ||
      mandate.vars.WORKER_ROLE !== 'mandate' || mandate.workers_dev || mandate.services?.length ||
      mandate.vars.EXPECTED_DATABASE_USER !== undefined || mandate.vars.EXPECTED_ACCESS_DATABASE_USER !== undefined ||
      !mandate.vars.EXPECTED_MANDATE_DATABASE_USER || mandate.hyperdrive.length !== 1 || mandate.hyperdrive[0]?.binding !== 'MANDATE_DATABASE' ||
      api.vars.EXPECTED_ACCESS_DATABASE_USER !== undefined || !provisioner.vars.EXPECTED_ACCESS_DATABASE_USER ||
      new Set([api.vars.EXPECTED_DATABASE_USER, provisioner.vars.EXPECTED_DATABASE_USER, provisioner.vars.EXPECTED_ACCESS_DATABASE_USER, mandate.vars.EXPECTED_MANDATE_DATABASE_USER]).size !== 4 ||
      api.vars.ALLOWED_ORIGINS !== provisioner.vars.ALLOWED_ORIGINS || api.vars.ALLOWED_ORIGINS !== mandate.vars.ALLOWED_ORIGINS ||
      api.hyperdrive.length !== 1 || api.hyperdrive[0]?.binding !== 'DATABASE' || provisioner.hyperdrive.length !== 2 ||
      provisioner.hyperdrive.filter(binding => binding.binding === 'DATABASE').length !== 1 ||
      provisioner.hyperdrive.filter(binding => binding.binding === 'ACCESS_DATABASE').length !== 1 ||
      new Set([...api.hyperdrive, ...provisioner.hyperdrive, ...mandate.hyperdrive].map(binding => binding.id)).size !== 4) {
    throw new Error('Development Worker service isolation is invalid.');
  }
  for (const config of [api, provisioner, mandate]) {
    for (const binding of config.hyperdrive) {
      const matches = hyperdrives.filter(resource => resource.id === binding.id);
      const user = binding.binding === 'MANDATE_DATABASE' ? config.vars.EXPECTED_MANDATE_DATABASE_USER
        : binding.binding === 'ACCESS_DATABASE' ? config.vars.EXPECTED_ACCESS_DATABASE_USER : config.vars.EXPECTED_DATABASE_USER;
      if (matches.length !== 1 || matches[0]?.origin.user !== user) {
        throw new Error('Development Hyperdrive role binding does not match the observed resource.');
      }
    }
    const origins = config.vars.ALLOWED_ORIGINS.split(',');
    if (origins.length !== new Set(origins).size) throw new Error('Development Worker origins are invalid.');
    for (const origin of origins) {
      try {
        const url = new URL(origin);
        if (url.origin !== origin || (url.protocol !== 'https:' &&
            !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error();
      } catch { throw new Error('Development Worker origins are invalid.'); }
    }
  }
  const resources = [...api.hyperdrive, ...provisioner.hyperdrive, ...mandate.hyperdrive].map(binding => hyperdrives.find(resource => resource.id === binding.id)!);
  if (financial) {
    if (financial.name !== 'pactwoven-financial-development' || financial.main !== 'src/financial-worker.ts' || financial.workers_dev ||
        financial.services?.length || financial.vars.ALLOWED_ORIGINS !== api.vars.ALLOWED_ORIGINS ||
        api.services?.filter(service => service.binding === 'FINANCIAL_AUTHORITY' && service.service === financial.name).length !== 1 ||
        new Set(financial.hyperdrive.map(binding => binding.binding)).size !== financialDatabaseNames.length) {
      throw new Error('Financial Worker service isolation is invalid.');
    }
    const existingUsers = [api.vars.EXPECTED_DATABASE_USER, provisioner.vars.EXPECTED_DATABASE_USER,
      provisioner.vars.EXPECTED_ACCESS_DATABASE_USER, mandate.vars.EXPECTED_MANDATE_DATABASE_USER];
    const users = financialDatabaseNames.map(name => financial.vars[`EXPECTED_${name}_USER`]);
    if (new Set([...existingUsers, ...users]).size !== 8 ||
        new Set([...resources.map(resource => resource.id), ...financial.hyperdrive.map(binding => binding.id)]).size !== 8) {
      throw new Error('Financial Worker database principals must remain distinct.');
    }
    for (const binding of financial.hyperdrive) {
      const matches = hyperdrives.filter(resource => resource.id === binding.id);
      if (matches.length !== 1 || matches[0]!.origin.user !== financial.vars[`EXPECTED_${binding.binding}_USER`]) {
        throw new Error('Financial Hyperdrive origin does not match its private role.');
      }
      resources.push(matches[0]!);
    }
  }
  if (supplier) {
    if (supplier.name !== 'pactwoven-supplier-development' || supplier.main !== 'src/supplier-worker.ts' || supplier.workers_dev ||
        supplier.services?.length || supplier.vars.ALLOWED_ORIGINS !== api.vars.ALLOWED_ORIGINS ||
        api.services?.filter(service => service.binding === 'SUPPLIER_AUTHORITY' && service.service === supplier.name).length !== 1 ||
        new Set(supplier.hyperdrive.map(binding => binding.binding)).size !== supplierDatabaseNames.length) {
      throw new Error('Supplier Worker service isolation is invalid.');
    }
    const expectedUsers = supplierDeploymentUsers(supplier.vars.SUPPLIER_RELATIONSHIP_LANES), users = Object.values(expectedUsers);
    if (new Set([...resources.map(resource => resource.origin.user), ...users]).size !== resources.length + supplierDatabaseNames.length ||
        new Set([...resources.map(resource => resource.id), ...supplier.hyperdrive.map(binding => binding.id)]).size !== resources.length + supplierDatabaseNames.length) {
      throw new Error('Supplier Worker database principals must remain distinct.');
    }
    for (const binding of supplier.hyperdrive) {
      const matches = hyperdrives.filter(resource => resource.id === binding.id);
      if (matches.length !== 1 || matches[0]!.origin.user !== expectedUsers[binding.binding]) {
        throw new Error('Supplier Hyperdrive origin does not match its private role.');
      }
      resources.push(matches[0]!);
    }
  }
  if (new Set(resources.map(resource => resource.origin.host)).size !== 1) throw new Error('Development Worker databases must be the same dedicated development database.');
}
