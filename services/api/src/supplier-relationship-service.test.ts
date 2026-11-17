import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { Pool } from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandDigest, supplierRelationshipProposalDigest, supplierScopeCategoryDigest, supplierScopePolicyDigest } from '@pactwoven/domain';
import { snapshotSupplierPersistenceRequest, type SupplierPrivateRequest } from '../../../packages/db/src/supplier-relationship-persistence-schema.js';
import type { SupplierAuthenticationEvidence } from '../../../packages/db/src/supplier-relationship-auth-evidence.js';
import { createSupplierRelationshipService } from './supplier-relationship-service.js';

const sdk = vi.hoisted(() => ({ session: vi.fn(), membership: vi.fn() }));
vi.mock('@clerk/backend', async importOriginal => ({
  ...await importOriginal<typeof import('@clerk/backend')>(),
  createClerkClient: vi.fn(() => ({ sessions: { getSession: sdk.session }, organizations: { getOrganizationMembershipList: sdk.membership } })),
}));
// Composition tests use genuine signed-token verification and real observer,
// recorder and authorizer modules, with controlled SDK/driver boundaries. They
// establish neither live provider acceptance nor native SQL authorization.
const NOW = Date.parse('2026-11-16T12:00:00.000Z'), H = 'a'.repeat(64);
const issuer = 'https://pactwoven-test.clerk.accounts.dev', origin = 'http://localhost:3001';
const iso = (at: number) => new Date(at).toISOString();
const pair = { environment: 'simulation' as const, buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier' };
const scope = { ...pair, supplierRelationshipId: 'relationship' };
const actor = () => ({ environment: 'simulation' as const, organizationId: 'buyer', actorId: 'member_buyer', membershipId: 'member_buyer',
  principalKind: 'human' as const, membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0,
  subject: 'user_buyer', externalOrganizationId: 'org_buyer', externalMembershipId: 'ext_buyer', sessionId: 'session_buyer' });
const stamp = () => ({ actorId: 'member_buyer', organizationId: 'buyer', membershipId: 'member_buyer', membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0 });
const binding = () => ({ reference: { id: 'binding', version: 1, hash: H }, environment: 'simulation' as const, effectiveOrganizationId: 'buyer',
  verifier: { oid: 101, name: 'supplier_verifier' }, authorizer: { oid: 102, name: 'supplier_authorizer' },
  status: 'ACTIVE' as const, validFrom: iso(NOW - 3_600_000), expiresAt: iso(NOW + 3_600_000) });
const statusInput = () => ({ kind: 'relationship-status', query: { scope: { ...scope }, revision: null } });
function memberPage(party: string) {
  return { totalCount: 1, data: [{ id: `ext_${party}`, role: 'org:admin', organization: { id: `org_${party}`, name: party }, publicUserData: { userId: `user_${party}` } }] };
}
const head = () => ({ scope, revision: 1, proposal: { id: 'relationship', version: 1, hash: H }, status: 'PROPOSED' });
const plan = () => ({ kind: 'relationship-observation-plan', plan: { scope, head: head(), approvers: [] } });
function statusResult() {
  return { kind: 'relationship-status', projection: { ...head(), kind: 'RELATIONSHIP_STATUS_ONLY', expiresAt: iso(NOW + 3_600_000), viewerParty: 'buyer',
    current: true, approvalsRecorded: { buyer: false, supplier: false }, relationshipGate: 'BLOCKED', gateReason: 'NOT_ACTIVE',
    authentication: 'NOT_ESTABLISHED', businessVerification: 'NOT_ESTABLISHED', payeeVerification: 'NOT_ESTABLISHED',
    bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false } };
}
let privateKey: KeyObject, publicPem: string;
function token() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'local_test_key', cat: 'cl_B7d4PD111AAA' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'user_buyer', sid: 'session_buyer', iss: issuer, azp: origin,
    iat: NOW / 1000 - 5, nbf: NOW / 1000 - 5, exp: NOW / 1000 + 60, v: 2, o: { id: 'org_buyer', rol: 'admin' }, fva: [0, 0] })).toString('base64url');
  return `${header}.${body}.${sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
}
beforeAll(() => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }); privateKey = keys.privateKey;
  publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  sdk.membership.mockReset().mockImplementation(async ({ organizationId }: { organizationId: string }) => memberPage(organizationId.slice(4)));
  sdk.session.mockReset().mockImplementation(async () => ({ id: 'session_buyer', userId: 'user_buyer', status: 'active', expireAt: NOW + 60_000,
    createdAt: NOW - 3_600_000, actor: null, lastActiveOrganizationId: 'org_buyer' }));
});
afterEach(() => vi.useRealTimers());

type Reply = { rows: unknown[]; command?: string };
type Role = 'verifier' | 'authorizer';
type Stage = 'setup' | 'observer' | 'recorder' | 'authorizer';
function fixture(options: {
  response?: (request: SupplierPrivateRequest, evidence: SupplierAuthenticationEvidence) => unknown | Promise<unknown>;
  observer?: () => unknown;
  recorderHash?: string;
  commit?: (role: Role, stage: Stage) => Reply | Promise<Reply>;
} = {}) {
  const evidence: SupplierAuthenticationEvidence[] = [], requests: SupplierPrivateRequest[] = [], events: string[] = [];
  const pools = (role: Role) => {
    const connect = vi.fn(async () => {
      let stage: Stage = 'setup';
      return { release: vi.fn(), query: vi.fn(async (sql: string, values?: string[]): Promise<Reply> => {
        if (sql.includes(' AS safe')) return { rows: [{ safe: true }] };
        if (sql === 'COMMIT') { events.push(`${role}:${stage}:commit`); return options.commit ? options.commit(role, stage) : { rows: [], command: 'COMMIT' }; }
        if (sql.includes('supplier_resolve_observer')) { stage = 'observer'; events.push('observer'); return { rows: [{ response: options.observer ? options.observer() : actor() }] }; }
        if (sql.includes('supplier_record_evidence')) {
          stage = 'recorder'; events.push('recorder');
          const value = JSON.parse(values![0]!) as SupplierAuthenticationEvidence; evidence.push(value);
          const hash = options.recorderHash ?? await commandDigest({ namespace: 'pactwoven/supplier-private-auth-evidence/v1', evidence: value });
          return { rows: [{ response: { id: value.id, version: 1, hash } }] };
        }
        if (sql.startsWith('SELECT pactwoven.supplier_')) {
          stage = 'authorizer'; events.push('authorizer');
          const request = JSON.parse(values![1]!) as SupplierPrivateRequest; requests.push(request);
          const recorded = evidence.find(entry => entry.id === values![0]);
          if (!recorded) throw new Error('The test driver requires committed in-process evidence.');
          const response = options.response ? await options.response(request, recorded) : request.kind === 'relationship-observation-plan' ? plan() : statusResult();
          return { rows: [{ response }] };
        }
        return { rows: [] };
      }) };
    });
    return { pool: { connect } as unknown as Pool, connect };
  };
  const verifier = pools('verifier'), authorizer = pools('authorizer');
  const configuration = { clerk: { secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
    observer: { environment: 'simulation' as const, issuer, binding: binding() }, verifierPool: verifier.pool, authorizerPool: authorizer.pool };
  return { service: createSupplierRelationshipService(configuration), configuration, evidence, requests, events, verifier, authorizer };
}

async function relationshipFixture(approve = false) {
  const terms = { buyerSiteIds: ['site'], serviceCategoryIds: ['delivery'], expiresAt: iso(NOW + 3_600_000) };
  const proposal = { schemaVersion: 1, scope, version: 1, previousVersionHash: null, terms, createdBy: stamp(), createdAt: iso(approve ? NOW - 10_000 : NOW) };
  const proposalHash = await supplierRelationshipProposalDigest(proposal), reference = { id: 'relationship', version: 1, hash: proposalHash };
  const mutation = { idempotencyKey: approve ? 'supplier_approve_original' : 'supplier_create_original', command: {
    scope, expectedVersion: approve ? 1 : 0, mandateVersion: null, authorityEpoch: 0, targetProposal: approve ? reference : null,
    payload: approve ? { action: 'approve', expiresAt: terms.expiresAt } : { action: 'create', terms },
  } };
  const request = { kind: 'relationship-command', purpose: approve ? 'supplier_relationship_approve' : 'supplier_relationship_create', mutation } as SupplierPrivateRequest;
  const descriptor = await snapshotSupplierPersistenceRequest(request, { environment: 'simulation', organizationId: 'buyer', actorId: 'member_buyer' });
  const resultHead = { scope, revision: approve ? 2 : 1, proposal: reference, status: 'PROPOSED' };
  const receipt = { identity: { scope, actorId: 'member_buyer', organizationId: 'buyer', idempotencyKey: mutation.idempotencyKey },
    commandDigest: descriptor.mutationDigest!, result: resultHead, recordedAt: iso(NOW) };
  const producingReceipt = approve ? { ...receipt, identity: { ...receipt.identity, idempotencyKey: 'original_create_key' }, commandDigest: H,
    result: { ...resultHead, revision: 1 }, recordedAt: proposal.createdAt } : receipt;
  const policy = { pair, version: 1, hash: H };
  const policyBinding = { schemaVersion: 1, scope, proposal: reference, policy, producingReceipt };
  const record = { snapshot: { schemaVersion: 1, revision: resultHead.revision, proposal, proposalHash, status: 'PROPOSED',
    approvals: { buyer: approve ? { ...stamp(), party: 'buyer', proposal: reference, approvedAt: iso(NOW), expiresAt: terms.expiresAt } : null, supplier: null },
    changedBy: stamp(), updatedAt: iso(NOW) }, policyBinding };
  return { input: { kind: 'relationship-command', mutation }, request, receipt, policy, policyBinding,
    result: { kind: 'relationship-command', outcome: 'APPENDED', receipt: { receipt, policy }, record, currentHead: resultHead } };
}

describe('private supplier API composition', () => {
  it('uses separate genuine plan and final authentication with committed recording before every authorizer attempt', async () => {
    const f = fixture(), result = await f.service.submit(token(), statusInput());
    expect(result).toEqual(statusResult());
    expect(f.evidence.map(entry => [entry.kind, entry.request.purpose])).toEqual([
      ['identity', 'supplier_relationship_observation_plan'], ['identity', 'supplier_relationship_status'],
    ]);
    expect(f.events).toEqual(['observer', 'verifier:observer:commit', 'recorder', 'verifier:recorder:commit', 'authorizer', 'authorizer:authorizer:commit',
      'observer', 'verifier:observer:commit', 'recorder', 'verifier:recorder:commit', 'authorizer', 'authorizer:authorizer:commit']);
    expect(sdk.session).toHaveBeenCalledTimes(2);
    for (const forbidden of ['observationPlan', 'externalMembershipId', 'tokenHash', 'binding', 'org_buyer']) expect(JSON.stringify(result)).not.toContain(forbidden);
  });

  it.each(['purpose', 'actor', 'binding', 'evidence', 'approvers', 'handle'])('rejects a caller-supplied %s before provider or database work', async field => {
    const f = fixture();
    await expect(f.service.submit(token(), { ...statusInput(), [field]: {} })).rejects.toMatchObject({ code: 'SUPPLIER_INPUT_INVALID' });
    expect(sdk.membership).not.toHaveBeenCalled(); expect(f.verifier.connect).not.toHaveBeenCalled();
  });

  it('keeps the exact original mutation and captured configuration across a provider await', async () => {
    const original = await relationshipFixture(), input = structuredClone(original.input), f = fixture({ response: () => original.result });
    let release!: (value: ReturnType<typeof memberPage>) => void;
    let entered!: () => void;
    const reachedMembership = new Promise<void>(resolve => { entered = resolve; });
    sdk.membership.mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    const pending = f.service.submit(token(), input);
    await reachedMembership;
    input.mutation.idempotencyKey = 'changed_original_key'; input.mutation.command.authorityEpoch = 99;
    f.configuration.clerk.issuer = 'https://changed.invalid'; f.configuration.observer.binding.authorizer.name = 'changed';
    release(memberPage('buyer'));
    const result = await pending;
    expect(f.requests).toEqual([original.request]); expect(f.evidence[0]?.request).toEqual(original.request);
    expect(result).toMatchObject({ receipt: original.receipt });
  });

  it('refuses a foreign observer actor before recording any evidence', async () => {
    const f = fixture({ observer: () => ({ ...actor(), externalMembershipId: 'foreign' }) });
    await expect(f.service.submit(token(), statusInput())).rejects.toMatchObject({ code: 'SUPPLIER_VERIFICATION_UNAVAILABLE' });
    expect(f.evidence).toHaveLength(0); expect(f.authorizer.connect).not.toHaveBeenCalled();
  });

  it.each(['bad-hash', 'missing-commit'] as const)('never reaches the authorizer after recorder %s', async failure => {
    const original = await relationshipFixture();
    const f = fixture({ response: () => original.result,
      ...(failure === 'bad-hash' ? { recorderHash: 'f'.repeat(64) } : { commit: (_role: Role, stage: Stage) => ({ rows: [], command: stage === 'recorder' ? '' : 'COMMIT' }) }),
    });
    await expect(f.service.submit(token(), original.input)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    expect(f.evidence).toHaveLength(1); expect(f.authorizer.connect).not.toHaveBeenCalled();
  });

  it('preserves an unknown authorizer commit outcome and makes no automatic retry', async () => {
    const original = await relationshipFixture(), f = fixture({ response: () => original.result,
      commit: (role, stage) => { if (role === 'authorizer' && stage === 'authorizer') throw new Error('PRIVATE_COMMIT_DIAGNOSTIC'); return { rows: [], command: 'COMMIT' }; },
    });
    await expect(f.service.submit(token(), original.input)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN',
      message: 'The supplier result is unconfirmed. Preserve the exact original request and use explicit recovery.' });
    expect(f.requests).toEqual([original.request]); expect(f.evidence).toHaveLength(1);
  });

  it.each([20_000, 20_001])('rechecks original freshness after a %i ms recorder acknowledgement', async delay => {
    const original = await relationshipFixture(), f = fixture({ response: () => original.result,
      commit: (_role, stage) => { if (stage === 'recorder') vi.setSystemTime(NOW + delay); return { rows: [], command: 'COMMIT' }; },
    });
    const pending = f.service.submit(token(), original.input);
    if (delay === 20_000) await expect(pending).resolves.toMatchObject({ receipt: original.receipt });
    else { await expect(pending).rejects.toMatchObject({ code: 'SUPPLIER_OBSERVATION_EXPIRED' }); expect(f.requests).toHaveLength(0); }
    expect(f.evidence[0]?.observation.observedAt).toBe(iso(NOW));
  });

  it('retains an acknowledged historical mutation receipt if freshness elapses during final commit acknowledgement', async () => {
    const original = await relationshipFixture(), f = fixture({ response: () => original.result,
      commit: (role, stage) => { if (role === 'authorizer' && stage === 'authorizer') vi.setSystemTime(NOW + 20_001); return { rows: [], command: 'COMMIT' }; },
    });
    const result = await f.service.submit(token(), original.input);
    expect(result).toEqual({ kind: 'relationship-command', outcome: 'APPENDED', receipt: original.receipt, currentHead: original.result.currentHead });
    expect(result).not.toHaveProperty('relationshipGate'); expect(result).not.toHaveProperty('record');
  });

  it('allows an empty preflight plan but continues to refuse ordinary status of a nonexistent relationship', async () => {
    const f = fixture({ response: request => {
      if (request.kind === 'relationship-observation-plan') return { kind: request.kind, plan: { scope, head: null, approvers: [] } };
      throw { code: 'SP001' };
    } });
    await expect(f.service.submit(token(), statusInput())).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    expect(f.requests.map(request => request.kind)).toEqual(['relationship-observation-plan', 'relationship-status']);
  });

  it('preserves exact old approval replay across a newer head without relabeling current approvers', async () => {
    const original = await relationshipFixture(true), currentHead = { ...original.result.currentHead, revision: 3, status: 'ACTIVE' };
    const approvals = (['buyer', 'supplier'] as const).map(party => ({ approval: { ...stamp(), actorId: `member_${party}`, membershipId: `member_${party}`,
      organizationId: party, party, proposal: currentHead.proposal, approvedAt: iso(NOW), expiresAt: iso(NOW + 60_000) },
      externalOrganizationId: `org_${party}`, externalMembershipId: `ext_${party}`, subject: `user_${party}` }));
    const f = fixture({ response: request => request.kind === 'relationship-observation-plan' ? { kind: request.kind, plan: { scope, head: currentHead, approvers: approvals } } :
      { ...original.result, outcome: 'EXACT_REPLAY', currentHead } });
    const result = await f.service.submit(token(), original.input);
    expect(result).toEqual({ kind: 'relationship-command', outcome: 'EXACT_REPLAY', receipt: original.receipt, currentHead });
    expect(f.requests[1]).toEqual(original.request); expect(f.evidence[1]?.approvers).toBeUndefined();
    expect(sdk.membership).toHaveBeenCalledTimes(2);
  });

  it('preserves stored mutation, original receipt and later head during explicit recovery', async () => {
    const original = await relationshipFixture(), currentHead = { ...original.result.currentHead, revision: 2, status: 'SUSPENDED' };
    const f = fixture({ response: () => ({ kind: 'relationship-recover', original: { mutation: original.input.mutation,
      receipt: original.result.receipt, binding: original.policyBinding, currentHead } }) });
    const input = { kind: 'relationship-recover', query: { identity: original.receipt.identity, commandDigest: original.receipt.commandDigest, action: 'create' } };
    const result = await f.service.submit(token(), input);
    expect(result).toEqual({ kind: 'relationship-recover', original: { mutation: original.input.mutation, receipt: original.receipt, currentHead } });
    expect(f.evidence[0]?.kind).toBe('identity'); expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('binding'); expect(JSON.stringify(result)).not.toContain('externalMembershipId');
  });

  it('refuses a recovery locator for another actor before recording', async () => {
    const original = await relationshipFixture(), f = fixture();
    await expect(f.service.submit(token(), { kind: 'relationship-recover', query: { identity: { ...original.receipt.identity, actorId: 'foreign' },
      commandDigest: original.receipt.commandDigest, action: 'create' } })).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    expect(f.evidence).toHaveLength(0);
  });

  it('verifies original approvers before final acting verification, including explicit-current revision', async () => {
    const privatePlan = plan(), old = { ...stamp(), party: 'supplier', organizationId: 'supplier', actorId: 'member_supplier', membershipId: 'member_supplier',
      proposal: privatePlan.plan.head.proposal, approvedAt: iso(NOW - 5_000), expiresAt: iso(NOW + 60_000) };
    const f = fixture({ response: request => request.kind === 'relationship-observation-plan' ? { ...privatePlan, plan: { ...privatePlan.plan,
      approvers: [{ approval: old, externalOrganizationId: 'org_supplier', externalMembershipId: 'ext_supplier', subject: 'user_supplier' }] } } :
      { ...statusResult(), projection: { ...statusResult().projection, approvalsRecorded: { buyer: false, supplier: true } } } });
    await f.service.submit(token(), { kind: 'relationship-status', query: { scope, revision: 1 } });
    expect(sdk.membership.mock.calls.map(([query]) => query.organizationId)).toEqual(['org_buyer', 'org_supplier', 'org_buyer']);
    expect(f.evidence[1]?.approvers?.[0]?.approval).toEqual(old);
    expect(f.evidence[1]?.expiresAt).toBe(f.evidence[1]?.approvers?.[0]?.observation.expiresAt);
  });

  it('refuses final acting identity changes after preflight instead of borrowing its actor', async () => {
    let observers = 0;
    const f = fixture({ observer: () => ({ ...actor(), membershipVersion: ++observers }) });
    await expect(f.service.submit(token(), statusInput())).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    expect(f.evidence).toHaveLength(1); expect(f.requests).toHaveLength(1);
  });

  it('returns only policy references and original receipt identity, never a private policy issuer', async () => {
    const category = { id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods.' };
    const mutation = { idempotencyKey: 'original_policy_issue_key', command: { pair, expectedVersion: 0, predecessor: null, buyerOrganizationVersion: 1,
      authorityEpoch: 0, payload: { action: 'issue', terms: { buyerSiteIds: ['site'], categories: [category], requestedValidityMs: 60_000 } } } };
    const request = { kind: 'policy-command', purpose: 'supplier_scope_policy_issue', mutation } as SupplierPrivateRequest;
    const descriptor = await snapshotSupplierPersistenceRequest(request, { environment: 'simulation', organizationId: 'buyer', actorId: 'member_buyer' });
    const policy = { schemaVersion: 1, pair, version: 1, predecessor: null, status: 'ACTIVE', buyerSiteIds: ['site'],
      categories: [{ ...category, definitionHash: await supplierScopeCategoryDigest(pair, category) }],
      issuedAt: iso(NOW), validFrom: iso(NOW), expiresAt: iso(NOW + 60_000), organizations: {
        buyer: { externalOrganizationId: 'org_buyer', version: 1, authorityEpoch: 0 }, supplier: { externalOrganizationId: 'org_supplier', version: 1, authorityEpoch: 0 } },
      issuer: { ...stamp(), subject: 'user_buyer', externalOrganizationId: 'org_buyer', externalMembershipId: 'ext_buyer', sessionId: 'session_buyer', factorEvidence: { id: 'private_factor', version: 1, hash: H } },
      commandIdentity: { pair, actorId: 'member_buyer', organizationId: 'buyer', idempotencyKey: mutation.idempotencyKey }, commandDigest: descriptor.mutationDigest!,
    };
    const record = { policy, policyHash: await supplierScopePolicyDigest(policy) }, reference = { pair, version: 1, hash: '' };
    reference.hash = record.policyHash;
    const f = fixture({ response: r => r.kind === 'policy-read' ? { kind: r.kind, record } : { kind: 'policy-command', outcome: 'APPENDED',
      receipt: { identity: policy.commandIdentity, commandDigest: descriptor.mutationDigest!, recordedAt: iso(NOW), result: record }, current: record } });
    const written = await f.service.submit(token(), { kind: 'policy-command', mutation });
    expect(written).toMatchObject({ receipt: { result: reference }, current: reference });
    expect(await f.service.submit(token(), { kind: 'policy-read', query: { policy: reference } })).toEqual({ kind: 'policy-read', policy: reference });
    for (const privateField of ['issuer', 'factorEvidence', 'externalOrganizationId', 'private_factor', 'categories']) expect(JSON.stringify(written)).not.toContain(privateField);
  });
});
