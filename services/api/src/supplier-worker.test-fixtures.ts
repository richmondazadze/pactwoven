import { createHash } from 'node:crypto';
import { canonicalJson, commandDigest, supplierScopeCategoryDigest, supplierScopePolicyCommandDigest } from '@pactwoven/domain';
import { SupplierPrivatePrincipalBindingSchema } from '../../../packages/db/src/supplier-relationship-persistence-schema.js';
import { SupplierRelationshipHttpRequestSchema, SupplierRelationshipHttpResponseSchema, supplierRelationshipHttpRoutes,
  type SupplierRelationshipHttpKind, type SupplierRelationshipHttpRequest } from '../../../packages/contracts/src/supplier-relationship-http.js';
import { supplierWorkerDatabaseBindings, type SupplierWorkerBindings } from './supplier-worker-config.js';

export const workerSupplierNow = Date.parse('2026-11-16T12:00:00.000Z');
export const workerSupplierIssuer = 'https://supplier-worker-fixture.clerk.accounts.dev';
export const workerSupplierToken = 'synthetic.supplier.worker.token';
export const workerSupplierKey = 'supplier_worker_original_key_123';
const iso = (value: number) => new Date(value).toISOString(), hash = 'a'.repeat(64);
const pair = { environment: 'development' as const, buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier' };
const scope = { ...pair, supplierRelationshipId: 'relationship' };
export function rehashWorkerSupplierBinding(input: unknown) {
  const value = SupplierPrivatePrincipalBindingSchema.parse(input), { reference: { hash: _hash, ...reference }, ...body } = value;
  value.reference.hash = createHash('sha256').update(canonicalJson({ namespace: 'pactwoven/supplier-private-binding/v1',
    binding: { ...body, reference } })).digest('hex');
  return value;
}
export function workerSupplierLanes() {
  const lane = (party: string, offset: number) => ({ externalOrganizationId: `org_${party}`, binding: rehashWorkerSupplierBinding({
    reference: { id: `binding_${party}`, version: 1, hash }, environment: 'development', effectiveOrganizationId: party,
    verifier: { name: `pactwoven_dev_supplier_${party}_verifier`, oid: offset + 1 },
    authorizer: { name: `pactwoven_dev_supplier_${party}_authorizer`, oid: offset + 2 },
    status: 'ACTIVE', validFrom: iso(workerSupplierNow - 3_600_000), expiresAt: iso(workerSupplierNow + 3_600_000),
  }) });
  return { buyer: lane('buyer', 100), supplier: lane('supplier', 200) };
}
export function workerSupplierBindings(): SupplierWorkerBindings {
  const values: SupplierWorkerBindings = { APP_ENVIRONMENT: 'development', WORKER_ROLE: 'supplier', ALLOWED_ORIGINS: 'http://localhost:3001',
    CLERK_SECRET_KEY: 'sk_test_local_fixture', CLERK_ISSUER: workerSupplierIssuer,
    CLERK_PUBLISHABLE_KEY: `pk_test_${btoa('supplier-worker-fixture.clerk.accounts.dev$').replace(/=+$/, '')}`,
    SUPPLIER_RELATIONSHIP_LANES: JSON.stringify(workerSupplierLanes()) };
  for (const party of ['buyer', 'supplier'] as const) for (const capability of ['verifier', 'authorizer'] as const) {
    const url = new URL(`postgres://proxy-${party}-${capability}.local:5432/opaque_proxy_database`);
    url.username = 'opaque_proxy_user'; url.password = 'synthetic';
    values[supplierWorkerDatabaseBindings[party][capability]] = { connectionString: url.href,
      host: url.hostname, port: 5432, user: url.username, database: 'opaque_proxy_database' };
  }
  return values;
}
export function workerSupplierObservation(party: 'buyer' | 'supplier' = 'buyer') {
  return { identity: { subject: `user_${party}`, externalOrganizationId: `org_${party}`, externalOrganizationName: party,
    externalMembershipId: `member_${party}`, externalRole: 'org:admin', sessionId: `session_${party}`,
    authenticatedAt: iso(workerSupplierNow - 120_000), membershipObservedAt: iso(workerSupplierNow) },
  observation: { issuer: workerSupplierIssuer, tokenHash: createHash('sha256').update(workerSupplierToken).digest('hex'),
    tokenIssuedAt: iso(workerSupplierNow - 5_000), observedAt: iso(workerSupplierNow), expiresAt: iso(workerSupplierNow + 300_000) } };
}
export function workerSupplierSample(kind: SupplierRelationshipHttpKind = 'relationship-recover'): SupplierRelationshipHttpRequest {
  const query = kind === 'relationship-status' ? { scope, revision: null } : kind === 'policy-read' ? { policy: { pair, version: 1, hash } } :
    { identity: { scope, organizationId: 'buyer', actorId: 'actor', idempotencyKey: workerSupplierKey }, commandDigest: hash, action: 'create' };
  const command = kind === 'policy-command' ? { pair, expectedVersion: 0, predecessor: null, buyerOrganizationVersion: 1, authorityEpoch: 0,
    payload: { action: 'issue', terms: { buyerSiteIds: ['site'], categories: [{ id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods.' }], requestedValidityMs: 60_000 } } } :
    { scope, expectedVersion: 0, mandateVersion: null, authorityEpoch: 0, targetProposal: null,
      payload: { action: 'create', terms: { buyerSiteIds: ['site'], serviceCategoryIds: ['delivery'], expiresAt: iso(workerSupplierNow + 60_000) } } };
  return SupplierRelationshipHttpRequestSchema.parse(kind === 'policy-command' || kind === 'relationship-command' ?
    { kind, mutation: { idempotencyKey: workerSupplierKey, command } } : { kind, query });
}
export async function workerSupplierResult(input: SupplierRelationshipHttpRequest) {
  const head = { scope, revision: 1, proposal: { id: 'relationship', version: 1, hash }, status: 'PROPOSED' };
  let response: unknown;
  switch (input.kind) {
    case 'relationship-recover': response = { kind: input.kind, original: null }; break;
    case 'relationship-status': response = { kind: input.kind, projection: { ...head, revision: input.query.revision ?? 1,
      kind: 'RELATIONSHIP_STATUS_ONLY', expiresAt: iso(workerSupplierNow + 60_000), viewerParty: 'buyer', current: true,
      approvalsRecorded: { buyer: false, supplier: false }, relationshipGate: 'BLOCKED', gateReason: 'NOT_ACTIVE',
      authentication: 'NOT_ESTABLISHED', businessVerification: 'NOT_ESTABLISHED', payeeVerification: 'NOT_ESTABLISHED',
      bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false } }; break;
    case 'relationship-command': {
      const identity = { scope, organizationId: 'buyer', actorId: 'actor', idempotencyKey: input.mutation.idempotencyKey };
      response = { kind: input.kind, outcome: 'APPENDED', receipt: { identity,
        commandDigest: await commandDigest({ namespace: 'pactwoven/supplier-relationship-command/v1', identity, command: input.mutation.command }),
        result: head, recordedAt: iso(workerSupplierNow - 1000) }, currentHead: head }; break;
    }
    case 'policy-read': {
      const category = { id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods.' };
      response = { kind: input.kind, policy: { reference: input.query.policy, predecessor: null, status: 'ACTIVE', buyerSiteIds: ['site'],
        categories: [{ ...category, definitionHash: await supplierScopeCategoryDigest(pair, category) }],
        issuedAt: iso(workerSupplierNow - 1000), validFrom: iso(workerSupplierNow - 1000), expiresAt: iso(workerSupplierNow + 59_000) } }; break;
    }
    case 'policy-command': {
      const reference = { pair, version: 1, hash };
      response = { kind: input.kind, outcome: 'APPENDED', receipt: {
        identity: { pair, organizationId: 'buyer', actorId: 'actor', idempotencyKey: input.mutation.idempotencyKey },
        commandDigest: await supplierScopePolicyCommandDigest(input.mutation, 'actor'), result: reference, recordedAt: iso(workerSupplierNow - 1000),
      }, current: reference }; break;
    }
  }
  return SupplierRelationshipHttpResponseSchema.parse(response);
}
export function workerSupplierPublicRequest(input = workerSupplierSample()) {
  return new Request(`https://api.example${supplierRelationshipHttpRoutes[input.kind]}`, { method: 'POST',
    headers: { Authorization: `Bearer ${workerSupplierToken}`, 'Content-Type': 'application/json',
      ...('mutation' in input ? { 'Idempotency-Key': input.mutation.idempotencyKey } : {}),
      'X-Actor-Id': 'untrusted_actor', 'X-Mfa-Verified': 'true' },
    body: JSON.stringify('mutation' in input ? input.mutation.command : input.query) });
}
