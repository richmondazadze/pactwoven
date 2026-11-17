import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  commandDigest, supplierRelationshipProposalDigest, supplierScopeCategoryDigest, supplierScopePolicyDigest,
} from '@pactwoven/domain';
import { SupplierAuthenticationEvidenceSchema } from './supplier-relationship-auth-evidence.js';
import { snapshotSupplierPersistenceRequest, type SupplierPrivateRequest } from './supplier-relationship-persistence-schema.js';
import {
  PostgresSupplierAuthenticationRepository, PostgresSupplierRelationshipRepository, type SupplierRecordedCall,
} from './supplier-relationship-repository.js';

// Driver doubles test the adapter boundary only. They do not establish PostgreSQL
// authorization, provider origin, isolation or correctness of the migration.
const NOW = Date.parse('2026-11-16T12:00:00.000Z'), H = 'a'.repeat(64);
const iso = (at: number) => new Date(at).toISOString(), clock = () => iso(NOW);
const pair = { environment: 'simulation' as const, buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier' };
const scope = { ...pair, supplierRelationshipId: 'relationship' };
const actor = () => ({ environment: 'simulation' as const, organizationId: 'buyer', actorId: 'owner', principalKind: 'human' as const,
  membershipId: 'member', membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0,
  subject: 'subject', externalOrganizationId: 'org_buyer', externalMembershipId: 'ext_member', sessionId: 'session' });
const binding = () => ({ reference: { id: 'private_binding', version: 1, hash: H }, environment: 'simulation' as const, effectiveOrganizationId: 'buyer',
  verifier: { oid: 101, name: 'supplier_verifier' }, authorizer: { oid: 102, name: 'supplier_authorizer' },
  status: 'ACTIVE' as const, validFrom: iso(NOW - 3_600_000), expiresAt: iso(NOW + 3_600_000) });
const stamp = { actorId: 'owner', organizationId: 'buyer', membershipId: 'member', membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0 };
const locator = { environment: 'simulation', organizationId: 'buyer', actorId: 'owner' };
const createRequest = (): Extract<SupplierPrivateRequest, { kind: 'relationship-command' }> => ({
  kind: 'relationship-command', purpose: 'supplier_relationship_create', mutation: {
    idempotencyKey: 'relationship_create_original', command: { scope: { ...scope }, expectedVersion: 0, mandateVersion: null,
      authorityEpoch: 0, targetProposal: null, payload: { action: 'create', terms: {
        buyerSiteIds: ['site'], serviceCategoryIds: ['delivery'], expiresAt: iso(NOW + 3_600_000),
      } } },
  },
});
const statusRequest = (): Extract<SupplierPrivateRequest, { kind: 'relationship-status' }> => ({
  kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope: { ...scope }, revision: null },
});
function statusResult() {
  return { kind: 'relationship-status', projection: { kind: 'RELATIONSHIP_STATUS_ONLY', scope, revision: 1,
    proposal: { id: 'relationship', version: 1, hash: H }, status: 'PROPOSED', expiresAt: iso(NOW + 3_600_000), viewerParty: 'buyer',
    current: true, approvalsRecorded: { buyer: false, supplier: false }, relationshipGate: 'BLOCKED', gateReason: 'NOT_ACTIVE',
    authentication: 'NOT_ESTABLISHED', businessVerification: 'NOT_ESTABLISHED', payeeVerification: 'NOT_ESTABLISHED',
    bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false } };
}

