import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source assertions are review aids, not native PostgreSQL qualification.
const originalUrl = new URL('../migrations/0015_supplier_relationship_authority.sql', import.meta.url);
const nextUrl = new URL('../migrations/0016_supplier_observer_resolution.sql', import.meta.url);
function body(sql: string, name: string) {
  const match = sql.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION pactwoven\\.${name}\\([\\s\\S]*? AS \\$\\$([\\s\\S]*?)\\$\\$;`));
  if (!match?.[1]) throw new Error(`Missing exact source function ${name}.`);
  return match[1];
}

describe('supplier observer migration source boundary', () => {
  it('pins the accepted managed-owner migration and changes only the verifier allowlist term in role_safe', async () => {
    const original = await readFile(originalUrl, 'utf8'), next = await readFile(nextUrl, 'utf8');
    expect(createHash('sha256').update(original).digest('hex')).toBe('9e2e58c8495038812317e0e654e1490c2a90e76c35c6576c4f4f5fbab33572f3');
    const before = body(original, 'supplier_role_safe'), after = body(next, 'supplier_role_safe');
    const term = "p.oid=to_regprocedure('pactwoven.supplier_record_evidence(jsonb)')";
    const expanded = "p.oid=ANY(ARRAY[to_regprocedure('pactwoven.supplier_record_evidence(jsonb)'),to_regprocedure('pactwoven.supplier_resolve_observer(jsonb,jsonb)')]::oid[])";
    expect(before.split(term)).toHaveLength(2);
    expect(after.split(expanded)).toHaveLength(2);
    expect(after.replace(expanded, term)).toBe(before);
  });

  it('limits the broad legacy-owner helper to three fixed identity relations and an exact field projection', async () => {
    const sql = await readFile(nextUrl, 'utf8'), helper = body(sql, 'supplier_observer_identity');
    const relations = [...helper.matchAll(/(?:FROM|JOIN|LOCK TABLE) pactwoven\.([a-z_]+)/g)].map(match => match[1]);
    expect([...new Set(relations)].sort()).toEqual(['memberships', 'organizations', 'session_revocations']);
    const statements = helper.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b|SELECT\s+\*|row_to_json|to_jsonb\((?:o|m|org|member)\)|set_config/i);
    expect(helper).toContain("'membershipVersion',m.row_version,'organizationVersion',o.row_version,'organizationEpoch',o.authority_epoch");
    expect(helper).toContain("member.external_subject=v->>'subject' AND member.external_membership_id=v->>'externalMembershipId'");
    expect(helper).toContain("org.external_organization_id=v->>'externalOrganizationId'");
    expect(helper).toContain("r.environment=e AND r.session_id=v->>'sessionId'");
    expect(helper).toContain("NOT('service'=ANY(m.roles)) AND m.roles && ARRAY['owner','supplier_admin']::text[]");
    expect(helper).toContain("m.grant_basis<>'clerk_admin_bootstrap' OR v->>'externalRole'='org:admin'");
  });

  it('orders identity locks and checks original observation, revocation, role and expiry after all waits', async () => {
    const sql = await readFile(nextUrl, 'utf8'), helper = body(sql, 'supplier_observer_identity'), wrapper = body(sql, 'supplier_resolve_observer');
    expect(helper.indexOf('FROM pactwoven.organizations')).toBeLessThan(helper.indexOf('LOCK TABLE pactwoven.session_revocations IN SHARE MODE'));
    expect(helper.indexOf('LOCK TABLE pactwoven.session_revocations IN SHARE MODE')).toBeLessThan(helper.indexOf('FROM pactwoven.memberships'));
    const afterWait = helper.slice(helper.lastIndexOf('FOR SHARE;'));
    expect(afterWait).toContain('at_time:=clock_timestamp()');
    expect(afterWait).toContain('pactwoven.supplier_observation_current(v,at_time)');
    expect(afterWait).toContain('m.expires_at>at_time');
    expect(afterWait).toContain("m.status='active'");
    expect(afterWait).toContain("o.status='active'");
    expect(afterWait).toContain('FROM pactwoven.session_revocations');
    expect(wrapper.split("pactwoven.supplier_current_binding('verifier')")).toHaveLength(3);
    expect(wrapper.split('b.body IS NOT DISTINCT FROM expected_binding')).toHaveLength(3);
    expect(wrapper.lastIndexOf('pactwoven.supplier_observation_current')).toBeGreaterThan(wrapper.indexOf('pactwoven.supplier_observer_identity'));
  });

  it('adds no tables, policies or logins and installs only the new helper/wrapper owner split', async () => {
    const sql = await readFile(nextUrl, 'utf8');
    expect(sql).not.toMatch(/CREATE\s+(?:TABLE|ROLE|POLICY)|ALTER\s+TABLE/i);
    expect(sql).toContain("fn.proname='supplier_observer_identity'");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION %s TO pactwoven_supplier_executor");
    expect(sql).toContain("ALTER FUNCTION %s OWNER TO pactwoven_supplier_executor");
    expect(sql).toContain("c.relname IN ('organizations','memberships','session_revocations') AND c.relowner=legacy_owner");
    expect(sql).toContain("c.relname='organizations' AND r.rolname=current_user");
    expect(sql).toContain('current_user=session_user');
    expect(sql).toContain("c.relkind='r' AND c.relrowsecurity");
    expect(sql).toContain('NOT c.relforcerowsecurity OR');
    expect(sql).toContain('(r.rolsuper OR r.rolbypassrls)');
    expect(sql).toContain('admin_option AND NOT inherit_option AND NOT set_option');
    expect(sql).toContain('REVOKE CREATE ON SCHEMA pactwoven FROM pactwoven_supplier_executor');
    expect(sql).toContain('AUTH-SQL-04');
    expect(sql).not.toMatch(/GRANT[^\n]*TO (?:PUBLIC|pactwoven_runtime|pactwoven_supplier_verifier)/i);
  });
});
