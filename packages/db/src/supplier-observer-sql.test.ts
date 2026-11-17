import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSupplierAuthenticationRepository, PostgresSupplierRelationshipRepository, type SupplierRecordedCall } from './supplier-relationship-repository.js';
import { observerConsentVariable, observerFixtureVariable, observerFixtureConfig, observerDatabase, observerPort } from './supplier-observer-fixture-admission.js';
import { createObserverFixture, appendBinding, at, evidenceFor, identifier, observerAuthorizerFunctions, observerWrapper,
  resolveOn, resolveRaw, reviseBinding, transaction, waitUntilDatabase, withBlockedObserver,
  type ObserverFixture, type ObserverScenario, type ScenarioOptions, type LockSite } from './supplier-observer-fixture.js';

// Root binds this exact inventory to the existing native supervisor, one worker,
// new cluster, URL file and loopback port. Ordinary test collection opens no DB.
// Synthetic provider-shaped objects do not establish Clerk/provider origin.
const enabled = Boolean(process.env[observerFixtureVariable] || process.env[observerConsentVariable]);
function syntheticUrl(source: string) {
  const url = new URL(source); url.password = 'synthetic'; return url.href;
}
describe('supplier observer disposable admission', () => {
  it('accepts only the separately named loopback database and administrator', () => {
    expect(observerFixtureConfig(syntheticUrl(`postgresql://supplier_observer_fixture_admin@127.0.0.1:${observerPort}/${observerDatabase}`))).toMatchObject({ max: 2, ssl: false });
    for (const url of [
      syntheticUrl(`postgresql://supplier_observer_fixture_admin@localhost:${observerPort}/${observerDatabase}`),
      syntheticUrl(`postgresql://supplier_observer_fixture_admin@127.0.0.1:55441/${observerDatabase}`),
      syntheticUrl(`postgresql://supplier_observer_fixture_admin@127.0.0.1:${observerPort}/pactwoven_dev`),
      syntheticUrl(`postgresql://supplier_fixture_admin@127.0.0.1:${observerPort}/${observerDatabase}`),
      syntheticUrl(`postgresql://supplier_observer_fixture_admin@127.0.0.1:${observerPort}/${observerDatabase}?sslmode=disable`),
    ]) expect(() => observerFixtureConfig(url)).toThrow();
  });
});

