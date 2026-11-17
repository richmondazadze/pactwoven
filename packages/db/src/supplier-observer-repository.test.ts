import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresSupplierObserverRepository } from './supplier-observer-repository.js';
import {
  SupplierObserverConfigurationSchema, snapshotSupplierFactorObserver, snapshotSupplierIdentityObserver,
  type SupplierObserverConfiguration, type SupplierObserverFactorObservation, type SupplierObserverIdentityObservation,
} from './supplier-observer-schema.js';

// Driver doubles establish transport/shape behavior only. SQL authorization,
// migration privileges and genuine Clerk verification require separate admission.
const NOW = Date.parse('2026-11-16T12:00:00.000Z'), H = 'a'.repeat(64);
const iso = (at: number) => new Date(at).toISOString(), clock = () => iso(NOW);
const config = (): SupplierObserverConfiguration => ({ environment: 'simulation', issuer: 'https://synthetic.invalid',
  binding: { reference: { id: 'supplier_binding', version: 1, hash: H }, environment: 'simulation', effectiveOrganizationId: 'buyer',
    verifier: { name: 'supplier_verifier', oid: 101 }, authorizer: { name: 'supplier_authorizer', oid: 102 },
    status: 'ACTIVE', validFrom: iso(NOW - 3_600_000), expiresAt: iso(NOW + 3_600_000) } });
const identity = (): SupplierObserverIdentityObservation => ({ identity: {
  subject: 'subject', externalOrganizationId: 'org_buyer', externalOrganizationName: 'Synthetic buyer',
  externalMembershipId: 'external_member', externalRole: 'org:admin', sessionId: 'session',
  authenticatedAt: iso(NOW - 3_600_000), membershipObservedAt: iso(NOW - 1_000),
}, observation: { issuer: config().issuer, tokenHash: H, tokenIssuedAt: iso(NOW - 10_000),
  observedAt: iso(NOW - 1_000), expiresAt: iso(NOW + 60_000) } });
const factors = (): SupplierObserverFactorObservation => {
  const i = identity();
  return { identity: i.identity, evidence: { ...i.observation, observedAt: iso(NOW), id: '12345678-1234-4234-8234-123456789abc',
    subject: i.identity.subject, externalOrganizationId: i.identity.externalOrganizationId,
    externalMembershipId: i.identity.externalMembershipId, sessionId: i.identity.sessionId,
    firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 1, verifiedAt: iso(NOW - 130_000) } };
};
const actor = () => ({ environment: 'simulation', organizationId: 'buyer', actorId: 'owner', principalKind: 'human',
  membershipId: 'owner', membershipVersion: 4, organizationVersion: 7, organizationEpoch: 2,
  subject: 'subject', externalOrganizationId: 'org_buyer', externalMembershipId: 'external_member', sessionId: 'session' });
type Reply = { rows: unknown[]; command?: string };
function driver(response: unknown = actor(), options: {
  safe?: unknown; principalRows?: unknown[]; rows?: unknown[]; failure?: unknown;
  wait?: (stage: 'checkout' | 'principal' | 'resolve' | 'commit') => Promise<void>;
  commit?: () => Promise<Reply>; rollbackError?: boolean; releaseError?: boolean;
} = {}) {
  const query = vi.fn(async (sql: string, _values?: unknown[]): Promise<Reply> => {
    if (sql.includes(' AS safe')) {
      await options.wait?.('principal');
      return { rows: options.principalRows ?? [{ safe: Object.hasOwn(options, 'safe') ? options.safe : true }] };
    }
    if (sql.startsWith('SELECT pactwoven.supplier_resolve_observer')) {
      await options.wait?.('resolve');
      if (options.failure !== undefined) throw options.failure;
      return { rows: options.rows ?? [{ response }] };
    }
    if (sql === 'COMMIT') {
      await options.wait?.('commit');
      return options.commit ? options.commit() : { rows: [], command: 'COMMIT' };
    }
    if (sql === 'ROLLBACK' && options.rollbackError) throw new Error('private rollback failure');
    return { rows: [] };
  });
  const release = vi.fn(() => { if (options.releaseError) throw new Error('private release failure'); });
  const connect = vi.fn(async () => { await options.wait?.('checkout'); return { query, release }; });
  return { pool: { connect } as unknown as Pool, connect, query, release };
}
const resolverCalls = (db: ReturnType<typeof driver>) => db.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT pactwoven.'));
const commands = (db: ReturnType<typeof driver>) => db.query.mock.calls.map(([sql]) => sql);

