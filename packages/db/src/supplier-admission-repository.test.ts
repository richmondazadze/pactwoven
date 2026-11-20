import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { commandDigest } from '@pactwoven/domain';
import { supplierAdmissionLimitations, supplierAdministratorGrantDigest, supplierEnrollmentPublicRequestDigest, supplierEnrollmentReviewDigest } from '@pactwoven/contracts';
import { PostgresSupplierAdmissionEvidenceRepository, PostgresSupplierAdmissionRepository, type SupplierAdmissionRecordedCall } from './supplier-admission-repository.js';
import { SupplierAdmissionEvidenceSchema, snapshotSupplierAdmissionEvidence, supplierAdmissionCandidateDigest, supplierAdmissionLaneDigest,
  supplierAdmissionRequestDigest, type SupplierAdmissionPrivateRequest, type SupplierAdmissionConfiguration } from './supplier-admission-persistence-schema.js';

// Driver doubles establish codec/transport behavior, never provider authenticity,
// PostgreSQL permissions, locking or a committed supplier authority grant.
const NOW = Date.parse('2026-11-17T18:00:00.000Z'), H = 'a'.repeat(64);
const instant = (at: number) => new Date(at).toISOString(), clock = () => instant(NOW);
const actor = { actorId: 'owner', membershipId: 'owner', membershipVersion: 1, environment: 'development' as const,
  organizationId: 'supplier', organizationVersion: 1, organizationEpoch: 0, principalKind: 'human' as const,
  subject: 'subject', externalOrganizationId: 'external_supplier', externalMembershipId: 'external_member', sessionId: 'session' };