describe.skipIf(!enabled)('supplier observer on a fresh sixteen-migration PostgreSQL fixture', () => {
  let f: ObserverFixture;
  beforeAll(async () => { f = await createObserverFixture(); }, 60_000);
  afterAll(async () => { if (f) await f.finish(); });
  const run = async (work: (s: ObserverScenario) => Promise<void>, options: ScenarioOptions = {}) => {
    const s = await f.scenario(options);
    try { await work(s); } finally { await s.close(); }
  };
  const denied = (promise: Promise<unknown>, code = 'SP001') => expect(promise).rejects.toMatchObject({ code });
  const memberUpdate = (s: ObserverScenario, expression: string, values: unknown[] = [], client = f.admin as import('pg').Pool | import('pg').PoolClient) =>
    client.query(`UPDATE pactwoven.memberships SET ${expression} WHERE environment='development' AND organization_id=$1 AND actor_id=$2`, [s.organization, s.actor, ...values]);
  const organizationUpdate = (s: ObserverScenario, expression: string, client = f.admin as import('pg').Pool | import('pg').PoolClient) =>
    client.query(`UPDATE pactwoven.organizations SET ${expression} WHERE environment='development' AND id=$1`, [s.organization]);
  const revokeSession = (s: ObserverScenario, client = f.admin as import('pg').Pool | import('pg').PoolClient) =>
    client.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)", [s.session]);

  it('pins installed helper and wrapper source, owners, configs, exact ACLs and stripped default grants', async () => {
    expect(f.installed).toHaveLength(3);
    expect(f.helperRelations).toEqual(['memberships', 'organizations', 'session_revocations']);
    expect(f.installed[1]!.rolsuper).toBe(true);
    expect(f.installed[2]).toMatchObject({ owner: 'pactwoven_supplier_executor', rolsuper: false, prosecdef: true });
    expect(await f.functionFingerprints()).toEqual(f.installed);
  });

  it.each(['buyer', 'supplier'] as const)('resolves current %s identity with exact affinity and no provisioning or authority writes', async party => run(async s => {
    const before = await f.inventory(), input = s.identityInput();
    const value = await s.repository().resolveIdentity(input);
    expect(value.actor).toEqual({ environment: 'development', organizationId: s.organization, actorId: s.actor, principalKind: 'human',
      membershipId: s.actor, membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0, subject: s.subject,
      externalOrganizationId: s.externalOrganization, externalMembershipId: s.externalMember, sessionId: s.session });
    expect(value.observation.observedAt).toBe(input.observation.observedAt);
    expect(value.observation.membershipObservedAt).toBe(input.identity.membershipObservedAt);
    expect(value.binding).toEqual(s.binding);
    expect(Object.keys(value).sort()).toEqual(['actor', 'binding', 'kind', 'observation']);
    expect(Object.isFrozen(value.actor)).toBe(true);
    expect(await f.inventory()).toEqual(before);
  }, { party }));

  it('returns newly current member and organization versions and epoch without renewing observation time', async () => run(async s => {
    await memberUpdate(s, 'row_version=row_version+1');
    await organizationUpdate(s, 'authority_epoch=authority_epoch+1');
    const input = s.identityInput(), value = await s.repository().resolveIdentity(input);
    expect(value.actor).toMatchObject({ membershipVersion: 2, organizationVersion: 2, organizationEpoch: 1 });
    expect(value.observation.observedAt).toBe(input.observation.observedAt);
  }));

  it('preserves original independent factor times through actual SQL resolution', async () => run(async s => {
    const input = s.identityInput(), issued = Date.parse(input.observation.tokenIssuedAt);
    const expiresAt = at(issued + 120_000), verifiedAt = at(issued - 120_000);
    const value = await s.repository().resolveFactors({ identity: input.identity, evidence: { ...input.observation, expiresAt,
      id: randomUUID(), subject: s.subject, externalOrganizationId: s.externalOrganization, externalMembershipId: s.externalMember,
      sessionId: s.session, firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 1, verifiedAt } });
    expect(value.kind).toBe('factors');
    if (value.kind === 'factors') expect(value.source).toMatchObject({ firstFactorAt: at(issued - 60_000), secondFactorAt: verifiedAt, verifiedAt });
    expect(value.observation.sessionExpiresAt).toBe(expiresAt);
  }));

  it.each(['subject', 'externalOrganizationId', 'externalMembershipId'] as const)('refuses substituted %s without creating a missing actor', async field => run(async s => {
    const before = await f.inventory();
    await denied(resolveRaw(s, { ...s.observation(), [field]: 'absent_observer_identity' }));
    expect(await f.inventory()).toEqual(before);
  }));

  it.each([
    ['missing member', { omitMember: true }], ['suspended member', { memberStatus: 'suspended' }], ['revoked member', { memberStatus: 'revoked' }],
    ['suspended organization', { organizationStatus: 'suspended' }], ['closed organization', { organizationStatus: 'closed' }],
    ['service principal', { roles: ['owner', 'service'] }], ['ineligible role', { roles: ['auditor'] }],
  ] as const)('refuses %s', async (_label, options) => run(async s => {
    const before = await f.inventory(); await denied(resolveRaw(s)); expect(await f.inventory()).toEqual(before);
  }, options));

  it('refuses future organization creation', async () => run(async s => { await denied(resolveRaw(s)); }, { organizationCreatedAt: at(Date.now() + 60_000) }));
  it('refuses future membership creation', async () => run(async s => { await denied(resolveRaw(s)); }, { memberCreatedAt: at(Date.now() + 60_000) }));
  it('refuses expired membership', async () => run(async s => { await denied(resolveRaw(s)); }, { memberExpiresAt: at(Date.now() - 1_000) }));
  it('refuses bootstrap external-role downgrade but permits an internally granted eligible role', async () => {
    await run(async s => { await denied(resolveRaw(s, { ...s.observation(), externalRole: 'org:member' })); });
    await run(async s => { expect((await resolveRaw(s, { ...s.observation(), externalRole: 'org:member' })).actorId).toBe(s.actor); }, { grantBasis: 'internal' });
  });
  it('refuses revoked session while preserving other-session affinity', async () => run(async s => {
    await revokeSession(s); await denied(resolveRaw(s));
    const other = await resolveRaw(s, { ...s.observation(), sessionId: `${s.session}_other` });
    expect(other.sessionId).toBe(`${s.session}_other`);
  }));
  it('refuses stale and future original identity or membership observations and expired sessions', async () => run(async s => {
    await denied(resolveRaw(s, s.observation(Date.now() - 20_100)));
    await denied(resolveRaw(s, s.observation(Date.now() + 10_000)));
    await denied(resolveRaw(s, { ...s.observation(), membershipObservedAt: at(Date.now() - 20_100) }));
    await denied(resolveRaw(s, { ...s.observation(), sessionExpiresAt: at(Date.now() - 1) }));
  }));

  it.each(['hash', 'version', 'environment', 'organization', 'verifierOid', 'verifierName', 'authorizerOid', 'authorizerName'] as const)(
    'refuses configured binding %s substitution', async field => run(async s => {
      const b = structuredClone(s.binding);
      if (field === 'hash') b.reference.hash = '0'.repeat(64);
      if (field === 'version') b.reference.version += 1;
      if (field === 'environment') b.environment = 'staging';
      if (field === 'organization') b.effectiveOrganizationId = 'other_observer_organization';
      if (field === 'verifierOid') b.verifier.oid += 1;
      if (field === 'verifierName') b.verifier.name += '_other';
      if (field === 'authorizerOid') b.authorizer.oid += 1;
      if (field === 'authorizerName') b.authorizer.name += '_other';
      await denied(resolveRaw(s, s.observation(), b));
    }));
  it('refuses stale configured version instead of silently adopting an active successor', async () => run(async s => {
    const next = await reviseBinding(s.binding); await appendBinding(f.admin, next);
    await denied(resolveRaw(s));
    expect((await resolveRaw(s, s.observation(), next)).actorId).toBe(s.actor);
  }));
  it('refuses terminal revoked binding', async () => run(async s => {
    await appendBinding(f.admin, await reviseBinding(s.binding, { status: 'REVOKED' })); await denied(resolveRaw(s));
  }));
  it('refuses not-yet-valid and expired actual bindings with otherwise current observations', async () => {
    await run(async s => { await denied(resolveRaw(s)); }, { bindingValidFrom: at(Date.now() + 60_000) });
    await run(async s => { await denied(resolveRaw(s, { ...s.observation(), expiresAt: at(Date.now() + 10_000) })); }, { bindingExpiresAt: at(Date.now() - 1_000) });
  });
  it('refuses an original observation preceding the active binding window', async () => run(async s => {
    const observation = s.observation(Date.parse(s.binding.validFrom) - 1_000);
    await denied(resolveRaw(s, observation));
  }, { bindingValidFrom: at(Date.now() - 5_000) }));
  it('refuses an observation expiry beyond the active binding window', async () => run(async s => {
    await denied(resolveRaw(s, { ...s.observation(), expiresAt: at(Date.parse(s.binding.expiresAt) + 1) }));
  }, { bindingExpiresAt: at(Date.now() + 20_000) }));
  it('refuses an unbound actual verifier and an authorizer without wrapper privilege', async () => run(async s => {
    const outsider = await f.login('verifier');
    try { await denied(resolveRaw(s, s.observation(), s.binding, outsider)); } finally { await f.retire(outsider); }
    await denied(resolveRaw(s, s.observation(), s.binding, s.authorizer), '42501');
  }));
  it('refuses authorizer-as-verifier even if the offline administrator adds wrapper EXECUTE', async () => run(async s => {
    await f.admin.query(`GRANT EXECUTE ON FUNCTION pactwoven.${observerWrapper} TO ${identifier(s.authorizer.name)}`);
    try { await denied(resolveRaw(s, s.observation(), s.binding, s.authorizer)); }
    finally { await f.admin.query(`REVOKE EXECUTE ON FUNCTION pactwoven.${observerWrapper} FROM ${identifier(s.authorizer.name)}`); }
  }));
  it('refuses role-name reuse with a new actual login OID', async () => run(async s => {
    const originalName = s.verifier.name, originalOid = s.verifier.oid;
    await f.retire(s.verifier);
    const retainedName = `${originalName}_retired`;
    await f.admin.query(`ALTER ROLE ${identifier(originalName)} RENAME TO ${identifier(retainedName)}`); s.verifier.name = retainedName;
    const replacement = await f.login('verifier', originalName);
    try { expect(replacement.oid).not.toBe(originalOid); await denied(resolveRaw(s, s.observation(), s.binding, replacement)); }
    finally { await f.retire(replacement); }
  }));
  it.each(['REPEATABLE READ', 'SERIALIZABLE'])('refuses %s isolation', async isolation => run(async s => {
    await denied(transaction(s.verifier.pool, c => resolveOn(c, s), isolation));
  }));
  it('refuses SET ROLE even when it names the actual verifier itself', async () => run(async s => {
    await denied(transaction(s.verifier.pool, async c => { await c.query(`SET LOCAL ROLE ${identifier(s.verifier.name)}`); return resolveOn(c, s); }));
    expect((await resolveRaw(s)).actorId).toBe(s.actor);
  }));
  it.each(['SUPERUSER', 'BYPASSRLS', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'INHERIT'] as const)('refuses unsafe %s attribute on either actual principal', async attribute => run(async s => {
    for (const principal of [s.verifier, s.authorizer]) {
      await f.admin.query(`ALTER ROLE ${identifier(principal.name)} ${attribute}`);
      try { await denied(resolveRaw(s)); }
      finally { await f.admin.query(`ALTER ROLE ${identifier(principal.name)} NO${attribute}`); }
    }
  }));
  it('refuses role-level configuration and both directions of role membership', async () => run(async s => {
    const other = await f.login('none');
    try {
      for (const principal of [s.verifier, s.authorizer]) {
        await f.admin.query(`ALTER ROLE ${identifier(principal.name)} SET statement_timeout='4s'`);
        try { await denied(resolveRaw(s)); } finally { await f.admin.query(`ALTER ROLE ${identifier(principal.name)} RESET ALL`); }
        for (const [role, member] of [[other.name, principal.name], [principal.name, other.name]]) {
          await f.admin.query(`GRANT ${identifier(role!)} TO ${identifier(member!)}`);
          try { await denied(resolveRaw(s)); } finally { await f.admin.query(`REVOKE ${identifier(role!)} FROM ${identifier(member!)}`); }
        }
      }
    } finally { await f.retire(other); }
  }));
  it.each(['table', 'column', 'helper', 'schema', 'database'] as const)('refuses surplus %s privilege on either principal', async privilege => run(async s => {
    for (const principal of [s.verifier, s.authorizer]) {
      const target = identifier(principal.name);
      const grant = privilege === 'table' ? `SELECT ON pactwoven.memberships` : privilege === 'column' ? `SELECT(actor_id) ON pactwoven.memberships` :
        privilege === 'helper' ? `EXECUTE ON FUNCTION pactwoven.supplier_observer_identity(text,text,jsonb)` :
          privilege === 'schema' ? `CREATE ON SCHEMA pactwoven` : `CREATE ON DATABASE ${observerDatabase}`;
      await f.admin.query(`GRANT ${grant} TO ${target}`);
      try { await denied(resolveRaw(s)); } finally { await f.admin.query(`REVOKE ${grant} FROM ${target}`); }
    }
  }));
  it('keeps exact runtime allowlists and denies helpers, business tables and provisioning tables', async () => run(async s => {
    for (const [principal, allowed] of [[s.verifier, ['supplier_record_evidence(jsonb)', observerWrapper]], [s.authorizer, [...observerAuthorizerFunctions]]] as const) {
      const rows = (await f.admin.query(`SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='pactwoven' AND has_function_privilege($1::oid,p.oid,'EXECUTE') ORDER BY signature`, [principal.oid])).rows;
      expect(rows.map(row => row.signature).sort()).toEqual(allowed.map(name => `pactwoven.${name}`).sort());
    }
    for (const sql of ["SELECT * FROM pactwoven.organizations", "SELECT * FROM pactwoven.memberships", "SELECT * FROM pactwoven.supplier_private_bindings",
      "SELECT * FROM pactwoven.supplier_relationship_versions", "INSERT INTO pactwoven.supplier_access_contexts DEFAULT VALUES",
      "SELECT pactwoven.supplier_current_binding('verifier')", "SELECT pactwoven.supplier_role_safe(1::oid,'verifier')",
      "SELECT pactwoven.supplier_observer_identity('development','absent','{}'::jsonb)", "SELECT pactwoven.supplier_base_identity('{}','[]','[]')"]) {
      await denied(s.verifier.pool.query(sql), '42501');
    }
    await denied(s.verifier.pool.query(`SET ROLE pactwoven_supplier_executor`), '42501');
  }));

  it.each(['registry', 'lineage', 'organization', 'revocation', 'membership'] as LockSite[])('proves a real %s lock wait before successful unchanged resolution', async site => run(async s => {
    const before = await resolveRaw(s), inventory = await f.inventory();
    await withBlockedObserver(f, s, site, async ({ result, release }) => {
      await release(); expect(await result).toEqual({ value: before });
    });
    expect(await f.inventory()).toEqual(inventory);
  }));
  it('reselects terminal binding revocation after the registry wait', async () => run(async s => {
    await resolveRaw(s);
    await withBlockedObserver(f, s, 'registry', async ({ blocker, result, release }) => {
      await appendBinding(blocker, await reviseBinding(s.binding, { status: 'REVOKED' })); await release();
      expect((await result).error).toMatchObject({ code: 'SP001' });
    });
  }));
  it.each(['status', 'version', 'epoch'] as const)('re-reads organization %s after its row-lock wait', async change => run(async s => {
    await resolveRaw(s);
    await withBlockedObserver(f, s, 'organization', async ({ blocker, result, release }) => {
      await organizationUpdate(s, change === 'status' ? "status='suspended'" : change === 'version' ? 'row_version=row_version+1' : 'authority_epoch=authority_epoch+1', blocker);
      await release(); const outcome = await result;
      if (change === 'status') expect(outcome.error).toMatchObject({ code: 'SP001' });
      else expect(outcome.value).toMatchObject({ organizationVersion: 2, organizationEpoch: change === 'epoch' ? 1 : 0 });
    });
  }));
  it.each(['revoke', 'role', 'version'] as const)('re-reads membership %s after its row-lock wait', async change => run(async s => {
    await resolveRaw(s);
    await withBlockedObserver(f, s, 'membership', async ({ blocker, result, release }) => {
      await memberUpdate(s, change === 'revoke' ? "status='revoked'" : change === 'role' ? "roles=ARRAY['auditor']" : 'row_version=row_version+1', [], blocker);
      await release(); const outcome = await result;
      if (change === 'version') expect(outcome.value).toMatchObject({ membershipVersion: 2 });
      else expect(outcome.error).toMatchObject({ code: 'SP001' });
    });
  }));
  it('observes newly committed session revocation after the revocation-table wait', async () => run(async s => {
    await resolveRaw(s);
    await withBlockedObserver(f, s, 'revocation', async ({ blocker, result, release }) => {
      await revokeSession(s, blocker); await release(); expect((await result).error).toMatchObject({ code: 'SP001' });
    });
  }));
  it('rechecks both role allowlists after identity locks', async () => run(async s => {
    await resolveRaw(s);
    await withBlockedObserver(f, s, 'membership', async ({ blocker, result, release }) => {
      await blocker.query(`GRANT SELECT ON pactwoven.memberships TO ${identifier(s.authorizer.name)}`);
      await release();
      try { expect((await result).error).toMatchObject({ code: 'SP001' }); }
      finally { await f.admin.query(`REVOKE SELECT ON pactwoven.memberships FROM ${identifier(s.authorizer.name)}`); }
    });
  }));
  it('refuses original observation age crossing twenty seconds during a proved lineage wait', async () => run(async s => {
    const observation = s.observation(Date.now() - 18_800);
    await withBlockedObserver(f, s, 'lineage', async ({ result, release }) => {
      await waitUntilDatabase(f.admin, at(Date.parse(observation.observedAt) + 20_010));
      await release(); expect((await result).error).toMatchObject({ code: 'SP001' });
    }, observation);
  }));
  it('refuses membership expiry crossed during a proved member wait', async () => run(async s => {
    const expiry = at(Date.now() + 1_400); await memberUpdate(s, 'expires_at=$3::timestamptz', [expiry]);
    await withBlockedObserver(f, s, 'membership', async ({ result, release }) => {
      await waitUntilDatabase(f.admin, expiry); await release(); expect((await result).error).toMatchObject({ code: 'SP001' });
    });
  }));
  it('refuses binding expiry crossed during a proved lineage wait', async () => run(async s => {
    await withBlockedObserver(f, s, 'lineage', async ({ result, release }) => {
      await waitUntilDatabase(f.admin, s.binding.expiresAt); await release(); expect((await result).error).toMatchObject({ code: 'SP001' });
    });
  }, { bindingExpiresAt: at(Date.now() + 2_000) }));
  it('refuses lock timeout without retry after a proved blocker', async () => run(async s => {
    await withBlockedObserver(f, s, 'organization', async ({ result, release }) => {
      expect((await result).error).toMatchObject({ code: '55P03' }); await release();
    });
  }));
  it('refuses statement timeout without retry after a proved blocker', async () => run(async s => {
    await withBlockedObserver(f, s, 'organization', async ({ result, release }) => {
      expect((await result).error).toMatchObject({ code: '57014' }); await release();
    }, s.observation(), 300);
  }));

  it('does not mint a committed-call handle or discover an approver plan', async () => run(async s => {
    const before = await f.inventory(), resolved = await s.repository().resolveIdentity(s.identityInput());
    const authorizer = new PostgresSupplierRelationshipRepository(s.authorizer.pool, s.binding);
    await expect(authorizer.execute(resolved as unknown as SupplierRecordedCall, s.request)).rejects.toMatchObject({ code: 'SUPPLIER_PRIVATE_CALL_REQUIRED' });
    await denied(s.verifier.pool.query('SELECT pactwoven.supplier_relationship_status($1::uuid,$2::jsonb)', [randomUUID(),
      { kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: s.request.query }]), '42501');
    expect(await f.inventory()).toEqual(before);
  }));
  it('requires an actual committed recorder handle before the existing authorizer can return an empty observation plan', async () => run(async s => {
    const request = Object.freeze({
      kind: 'relationship-observation-plan',
      purpose: 'supplier_relationship_observation_plan',
      query: Object.freeze({ scope: Object.freeze({ ...s.request.query.scope }) }),
    } as const);
    const observation = s.observation(), actor = await resolveRaw(s, observation), evidence = await evidenceFor(s, actor, observation, request);
    const handle = await new PostgresSupplierAuthenticationRepository(s.verifier.pool, s.binding).append(evidence, request, actor);
    const value = await new PostgresSupplierRelationshipRepository(s.authorizer.pool, s.binding).execute(handle, request);
    expect(value).toEqual({
      kind: 'relationship-observation-plan',
      plan: { scope: request.query.scope, head: null, approvers: [] },
    });
    expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.supplier_relationship_versions')).rows[0].count).toBe('0');
  }));
  it.each(['member-version', 'member-role', 'member-revocation', 'organization-version', 'session-revocation'] as const)(
    'recorder revalidates resolved stamp after %s changes before append', async change => run(async s => {
      const observation = s.observation(), actor = await resolveRaw(s, observation), evidence = await evidenceFor(s, actor, observation);
      if (change === 'member-version') await memberUpdate(s, 'row_version=row_version+1');
      if (change === 'member-role') await memberUpdate(s, "roles=ARRAY['auditor']");
      if (change === 'member-revocation') await memberUpdate(s, "status='revoked'");
      if (change === 'organization-version') await organizationUpdate(s, 'row_version=row_version+1');
      if (change === 'session-revocation') await revokeSession(s);
      const before = await f.inventory();
      await denied(s.verifier.pool.query('SELECT pactwoven.supplier_record_evidence($1::jsonb)', [evidence]));
      expect(await f.inventory()).toEqual(before);
    }));
  it.each(['member-version', 'member-role', 'member-revocation', 'organization-version', 'session-revocation'] as const)(
    'authorizer revalidates committed evidence after %s changes before execute', async change => run(async s => {
      const observation = s.observation(), actor = await resolveRaw(s, observation), evidence = await evidenceFor(s, actor, observation);
      const recorder = new PostgresSupplierAuthenticationRepository(s.verifier.pool, s.binding);
      const handle = await recorder.append(evidence, s.request, actor);
      if (change === 'member-version') await memberUpdate(s, 'row_version=row_version+1');
      if (change === 'member-role') await memberUpdate(s, "roles=ARRAY['auditor']");
      if (change === 'member-revocation') await memberUpdate(s, "status='revoked'");
      if (change === 'organization-version') await organizationUpdate(s, 'row_version=row_version+1');
      if (change === 'session-revocation') await revokeSession(s);
      const before = await f.inventory();
      await expect(new PostgresSupplierRelationshipRepository(s.authorizer.pool, s.binding).execute(handle, s.request)).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
      expect(await f.inventory()).toEqual(before);
    }));
});