describe('private supplier observer snapshots', () => {
  it('caps identity expiry without changing original authentication/member observations or token issue time', () => {
    const input = identity(), original = structuredClone(input);
    const snapshot = snapshotSupplierIdentityObserver(input, config(), clock());
    expect(snapshot.observation.observedAt).toBe(original.observation.observedAt);
    expect(snapshot.observation.membershipObservedAt).toBe(original.identity.membershipObservedAt);
    expect(snapshot.observation.tokenIssuedAt).toBe(original.observation.tokenIssuedAt);
    expect(snapshot.observation.authenticatedAt).toBe(original.identity.authenticatedAt);
    expect(snapshot.observation.sessionExpiresAt).toBe(original.observation.expiresAt);
    expect(snapshot.observation.expiresAt).toBe(iso(NOW + 29_000));
    expect(Object.isFrozen(snapshot.observation)).toBe(true);
    expect(input).toEqual(original);
    const bound = config(); bound.binding.expiresAt = iso(NOW + 500);
    expect(snapshotSupplierIdentityObserver(input, bound, clock()).observation.expiresAt).toBe(bound.binding.expiresAt);
  });

  it('preserves independent first/second factor bounds and the original token hash', () => {
    const input = factors(), snapshot = snapshotSupplierFactorObserver(input, config(), clock());
    expect(snapshot.source).toEqual({ kind: 'CLERK_FVA', tokenHash: H, tokenIssuedAt: input.evidence.tokenIssuedAt,
      firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 1, firstFactorAt: iso(NOW - 70_000),
      secondFactorAt: iso(NOW - 130_000), verifiedAt: input.evidence.verifiedAt });
    expect(snapshot.observation.observedAt).toBe(input.evidence.observedAt);
    expect(snapshot.observation.membershipObservedAt).toBe(input.identity.membershipObservedAt);
    expect(Object.isFrozen(snapshot.source)).toBe(true);
  });

  it('refuses cross-subject, organization, membership and session factor substitutions', () => {
    for (const key of ['subject', 'externalOrganizationId', 'externalMembershipId', 'sessionId'] as const) {
      const input = factors(); input.evidence[key] = 'substituted';
      expect(() => snapshotSupplierFactorObserver(input, config(), clock())).toThrow();
    }
  });

  it('refuses refreshed factor time, excessive factor expiry and factors at their original deadline', () => {
    const refreshed = factors(); refreshed.evidence.verifiedAt = iso(NOW);
    const expiry = factors(); expiry.evidence.expiresAt = iso(NOW + 170_001);
    const stale = factors(); stale.evidence.tokenIssuedAt = iso(NOW - 180_000); stale.evidence.verifiedAt = iso(NOW - 300_000);
    stale.evidence.expiresAt = iso(NOW);
    for (const input of [refreshed, expiry, stale]) expect(() => snapshotSupplierFactorObserver(input, config(), clock())).toThrow();
  });

  it('refuses stale/future membership observations, stale identity time and expired sessions', () => {
    const oldMember = identity(); oldMember.identity.membershipObservedAt = iso(NOW - 20_001);
    const futureMember = identity(); futureMember.identity.membershipObservedAt = iso(NOW + 1);
    const oldIdentity = identity(); oldIdentity.observation.observedAt = iso(NOW - 20_001); oldIdentity.identity.membershipObservedAt = iso(NOW - 20_001);
    oldIdentity.observation.tokenIssuedAt = iso(NOW - 30_000);
    const futureIdentity = identity(); futureIdentity.observation.observedAt = iso(NOW + 1);
    const expired = identity(); expired.observation.expiresAt = iso(NOW);
    for (const input of [oldMember, futureMember, oldIdentity, futureIdentity, expired]) {
      expect(() => snapshotSupplierIdentityObserver(input, config(), clock())).toThrow();
    }
  });

  it('requires exact configured issuer, active finite binding and binding observation floor', () => {
    const issuer = identity(); issuer.observation.issuer = 'https://substituted.invalid';
    expect(() => snapshotSupplierIdentityObserver(issuer, config(), clock())).toThrow();
    const revoked = config(); revoked.binding.status = 'REVOKED';
    const expired = config(); expired.binding.expiresAt = iso(NOW);
    const later = config(); later.binding.validFrom = iso(NOW);
    for (const c of [revoked, expired, later]) expect(() => snapshotSupplierIdentityObserver(identity(), c, clock())).toThrow();
    expect(() => SupplierObserverConfigurationSchema.parse({ ...config(), environment: 'development' })).toThrow();
  });
});