const pin = { actorId: actor.actorId, membershipId: actor.membershipId, membershipVersion: 1 };
const contextRequest: SupplierAdmissionPrivateRequest = { kind: 'context', purpose: 'supplier_admission_context', query: {} };
function context() {
  return { schemaVersion: 1, kind: 'SUPPLIER_ADMISSION_CONTEXT', environment: 'development', party: 'supplier',
    organization: { id: 'supplier', version: 1, authorityEpoch: 0, name: 'Supplier', status: 'ACTIVE' }, viewer: pin,
    administration: { owner: true, supplierAdministrator: false, grant: null }, enrollment: { state: 'REVIEWABLE', blockers: [] },
    observation: { observedAt: instant(NOW), expiresAt: instant(NOW + 20_000) }, limitations: supplierAdmissionLimitations };
}
async function fixture(command = false) {
  const binding = { reference: { id: 'supplier_binding', version: 1, hash: H }, environment: 'development' as const, effectiveOrganizationId: 'supplier',
    verifier: { name: 'supplier_verifier', oid: 101 }, authorizer: { name: 'supplier_authorizer', oid: 102 }, status: 'ACTIVE' as const,
    validFrom: instant(NOW - 3_600_000), expiresAt: instant(NOW + 3_600_000) };
  const config: SupplierAdmissionConfiguration = { issuer: 'https://synthetic.invalid', binding, lane: {
    schemaVersion: 1, reference: { id: 'lane', version: 1, hash: H }, environment: 'development', buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier',
    buyerBinding: { id: 'buyer_binding', version: 1, hash: H }, supplierBinding: binding.reference, status: 'ACTIVE', validFrom: binding.validFrom, expiresAt: binding.expiresAt,
  } };
  config.lane.reference.hash = await supplierAdmissionLaneDigest(config.lane);
  const target = { reference: { id: 'candidate', version: 1, hash: H }, principalKind: 'human' as const, displayName: 'Synthetic owner', observation: {
    issuer: config.issuer, subject: actor.subject, externalOrganizationId: actor.externalOrganizationId, externalMembershipId: actor.externalMembershipId,
    externalRole: 'org:admin', status: 'ACTIVE' as const, observedAt: instant(NOW), expiresAt: instant(NOW + 20_000),
  } };
  target.reference.hash = await supplierAdmissionCandidateDigest(target, actor.environment, actor.organizationId);
  const material = { schemaVersion: 1 as const, role: 'supplier_admin' as const,
    selection: { action: 'grant' as const, candidate: target.reference, expiresAt: instant(NOW + 600_000) },
    basis: { environment: 'development' as const, organization: { id: 'supplier', version: 1, authorityEpoch: 0 }, issuer: pin,
      target: { candidate: target.reference, member: pin }, previousGrant: null, observation: { observedAt: instant(NOW - 1000), expiresAt: instant(NOW + 19_000) } },
    targetDisplayName: target.displayName, previousGrant: null };
  const mutation = { idempotencyKey: 'supplier_original_key_001', command: {
    schemaVersion: 1 as const, role: 'supplier_admin' as const, selection: material.selection, basis: material.basis, reviewHash: await supplierEnrollmentReviewDigest(material),
  } };
  const request: SupplierAdmissionPrivateRequest = command ? { kind: 'enrollment-command', purpose: 'supplier_administrator_grant', mutation } : contextRequest;
  const observation = { subject: actor.subject, externalOrganizationId: actor.externalOrganizationId, externalMembershipId: actor.externalMembershipId,
    externalRole: 'org:admin', sessionId: actor.sessionId, authenticatedAt: instant(NOW - 120_000), membershipObservedAt: instant(NOW),
    issuer: config.issuer, tokenHash: H, tokenIssuedAt: instant(NOW - 1000), sessionExpiresAt: instant(NOW + 300_000), observedAt: instant(NOW), expiresAt: instant(NOW + 20_000) };
  const evidence = SupplierAdmissionEvidenceSchema.parse({ schemaVersion: 1, id: 'b5f81400-2222-4333-8444-123456789abc', actor, binding, lane: config.lane, request,
    requestDigest: await supplierAdmissionRequestDigest(request, actor), mutationDigest: command ? await supplierEnrollmentPublicRequestDigest(mutation) : null,
    observation, target: command ? target : null, observedAt: observation.observedAt, expiresAt: observation.expiresAt,
    ...(command ? { kind: 'factors', source: { kind: 'CLERK_FVA', tokenHash: H, tokenIssuedAt: observation.tokenIssuedAt,
      firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0, firstFactorAt: instant(NOW - 61_000), secondFactorAt: instant(NOW - 61_000), verifiedAt: instant(NOW - 61_000) } } : { kind: 'identity' }),
  });
  const reference = { id: evidence.id, version: 1, hash: await commandDigest({ namespace: 'pactwoven/supplier-admission-evidence/v1', evidence }) };
  const record = { schemaVersion: 1 as const, id: 'grant', environment: 'development' as const, organizationId: 'supplier', role: 'supplier_admin' as const,
    version: 1, predecessor: null, action: 'grant' as const, status: 'ACTIVE' as const, target: { ...pin, membershipVersion: 2 }, issuer: pin,
    organizationVersion: 2, authorityEpoch: 1, issuedAt: instant(NOW), validFrom: instant(NOW), expiresAt: material.selection.expiresAt };
  const grant = { record, reference: { id: record.id, version: 1, hash: await supplierAdministratorGrantDigest(record) } };
  const identity = { environment: 'development' as const, organizationId: 'supplier', actorId: 'owner', idempotencyKey: mutation.idempotencyKey };
  const publicRequestHash = await supplierEnrollmentPublicRequestDigest(mutation);
  const response = { kind: 'SUPPLIER_ENROLLMENT_COMMAND', outcome: 'APPENDED', request: { identity, action: 'grant', target: material.basis.target, previousGrant: null, publicRequestHash },
    observation: { observedAt: instant(NOW), expiresAt: instant(NOW + 20_000) }, current: { status: 'AVAILABLE', grant },
    original: { exactPublicMutation: mutation, receipt: { identity, action: 'grant', publicRequestHash, result: grant, recordedAt: instant(NOW) } }, limitations: supplierAdmissionLimitations };
  return { config, evidence, reference, request, target, mutation, response };
}
type Reply = { rows: unknown[]; command?: string };
function driver(reply: unknown, options: { safe?: unknown; rows?: unknown[]; error?: unknown; commit?: () => Promise<Reply>; releaseError?: boolean } = {}) {
  const query = vi.fn(async (sql: string): Promise<Reply> => {
    if (sql.includes(' AS safe')) return { rows: [{ safe: Object.hasOwn(options, 'safe') ? options.safe : true }] };
    if (sql === 'COMMIT') return options.commit ? options.commit() : { command: 'COMMIT', rows: [] };
    if (sql.startsWith('SELECT pactwoven.supplier_admission_')) {
      if (options.error !== undefined) throw options.error;
      return { rows: options.rows ?? [{ response: reply }] };
    }
    return { rows: [] };
  });
  const release = vi.fn(() => { if (options.releaseError) throw new Error('private release error'); });
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, query, release, connect };
}
async function recorded(command = false) {
  const data = await fixture(command), verifier = driver(data.reference);
  const handle = await new PostgresSupplierAdmissionEvidenceRepository(verifier.pool, data.config, clock).append(data.evidence, data.request, actor);
  return { ...data, handle, verifier };
}
const effects = (db: ReturnType<typeof driver>) => db.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT pactwoven.supplier_admission_'));