async function evidenceFor(request: SupplierPrivateRequest) {
  const who = actor(), principal = binding(), descriptor = await snapshotSupplierPersistenceRequest(request, locator);
  const observation = { subject: who.subject, externalOrganizationId: who.externalOrganizationId, externalMembershipId: who.externalMembershipId,
    externalRole: 'org:admin', sessionId: who.sessionId, authenticatedAt: iso(NOW - 120_000), membershipObservedAt: iso(NOW - 1000),
    issuer: 'https://synthetic.invalid', tokenHash: H, tokenIssuedAt: iso(NOW - 10_000), sessionExpiresAt: iso(NOW + 60_000),
    observedAt: iso(NOW), expiresAt: iso(NOW + 20_000) };
  return SupplierAuthenticationEvidenceSchema.parse({ schemaVersion: 1, id: 'b5f81400-2222-4333-8444-123456789abc',
    actor: who, binding: principal, observedBy: principal.verifier, request: descriptor.request,
    requestDigest: descriptor.requestDigest, mutationDigest: descriptor.mutationDigest,
    observation, observedAt: observation.observedAt, expiresAt: observation.expiresAt,
    ...(descriptor.mutationDigest === null ? { kind: 'identity' } : { kind: 'factors', source: {
      kind: 'CLERK_FVA', tokenHash: H, tokenIssuedAt: observation.tokenIssuedAt, firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0,
      firstFactorAt: iso(NOW - 70_000), secondFactorAt: iso(NOW - 70_000), verifiedAt: iso(NOW - 70_000),
    } }),
  });
}
type Reply = { rows: unknown[]; command?: string };
function driver(reply: unknown, options: {
  safe?: unknown; rows?: unknown[]; commit?: () => Promise<Reply>; rollbackError?: boolean; functionError?: unknown;
} = {}) {
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<Reply> => {
    if (sql.includes(' AS safe')) return { rows: [{ safe: Object.hasOwn(options, 'safe') ? options.safe : true }] };
    if (sql === 'COMMIT') return options.commit ? options.commit() : { rows: [], command: 'COMMIT' };
    if (sql === 'ROLLBACK' && options.rollbackError) throw new Error('private rollback diagnostic');
    if (sql.startsWith('SELECT pactwoven.supplier_')) {
      if (options.functionError !== undefined) throw options.functionError;
      return { rows: options.rows ?? [{ response: typeof reply === 'function' ? await reply(sql, values) : reply }] };
    }
    return { rows: [], command: sql === 'ROLLBACK' ? 'ROLLBACK' : '' };
  });
  const release = vi.fn(), connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, connect, query, release };
}
const functionCalls = (d: ReturnType<typeof driver>) => d.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT pactwoven.supplier_'));
const commands = (d: ReturnType<typeof driver>) => d.query.mock.calls.map(([sql]) => sql);
async function recorded(request: SupplierPrivateRequest) {
  const evidence = await evidenceFor(request);
  const reference = { id: evidence.id, version: 1, hash: await commandDigest({ namespace: 'pactwoven/supplier-private-auth-evidence/v1', evidence }) };
  const verifier = driver(reference);
  const handle = await new PostgresSupplierAuthenticationRepository(verifier.pool, binding(), clock).append(evidence, request, actor());
  return { handle, verifier, evidence, reference };
}
async function relationshipData() {
  const request = createRequest(), descriptor = await snapshotSupplierPersistenceRequest(request, locator);
  if (request.mutation.command.payload.action !== 'create') throw new Error('Fixture requires create.');
  const proposal = { schemaVersion: 1, scope, version: 1, previousVersionHash: null, terms: request.mutation.command.payload.terms,
    createdBy: stamp, createdAt: iso(NOW) };
  const proposalHash = await supplierRelationshipProposalDigest(proposal);
  const head = { scope, revision: 1, proposal: { id: 'relationship', version: 1, hash: proposalHash }, status: 'PROPOSED' };
  const receipt = { identity: { scope, actorId: 'owner', organizationId: 'buyer', idempotencyKey: request.mutation.idempotencyKey },
    commandDigest: descriptor.mutationDigest!, result: head, recordedAt: iso(NOW) };
  const policy = { pair, version: 1, hash: H };
  const policyBinding = { schemaVersion: 1, scope, proposal: head.proposal, policy, producingReceipt: receipt };
  const record = { snapshot: { schemaVersion: 1, revision: 1, proposal, proposalHash, status: 'PROPOSED',
    approvals: { buyer: null, supplier: null }, changedBy: stamp, updatedAt: iso(NOW) }, policyBinding };
  return { request, head, receipt, policy, policyBinding, result: {
    kind: 'relationship-command', outcome: 'APPENDED', receipt: { receipt, policy }, record, currentHead: head,
  } };
}
async function policyData() {
  const category = { id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods.' };
  const request: Extract<SupplierPrivateRequest, { kind: 'policy-command' }> = {
    kind: 'policy-command', purpose: 'supplier_scope_policy_issue', mutation: { idempotencyKey: 'scope_policy_issue_original', command: {
      pair, expectedVersion: 0, predecessor: null, buyerOrganizationVersion: 1, authorityEpoch: 0,
      payload: { action: 'issue', terms: { buyerSiteIds: ['site'], categories: [category], requestedValidityMs: 3_600_000 } },
    } },
  };
  const descriptor = await snapshotSupplierPersistenceRequest(request, locator);
  const policy = { schemaVersion: 1, pair, version: 1, predecessor: null, status: 'ACTIVE', buyerSiteIds: ['site'],
    categories: [{ ...category, definitionHash: await supplierScopeCategoryDigest(pair, category) }],
    issuedAt: iso(NOW), validFrom: iso(NOW), expiresAt: iso(NOW + 3_600_000),
    organizations: { buyer: { externalOrganizationId: 'org_buyer', version: 1, authorityEpoch: 0 }, supplier: { externalOrganizationId: 'org_supplier', version: 1, authorityEpoch: 0 } },
    issuer: { ...stamp, subject: 'subject', externalOrganizationId: 'org_buyer', externalMembershipId: 'ext_member', sessionId: 'session', factorEvidence: { id: 'factors', version: 1, hash: H } },
    commandIdentity: { pair, actorId: 'owner', organizationId: 'buyer', idempotencyKey: request.mutation.idempotencyKey }, commandDigest: descriptor.mutationDigest!,
  };
  const record = { policy, policyHash: await supplierScopePolicyDigest(policy) };
  return { request, record, reference: { pair, version: 1, hash: record.policyHash }, result: {
    kind: 'policy-command', outcome: 'APPENDED', receipt: { identity: policy.commandIdentity, commandDigest: descriptor.mutationDigest!, result: record, recordedAt: iso(NOW) }, current: record,
  } };
}

describe('supplier private recording handles', () => {
  it('records the exact original evidence and exposes only its checked immutable reference', async () => {
    const request = statusRequest(), { handle, verifier, evidence, reference } = await recorded(request);
    expect(handle).toEqual({ reference });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle.reference)).toBe(true);
    expect(functionCalls(verifier)).toEqual([['SELECT pactwoven.supplier_record_evidence($1::jsonb) AS response', [JSON.stringify(evidence)]]]);
    expect(verifier.query.mock.calls.find(([sql]) => sql.includes(' AS safe'))?.[1]).toEqual(['supplier_verifier', 101]);
    expect(commands(verifier).at(-1)).toBe('COMMIT');
    expect(verifier.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('rejects copied handles, references and arbitrary UUID/actor tuples before checkout', async () => {
    const request = statusRequest(), { handle } = await recorded(request), db = driver(statusResult());
    const repository = new PostgresSupplierRelationshipRepository(db.pool, binding(), clock);
    for (const fake of [structuredClone(handle), { reference: handle.reference, actor: actor() }, handle.reference.id, null]) {
      await expect(repository.execute(fake as SupplierRecordedCall, request)).rejects.toMatchObject({ code: 'SUPPLIER_PRIVATE_CALL_REQUIRED' });
    }
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('rejects mismatched expected actor, binding and request before verifier checkout', async () => {
    const request = statusRequest(), evidence = await evidenceFor(request), db = driver(null);
    const repository = new PostgresSupplierAuthenticationRepository(db.pool, binding(), clock);
    await expect(repository.append(evidence, request, { ...actor(), actorId: 'another_owner' })).rejects.toThrow();
    await expect(repository.append(evidence, { ...request, query: { ...request.query, revision: 2 } }, actor())).rejects.toThrow();
    await expect(repository.append({ ...evidence, binding: { ...binding(), reference: { ...binding().reference, version: 2 } } }, request, actor())).rejects.toThrow();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('withholds the handle until commit and rejects a wrong stored evidence hash', async () => {
    const request = statusRequest(), evidence = await evidenceFor(request);
    const reference = { id: evidence.id, version: 1, hash: await commandDigest({ namespace: 'pactwoven/supplier-private-auth-evidence/v1', evidence }) };
    let finish!: (value: Reply) => void, entered!: () => void;
    const enteredCommit = new Promise<void>(resolve => { entered = resolve; });
    const db = driver(reference, { commit: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
    let settled = false;
    const pending = new PostgresSupplierAuthenticationRepository(db.pool, binding(), clock).append(evidence, request, actor()).then(value => { settled = true; return value; });
    await enteredCommit; expect(settled).toBe(false);
    finish({ rows: [], command: 'COMMIT' }); await pending;
    const wrong = driver({ ...reference, hash: 'f'.repeat(64) });
    await expect(new PostgresSupplierAuthenticationRepository(wrong.pool, binding(), clock).append(evidence, request, actor())).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    expect(commands(wrong)).not.toContain('COMMIT');
    expect(wrong.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('snapshots verifier input, expected inputs and private binding before asynchronous work', async () => {
    const request = statusRequest(), evidence = await evidenceFor(request), original = structuredClone(evidence), who = actor(), principal = binding();
    const db = driver({ id: evidence.id, version: 1, hash: await commandDigest({ namespace: 'pactwoven/supplier-private-auth-evidence/v1', evidence }) });
    const repository = new PostgresSupplierAuthenticationRepository(db.pool, principal, clock);
    principal.verifier.name = 'changed_login';
    const pending = repository.append(evidence, request, who);
    evidence.observation.subject = 'changed'; request.query.scope.supplierRelationshipId = 'changed'; who.actorId = 'changed';
    await pending;
    expect(functionCalls(db)[0]?.[1]).toEqual([JSON.stringify(original)]);
    expect(db.query.mock.calls.find(([sql]) => sql.includes(' AS safe'))?.[1]).toEqual(['supplier_verifier', 101]);
  });
});

describe('supplier authorizer transport', () => {
  it('uses the fixed authorizer entry points for all six request families', async () => {
    const relationship = await relationshipData(), policy = await policyData();
    const cases: Array<[SupplierPrivateRequest, unknown, string]> = [
      [relationship.request, relationship.result, 'supplier_relationship_command'],
      [policy.request, policy.result, 'supplier_scope_policy_command'],
      [{ kind: 'policy-read', purpose: 'supplier_scope_policy_read', query: { policy: policy.reference } }, { kind: 'policy-read', record: policy.record }, 'supplier_scope_policy_read'],
      [statusRequest(), statusResult(), 'supplier_relationship_status'],
      [{ kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: { scope } }, { kind: 'relationship-observation-plan', plan: { scope, head: null, approvers: [] } }, 'supplier_relationship_status'],
      [{ kind: 'relationship-recover', purpose: 'supplier_relationship_recover', query: { identity: relationship.receipt.identity, commandDigest: relationship.receipt.commandDigest, action: 'create' } },
        { kind: 'relationship-recover', original: null }, 'supplier_relationship_recover'],
    ];
    for (const [request, result, routine] of cases) {
      const { handle } = await recorded(request), db = driver(result);
      const returned = await new PostgresSupplierRelationshipRepository(db.pool, binding(), clock).execute(handle, request);
      expect(returned).toEqual(result);
      expect(Object.isFrozen(returned)).toBe(true);
      expect(functionCalls(db)).toEqual([[`SELECT pactwoven.${routine}($1::uuid,$2::jsonb) AS response`, [handle.reference.id, JSON.stringify(request)]]]);
      expect(db.query.mock.calls.find(([sql]) => sql.includes(' AS safe'))?.[1]).toEqual(['supplier_authorizer', 102]);
      expect(commands(db).at(-1)).toBe('COMMIT');
      expect(db.release).toHaveBeenCalledExactlyOnceWith(false);
      expect(commands(db).join('\n')).not.toMatch(/set_config|SET ROLE|app\.(tenant|actor)|supplier_access_contexts/i);
    }
  });

  it('rejects request substitution and a different private binding before authorizer checkout', async () => {
    const request = statusRequest(), { handle } = await recorded(request), db = driver(statusResult());
    const repository = new PostgresSupplierRelationshipRepository(db.pool, binding(), clock);
    await expect(repository.execute(handle, { ...request, query: { ...request.query, revision: 2 } })).rejects.toMatchObject({ code: 'SUPPLIER_PRIVATE_CALL_REQUIRED' });
    await expect(new PostgresSupplierRelationshipRepository(db.pool, { ...binding(), reference: { ...binding().reference, version: 2 } }, clock).execute(handle, request)).rejects.toMatchObject({ code: 'SUPPLIER_PRIVATE_CALL_REQUIRED' });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('reserves each handle synchronously and prevents concurrent calls or later reuse', async () => {
    const request = statusRequest(), { handle } = await recorded(request), db = driver(statusResult());
    const repository = new PostgresSupplierRelationshipRepository(db.pool, binding(), clock);
    const first = repository.execute(handle, request);
    await expect(repository.execute(handle, request)).rejects.toMatchObject({ code: 'SUPPLIER_CALL_ALREADY_ATTEMPTED' });
    await first;
    await expect(repository.execute(handle, request)).rejects.toMatchObject({ code: 'SUPPLIER_CALL_ALREADY_ATTEMPTED' });
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(functionCalls(db)).toHaveLength(1);
  });

  it('does not refresh expired evidence or its original factor times', async () => {
    const request = createRequest(), { handle } = await recorded(request), db = driver(null);
    await expect(new PostgresSupplierRelationshipRepository(db.pool, binding(), () => iso(NOW + 20_000)).execute(handle, request)).rejects.toThrow('no longer current');
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('rejects malformed cardinality and leaked private fields before commit', async () => {
    const request = statusRequest();
    for (const rows of [[], [{ response: statusResult() }, { response: statusResult() }], [{}],
      [{ response: { ...statusResult(), projection: { ...statusResult().projection, subject: 'private-subject' } } }],
      [{ response: { ...statusResult(), projection: { ...statusResult().projection, viewerParty: 'supplier' } } }]]) {
      const { handle } = await recorded(request), db = driver(null, { rows });
      await expect(new PostgresSupplierRelationshipRepository(db.pool, binding(), clock).execute(handle, request)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
      expect(commands(db)).not.toContain('COMMIT');
      expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
    }
  });

  it('preserves exact original recovery identity and policy pin without replaying the mutation', async () => {
    const data = await relationshipData();
    const request: Extract<SupplierPrivateRequest, { kind: 'relationship-recover' }> = { kind: 'relationship-recover', purpose: 'supplier_relationship_recover',
      query: { identity: data.receipt.identity, commandDigest: data.receipt.commandDigest, action: 'create' } };
    const result = { kind: 'relationship-recover', original: { mutation: data.request.mutation, receipt: data.result.receipt,
      binding: data.policyBinding, currentHead: { ...data.head, revision: 3, status: 'SUSPENDED' } } };
    const { handle } = await recorded(request), db = driver(result);
    const returned = await new PostgresSupplierRelationshipRepository(db.pool, binding(), clock).execute(handle, request);
    expect(returned.original?.receipt.policy).toEqual(data.policy);
    expect(returned.original?.mutation.idempotencyKey).toBe(data.request.mutation.idempotencyKey);
    expect(functionCalls(db)).toHaveLength(1);
    expect(functionCalls(db)[0]?.[0]).toContain('supplier_relationship_recover');
    const changed = structuredClone(result); changed.original.mutation.idempotencyKey = 'substituted_original_key';
    const bad = driver(changed), next = await recorded(request);
    await expect(new PostgresSupplierRelationshipRepository(bad.pool, binding(), clock).execute(next.handle, request)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    expect(commands(bad)).not.toContain('COMMIT');
  });

  it('keeps the original command receipt on exact replay after later state changes', async () => {
    const data = await relationshipData(), result = { ...data.result, outcome: 'EXACT_REPLAY', currentHead: { ...data.head, revision: 2, status: 'SUSPENDED' } };
    const { handle } = await recorded(data.request), db = driver(result);
    const returned = await new PostgresSupplierRelationshipRepository(db.pool, binding(), clock).execute(handle, data.request);
    expect(returned.receipt).toEqual(data.result.receipt);
    expect(returned.record).toEqual(data.result.record);
    expect(returned.currentHead.revision).toBe(2);
  });

  it('withholds the authorizer result until a successful commit acknowledgement', async () => {
    const request = statusRequest(), { handle } = await recorded(request);
    let finish!: (value: Reply) => void, entered!: () => void;
    const enteredCommit = new Promise<void>(resolve => { entered = resolve; });
    const db = driver(statusResult(), { commit: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
    let settled = false;
    const pending = new PostgresSupplierRelationshipRepository(db.pool, binding(), clock).execute(handle, request).then(value => { settled = true; return value; });
    await enteredCommit; expect(settled).toBe(false);
    finish({ rows: [], command: 'COMMIT' }); await pending;
  });

  it('discards failed checkouts, sanitizes database errors and never retries uncertain commits', async () => {
    const request = statusRequest();
    const cases = [
      { options: { safe: false }, code: 'UNSAFE_DATABASE_ROLE', calls: 0 },
      { options: { safe: null }, code: 'UNSAFE_DATABASE_ROLE', calls: 0 },
      { options: { safe: 'true' }, code: 'UNSAFE_DATABASE_ROLE', calls: 0 },
      { options: { functionError: { code: 'SP001', message: 'private subject and SQL' } }, code: 'SUPPLIER_ACCESS_DENIED', calls: 1 },
      { options: { functionError: new Error('secret connection diagnostic'), rollbackError: true }, code: 'SUPPLIER_OUTCOME_UNKNOWN', calls: 1 },
      { options: { commit: async (): Promise<Reply> => { throw { code: 'SP001', message: 'lost commit reply' }; } }, code: 'SUPPLIER_OUTCOME_UNKNOWN', calls: 1 },
      { options: { commit: async () => ({ rows: [], command: 'ROLLBACK' }) }, code: 'SUPPLIER_OUTCOME_UNKNOWN', calls: 1 },
    ];
    for (const { options, code, calls } of cases) {
      const { handle } = await recorded(request), db = driver(statusResult(), options), original = structuredClone(request);
      const repository = new PostgresSupplierRelationshipRepository(db.pool, binding(), clock);
      const error = await repository.execute(handle, request).catch((value: unknown) => value);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toMatch(/private subject|secret connection|lost commit reply/);
      expect(db.connect).toHaveBeenCalledTimes(1);
      expect(functionCalls(db)).toHaveLength(calls);
      expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(request).toEqual(original);
      await expect(repository.execute(handle, request)).rejects.toMatchObject({ code: 'SUPPLIER_CALL_ALREADY_ATTEMPTED' });
    }
  });

  it('retains the original request and result across caller mutation during asynchronous work', async () => {
    const data = await relationshipData(), request = structuredClone(data.request), { handle } = await recorded(request);
    const original = structuredClone(data.result), db = driver(data.result);
    const repository = new PostgresSupplierRelationshipRepository(db.pool, binding(), clock);
    const pending = repository.execute(handle, request);
    request.mutation.idempotencyKey = 'changed_while_waiting'; request.mutation.command.scope.supplierRelationshipId = 'changed';
    const returned = await pending;
    expect(returned).toEqual(original);
    expect(functionCalls(db)[0]?.[1]).toEqual([handle.reference.id, JSON.stringify(data.request)]);
    data.result.receipt.receipt.identity.idempotencyKey = 'changed_after_return';
    expect(returned.receipt.receipt.identity.idempotencyKey).toBe(data.request.mutation.idempotencyKey);
  });
});
