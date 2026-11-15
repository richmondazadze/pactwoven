import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { migrationStatements } from './migrate.js';
import { financialPolicyRoutines } from './financial-policy-schema.js';
vi.mock('pg', () => ({ Pool: class { constructor() { throw new Error('Database effects forbidden in SQL-text tests.'); } } }));

const source = await readFile(new URL('../migrations/0013_financial_policy_preparation.sql', import.meta.url), 'utf8');
const previous = await readFile(new URL('../migrations/0012_financial_policy_private_reads.sql', import.meta.url), 'utf8');
const body = (text: string, name: string) => {
  const start = text.indexOf(`FUNCTION pactwoven.${name}(`); expect(start).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('$$;', start) + 3);
};
describe('FP-PREP1 additive migration source only', () => {
  it('loads one wrapped additive packet with private helpers and one callable authorizer routine', () => {
    const statements = migrationStatements(source);
    expect(statements).toHaveLength(6);
    expect(statements.filter(s => /GRANT EXECUTE/.test(s))).toHaveLength(1);
    expect(source).toContain('GRANT EXECUTE ON FUNCTION pactwoven.financial_policy_prepare(uuid,jsonb,jsonb) TO pactwoven_financial_authorizer;');
    expect(source).not.toMatch(/CREATE\s+(?:TABLE|ROLE)|ALTER\s+(?:TABLE|ROLE)|DROP\s+(?:TABLE|ROLE)|INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+pactwoven\./i);
    expect(source).not.toContain('financial_policy_command(' + 'eid');
  });
  it('extends the exact safe role inventory once and leaves every other role predicate and verifier capability unchanged', () => {
    const before = body(previous, 'financial_policy_role_safe');
    expect(body(source, 'financial_policy_role_safe')).toBe(before.replace(
      "'pactwoven.financial_policy_proposer_observation(uuid,jsonb,jsonb)']",
      "'pactwoven.financial_policy_proposer_observation(uuid,jsonb,jsonb)','pactwoven.financial_policy_prepare(uuid,jsonb,jsonb)']"));
    expect(financialPolicyRoutines.authorizer).toHaveLength(9);
    for (const name of [...financialPolicyRoutines.authorizer, ...financialPolicyRoutines.verifier]) expect(body(source, 'financial_policy_role_safe')).toContain(`'${name}'`);
    expect(source).toContain('FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer,pactwoven_finance_observer,pactwoven_custody_setup_writer,pactwoven_custody_setup_verifier,pactwoven_financial_authorizer,pactwoven_financial_verifier;');
  });
  it('keeps target occupancy unfiltered by kind/responsibility under the accepted current-scope lock', () => {
    const prepare = body(source, 'financial_policy_prepare'), occupancy = prepare.slice(prepare.indexOf('SELECT r.body INTO p'), prepare.indexOf('IF p IS NULL THEN'));
    expect(occupancy).toContain("r.environment=s->>'environment' AND r.organization_id=s->>'organizationId'");
    expect(occupancy).toContain("r.id=sel->>'targetId' ORDER BY r.version DESC LIMIT 1 FOR SHARE");
    expect(occupancy).not.toMatch(/responsibility_id|r\.kind/);
    expect(prepare.indexOf('financial_policy_reader_context(eid,s,rid)')).toBeLessThan(prepare.indexOf('SELECT r.body INTO p'));
    expect(prepare.indexOf('Organization preparation disclosure denied')).toBeLessThan(prepare.indexOf('SELECT r.body INTO p'));
  });
  it('retains exact raw original-person checks, separate historical hydration and the original expiry', () => {
    const prepare = body(source, 'financial_policy_prepare');
    expect(prepare).toContain("p#>>'{requester,actorId}'=s#>>'{actor,actorId}' AND p#>>'{requester,subject}'=s#>>'{actor,subject}'");
    expect(prepare).toContain("p#>>'{proposer,actorId}'=s#>>'{actor,actorId}' AND p#>>'{proposer,subject}'=s#>>'{actor,subject}'");
    expect(prepare).toContain("x-'purpose',x->>'purpose',false)");
    expect(prepare).toContain("sel->'document','financial_mandate',true)");
    expect(prepare).toContain('financial_policy_original_checked');
    expect(prepare).toContain("(c#>>'{identity,observedAt}')::timestamptz+interval '20 seconds'");
    expect(prepare.indexOf('financial_policy_reader_finish(c)')).toBeLessThan(prepare.indexOf('IF at_time>=deadline'));
    expect(prepare).toContain('IF clock_timestamp()>=deadline');
    const document = body(source, 'financial_policy_prepare_document');
    expect(document.indexOf('financial_policy_original_checked')).toBeLessThan(document.indexOf('financial_policy_ref(v) IS DISTINCT FROM ref'));
    expect(prepare).toContain("s IS DISTINCT FROM pactwoven.financial_policy_reader_scope(c->'identity')");
    const withdrawal = prepare.slice(prepare.indexOf("ELSIF action_name='withdraw_draft'"), prepare.indexOf('-- Only the accepted physical devnet asset'));
    expect(withdrawal).not.toMatch(/read_context|site_active|expiresAt|prepare_document/);
  });
  it('bounds exact metadata, complete site/period context and private response without creating reservations', () => {
    const schema = JSON.parse(source.match(/\$schema\$(.*?)\$schema\$/s)![1]!);
    expect(schema.additionalProperties).toBe(false); expect(schema.required).toEqual(['responsibilityId', 'selection']);
    const branches = schema.properties.selection.oneOf;
    expect(branches.map((b: { properties: { action: { const: string } } }) => b.properties.action.const)).toEqual(['save_document', 'save_draft', 'withdraw_draft', 'propose_governance']);
    for (const branch of branches) expect(branch.additionalProperties).toBe(false);
    expect(source).toContain("octet_length(convert_to(q::text,'UTF8'))>8192");
    expect(source).toContain('LIMIT 101'); expect(source).toContain('jsonb_array_length(sites)>100');
    expect(source).toContain("octet_length(convert_to(result::text,'UTF8'))>2097152");
    expect(previous).toContain('LIMIT 51'); expect(previous).toContain('jsonb_array_length(periods)>50');
    expect(source).not.toMatch(/gen_random_uuid\(|custody_nonce\(|financial_policy_attest\(v\)|financial_policy_evidence_uses/);
  });
});