describe('supplier admission private codec', () => {
  it('snapshots immutable exact bytes while denying provider and persistence claims', async () => {
    const data = await fixture(true), snapshot = await snapshotSupplierAdmissionEvidence(data.evidence, data.request, actor, data.config, clock());
    expect(snapshot).toMatchObject({ authentication: 'NOT_ESTABLISHED', providerVerification: 'NOT_ESTABLISHED', persistence: 'NOT_ESTABLISHED' });
    expect(Object.isFrozen(snapshot.evidence.actor)).toBe(true);
    expect(snapshot.digest).toBe(data.reference.hash);
    data.evidence.actor.actorId = 'changed_after_snapshot';expect(snapshot.evidence.actor.actorId).toBe('owner');
  });
  it('keeps candidate identity stable across observations but binds provider organization/member/subject and reference', async () => {
    const { target } = await fixture(true), digest = target.reference.hash;
    expect(await supplierAdmissionCandidateDigest({ ...target, displayName: 'Updated display', observation: { ...target.observation,
      observedAt: instant(NOW + 1000), expiresAt: instant(NOW + 21_000) } }, 'development', 'supplier')).toBe(digest);
    for (const field of ['issuer', 'subject', 'externalOrganizationId', 'externalMembershipId'] as const)
      expect(await supplierAdmissionCandidateDigest({ ...target, observation: { ...target.observation, [field]: field === 'issuer' ? 'https://other.invalid' : 'changed' } }, 'development', 'supplier')).not.toBe(digest);
  });
  it('denies stale and future observations, changed lane/request/candidate bytes, purpose and rebinding', async () => {
    const { evidence, request, config } = await fixture(true);
    for (const at of [NOW - 1, NOW + 20_000, NOW + 60_000]) await expect(snapshotSupplierAdmissionEvidence(evidence, request, actor, config, instant(at))).rejects.toThrow();
    for (const field of ['requestDigest', 'mutationDigest'] as const)
      await expect(snapshotSupplierAdmissionEvidence({ ...evidence, [field]: 'b'.repeat(64) }, request, actor, config, clock())).rejects.toThrow();
    await expect(snapshotSupplierAdmissionEvidence(evidence, request, { ...actor, membershipVersion: 2 }, config, clock())).rejects.toThrow();
    await expect(snapshotSupplierAdmissionEvidence(evidence, request, actor, { ...config, issuer: 'https://changed.invalid' }, clock())).rejects.toThrow();
    expect(SupplierAdmissionEvidenceSchema.safeParse({ ...evidence, role: 'supplier_admin' }).success).toBe(false);
    if (evidence.target === null) throw new Error('Target required');
    expect(SupplierAdmissionEvidenceSchema.safeParse({ ...evidence, target: { ...evidence.target, observation: { ...evidence.target.observation, subject: 'rebound' } } }).success).toBe(false);
  });
  it('retains conservative original factors and rejects a fabricated later factor time', async () => {
    const { evidence, request, config } = await fixture(true);if (evidence.kind !== 'factors') throw new Error('Factors required');
    expect(SupplierAdmissionEvidenceSchema.safeParse({ ...evidence, source: { ...evidence.source, verifiedAt: clock() } }).success).toBe(false);
    const stale = { ...evidence, source: { ...evidence.source, firstFactorAgeMinutes: 4, firstFactorAt: instant(NOW - 301_000), verifiedAt: instant(NOW - 301_000) } };
    await expect(snapshotSupplierAdmissionEvidence(stale, request, actor, config, clock())).rejects.toThrow('expired');
  });
});
describe('supplier admission fixed repository boundary', () => {
  it('records exact bytes and checks actual verifier name/OID before dispatch', async () => {
    const { handle, reference, verifier, evidence } = await recorded();
    expect(handle).toEqual({ reference });expect(Object.isFrozen(handle.reference)).toBe(true);
    expect(effects(verifier)).toHaveLength(1);
    expect(verifier.query).toHaveBeenCalledWith('SELECT pactwoven.supplier_admission_record_evidence($1::jsonb) AS response', [JSON.stringify(evidence)]);
    expect(verifier.query).toHaveBeenCalledWith(expect.stringContaining(' AS safe'), ['supplier_verifier', 101]);
    expect(verifier.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('rejects reconstructed handles and foreign configured lanes before checkout', async () => {
    const { handle, config } = await recorded(), db = driver(context()), repository = new PostgresSupplierAdmissionRepository(db.pool, config, clock);
    for (const fake of [structuredClone(handle), handle.reference, null, { reference: handle.reference }])
      await expect(repository.execute(fake as SupplierAdmissionRecordedCall)).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_DENIED' });
    const changed = structuredClone(config);changed.lane.reference.version = 2;changed.lane.reference.hash = await supplierAdmissionLaneDigest(changed.lane);
    await expect(new PostgresSupplierAdmissionRepository(db.pool, changed, clock).execute(handle)).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_DENIED' });
    expect(db.connect).not.toHaveBeenCalled();
  });
  it('uses a single authorizer attempt and rejects scope-corrupted results', async () => {
    const { handle, config } = await recorded(), db = driver(context()), repository = new PostgresSupplierAdmissionRepository(db.pool, config, clock);
    await expect(repository.execute(handle)).resolves.toEqual(context());
    await expect(repository.execute(handle)).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_DENIED' });expect(effects(db)).toHaveLength(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining(' AS safe'), ['supplier_authorizer', 102]);
    const another = await recorded(), wrong = driver({ ...context(), organization: { ...context().organization, id: 'other' } });
    await expect(new PostgresSupplierAdmissionRepository(wrong.pool, another.config, clock).execute(another.handle)).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_UNAVAILABLE' });
  });
  it('rejects an unsafe actual principal before invoking a fixed function', async () => {
    for (const safe of [false, null, 'true', 1]) {
      const { handle, config } = await recorded(), db = driver(context(), { safe });
      await expect(new PostgresSupplierAdmissionRepository(db.pool, config, clock).execute(handle)).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_DENIED' });
      expect(effects(db)).toHaveLength(0);expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
    }
  });
  it('checks original freshness again after acquiring a connection', async () => {
    const { handle, config } = await recorded(), db = driver(context());
    await expect(new PostgresSupplierAdmissionRepository(db.pool, config, () => instant(NOW + 20_000)).execute(handle)).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_UNAVAILABLE' });
    expect(effects(db)).toHaveLength(0);
  });
  it('retains unknown outcome on lost COMMIT, malformed command results and connection release failure', async () => {
    for (const options of [{ commit: async () => { throw new Error('private connection detail'); } }, { commit: async () => ({ rows: [], command: 'ROLLBACK' }) },
      { rows: [] }, { rows: [{ response: {} }] }, { releaseError: true }]) {
      const { handle, config, response } = await recorded(true), db = driver(response, options);
      await expect(new PostgresSupplierAdmissionRepository(db.pool, config, clock).execute(handle)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
      expect(effects(db)).toHaveLength(1);
    }
  });
  it('sanitizes known SQL denials and never converts generic failures to absence', async () => {
    for (const [sqlstate, code] of [['SA001', 'SUPPLIER_ADMISSION_DENIED'], ['SA002', 'SUPPLIER_ADMISSION_STALE'],
      ['SA003', 'SUPPLIER_ORIGINAL_KEY_CONFLICT'], ['SA004', 'SUPPLIER_ADMISSION_INVALID'], ['08006', 'SUPPLIER_OUTCOME_UNKNOWN']]) {
      const { handle, config } = await recorded(true), db = driver(null, { error: { code: sqlstate, message: 'private sql body' } });
      const error: unknown = await new PostgresSupplierAdmissionRepository(db.pool, config, clock).execute(handle).catch(error => error);
      expect(error).toMatchObject({ code });expect((error as Error).message).not.toContain('private sql body');
    }
  });
  it('does not accept malformed recorder references or expose an uncommitted handle', async () => {
    const data = await fixture();
    for (const options of [{ rows: [] }, { rows: [{ response: { ...data.reference, hash: 'b'.repeat(64) } }] },
      { commit: async () => { throw new Error('private commit failure'); } }]) {
      const db = driver(data.reference, options);
      await expect(new PostgresSupplierAdmissionEvidenceRepository(db.pool, data.config, clock).append(data.evidence, data.request, actor)).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_UNAVAILABLE' });
      expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
    }
  });
});