describe('private supplier observer SQL transport', () => {
  it('uses one fixed verifier query and returns current SQL versions without adding command authority', async () => {
    const db = driver(), c = config(), input = identity();
    const result = await new PostgresSupplierObserverRepository(db.pool, c, clock).resolveIdentity(input);
    expect(result.actor).toEqual(actor());
    expect(result.binding).toEqual(c.binding);
    expect(result.kind).toBe('identity');
    expect(Object.isFrozen(result.actor)).toBe(true);
    const calls = resolverCalls(db);
    expect(calls).toEqual([['SELECT pactwoven.supplier_resolve_observer($1::jsonb,$2::jsonb) AS response', expect.any(Array)]]);
    expect(calls[0]![1]).toHaveLength(2);
    expect(calls[0]![1]!.map(value => {
      expect(typeof value).toBe('string');
      return JSON.parse(value as string) as unknown;
    })).toEqual([c.binding, snapshotSupplierIdentityObserver(input, c, clock()).observation]);
    expect(db.query.mock.calls.find(([sql]) => sql.includes(' AS safe'))?.[1]).toEqual(['supplier_verifier', 101]);
    expect(commands(db).at(-1)).toBe('COMMIT');
    expect(commands(db).join('\n')).not.toMatch(/set_config|SET ROLE|app\.(tenant|actor)|supplier_record_evidence|supplier_access_contexts|supplier_relationship_/i);
    expect(db.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('snapshots input and configured binding before checkout and captures the pool method', async () => {
    let resume!: () => void;
    const held = new Promise<void>(resolve => { resume = resolve; });
    const db = driver(actor(), { wait: async stage => { if (stage === 'checkout') await held; } });
    const c = config(), originalConfig = structuredClone(c), input = factors(), original = structuredClone(input);
    const repository = new PostgresSupplierObserverRepository(db.pool, c, clock);
    const pending = repository.resolveFactors(input);
    c.binding.verifier.name = 'changed_login'; c.environment = 'development'; c.issuer = 'https://changed.invalid';
    input.evidence.tokenHash = 'b'.repeat(64); input.identity.subject = 'changed_subject';
    db.pool.connect = vi.fn(() => { throw new Error('rebound pool must not be called'); }) as unknown as Pool['connect'];
    resume();
    const result = await pending;
    expect(result.source.tokenHash).toBe(H);
    const calls = resolverCalls(db);
    expect(calls).toEqual([['SELECT pactwoven.supplier_resolve_observer($1::jsonb,$2::jsonb) AS response', expect.any(Array)]]);
    expect(calls[0]![1]).toHaveLength(2);
    expect(calls[0]![1]!.map(value => {
      expect(typeof value).toBe('string');
      return JSON.parse(value as string) as unknown;
    })).toEqual([originalConfig.binding, snapshotSupplierFactorObserver(original, originalConfig, clock()).observation]);
  });

  it('rejects caller-provided actor, binding or surplus provider fields before checkout', async () => {
    for (const input of [{ ...identity(), actor: actor() }, { ...identity(), binding: config().binding },
      { ...identity(), observation: { ...identity().observation, principal: 'supplier_authorizer' } }]) {
      const db = driver();
      await expect(new PostgresSupplierObserverRepository(db.pool, config(), clock).resolveIdentity(input)).rejects.toThrow();
      expect(db.connect).not.toHaveBeenCalled();
    }
  });

  it('refuses malformed/unsafe actual principal rows before invoking the resolver', async () => {
    for (const rows of [[], [{ safe: true }, { safe: true }], [{ safe: false }], [{ safe: 'true' }], [{}]]) {
      const db = driver(actor(), { principalRows: rows });
      await expect(new PostgresSupplierObserverRepository(db.pool, config(), clock).resolveIdentity(identity())).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
      expect(resolverCalls(db)).toHaveLength(0);
      expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
    }
  });

  it('rejects result cardinality, private-field leakage and every external identity/scope substitution', async () => {
    const invalidRows: unknown[][] = [[], [{}], [{ response: actor() }, { response: actor() }],
      [{ response: { ...actor(), roles: ['owner'] } }], [{ response: { ...actor(), membershipId: 'different_member' } }],
      [{ response: { ...actor(), membershipVersion: 0 } }], [{ response: { ...actor(), principalKind: 'service' } }]];
    for (const key of ['subject', 'externalOrganizationId', 'externalMembershipId', 'sessionId', 'organizationId', 'environment']) {
      invalidRows.push([{ response: { ...actor(), [key]: key === 'environment' ? 'development' : 'substituted' } }]);
    }
    for (const rows of invalidRows) {
      const db = driver(null, { rows });
      await expect(new PostgresSupplierObserverRepository(db.pool, config(), clock).resolveIdentity(identity())).rejects.toMatchObject({ code: 'SUPPLIER_OBSERVER_UNAVAILABLE' });
      expect(commands(db)).not.toContain('COMMIT');
      expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
    }
  });

  it('rechecks original freshness after checkout, principal, resolver and commit waits', async () => {
    for (const stage of ['checkout', 'principal', 'resolve', 'commit'] as const) {
      let at = NOW;
      const db = driver(actor(), { wait: async step => { if (step === stage) at += 20_001; } });
      await expect(new PostgresSupplierObserverRepository(db.pool, config(), () => iso(at)).resolveIdentity(identity())).rejects.toMatchObject({ code: 'SUPPLIER_OBSERVER_REFUSED' });
      expect(resolverCalls(db)).toHaveLength(stage === 'checkout' || stage === 'principal' ? 0 : 1);
      expect(commands(db).filter(sql => sql === 'COMMIT')).toHaveLength(stage === 'commit' ? 1 : 0);
      expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
    }
  });

  it('refuses binding and original factor expiry during waits even when membership remains fresh', async () => {
    for (const factor of [false, true]) {
      let at = NOW;
      const c = config(), input = factors();
      if (factor) {
        input.evidence.tokenIssuedAt = iso(NOW - 179_000); input.evidence.verifiedAt = iso(NOW - 299_000);
        input.evidence.expiresAt = iso(NOW + 1_000);
      } else c.binding.expiresAt = iso(NOW + 1_000);
      const db = driver(actor(), { wait: async stage => { if (stage === 'resolve') at += 1_001; } });
      const repository = new PostgresSupplierObserverRepository(db.pool, c, () => iso(at));
      await expect(factor ? repository.resolveFactors(input) : repository.resolveIdentity(identity())).rejects.toMatchObject({ code: 'SUPPLIER_OBSERVER_REFUSED' });
      expect(commands(db)).not.toContain('COMMIT');
    }
  });

  it('maps a current-identity/binding refusal without exposing database diagnostics or retrying', async () => {
    const db = driver(null, { failure: { code: 'SP001', message: 'private binding and identity details' } });
    await expect(new PostgresSupplierObserverRepository(db.pool, config(), clock).resolveIdentity(identity())).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    expect(resolverCalls(db)).toHaveLength(1);
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('returns no identity on query, commit, rollback or release uncertainty and never retries', async () => {
    const cases: Parameters<typeof driver>[1][] = [
      { failure: new Error('private network diagnostic'), rollbackError: true },
      { commit: async () => { throw { code: 'SP001', message: 'uncertain commit' }; } },
      { commit: async () => ({ rows: [], command: 'ROLLBACK' }) }, { releaseError: true },
    ];
    for (const options of cases) {
      const db = driver(actor(), options);
      await expect(new PostgresSupplierObserverRepository(db.pool, config(), clock).resolveIdentity(identity())).rejects.toMatchObject({ code: 'SUPPLIER_OBSERVER_UNAVAILABLE' });
      expect(resolverCalls(db)).toHaveLength(1);
      expect(db.connect).toHaveBeenCalledTimes(1);
    }
  });
});
