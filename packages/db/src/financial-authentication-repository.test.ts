import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandDigest } from '@pactwoven/domain';
import type { FinancialAuthEvidence } from './financial-auth-evidence.js';
import { validateFinancialAuthEvidence } from './financial-authentication-repository.js';
import { financialPolicyFixture, financialPolicyFixtureEnabled, type FinancialPolicyFixture } from './financial-authority.test-support.js';

function observation(): FinancialAuthEvidence {
  return { schemaVersion:1,id:'00000000-0000-0000-0000-000000000001',kind:'identity',purpose:'financial_policy_observation',environment:'development',organizationId:'org_a',
    actor:{actorId:'owner_a',membershipVersion:1,subject:'owner_a',externalMembershipId:'membership_owner_a',sessionId:'session_a'},observedAt:'2026-11-15T12:00:00.000Z',expiresAt:'2026-11-15T12:04:00.000Z',
    sessionExpiresAt:'2026-11-15T12:05:00.000Z',externalOrganizationId:'clerk_org_a',externalRole:'org:member',issuer:'https://synthetic.invalid',tokenHash:'a'.repeat(64),tokenIssuedAt:'2026-11-15T11:59:59.000Z' };
}
describe('private financial policy evidence bounds',()=>{
  it('accepts only an exact bounded identity observation',async()=>{
    const e=observation();expect(await validateFinancialAuthEvidence(e)).toEqual(e);
    for(const patch of [{expiresAt:'2026-11-15T12:06:00.000Z'},{expiresAt:e.observedAt},{tokenIssuedAt:'2026-11-15T12:00:01.000Z'},
      {sessionExpiresAt:'2026-11-15T12:03:59.000Z'},{verified:true},{purpose:'mandate_authorization'}]) await expect(validateFinancialAuthEvidence({...e,...patch} as FinancialAuthEvidence)).rejects.toThrow();
  });
  it('snapshots evidence before asynchronous hashing',async()=>{
    const e=observation(),promise=validateFinancialAuthEvidence(e);e.actor.subject='changed_subject';expect((await promise).actor.subject).toBe('owner_a');
  });
});
describe.skipIf(!financialPolicyFixtureEnabled)('actual policy verifier evidence',()=>{
  let f:FinancialPolicyFixture;beforeAll(async()=>{f=await financialPolicyFixture();},60000);afterAll(async()=>{await f?.close();});
  it('stores verifier-only immutable evidence with the exact canonical hash',async()=>{
    const e=await f.identity(),ref=await f.authentication.append(e);
    expect(ref.recordHash).toBe(await commandDigest({namespace:'pactwoven:financial-policy-evidence:v1',record:e}));
    await expect(f.authentication.append({...e,tokenHash:'b'.repeat(64)})).rejects.toMatchObject({code:'FINANCIAL_POLICY_KEY_CONFLICT'});
    await expect(f.authorizer.pool.query('SELECT pactwoven.financial_policy_attest($1::jsonb)',[JSON.stringify(e)])).rejects.toMatchObject({code:'42501'});
  });
  it('requires current observed membership rather than public flags',async()=>{
    const e=await f.identity();
    for(const patch of [{organizationId:'org_b'},{actor:{...e.actor,membershipVersion:2}},{observedAt:new Date(Date.now()-21000).toISOString()},{verified:true}])
      await expect(f.verifier.pool.query('SELECT pactwoven.financial_policy_attest($1::jsonb)',[JSON.stringify({...e,...patch,id:crypto.randomUUID()})])).rejects.toMatchObject({code:patch.verified?'FP004':'FP001'});
  });
  it('keeps governance acceptance independent of the proposing owner',async()=>{
    const p=await f.governance();await expect(f.consent(p.result,'owner_a')).rejects.toMatchObject({code:'FINANCIAL_POLICY_INVALID'});
    expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.financial_governance_controls')).rows[0].count).toBe('0');
  });
});
