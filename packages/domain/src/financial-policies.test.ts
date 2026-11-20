import { describe, expect, it } from 'vitest';
import type { FinancialPolicyDocument } from '@pactwoven/contracts';
import { financialBudgetAccountId, financialBudgetPeriodId, financialPolicyTextHash, financialPolicyRecordHash,
  financialPolicyRecordRef, validateFinancialPolicyRecord, financialPolicyCommandHash } from './financial-policies.js';

const canonical = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` :
  `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`;
const digest = async (v: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v)))),b=>b.toString(16).padStart(2,'0')).join('');
async function document(): Promise<FinancialPolicyDocument> {
  return { schemaVersion: 1, environment: 'development', organizationId: 'org_a', id: 'document_a', version: 1, predecessor: null,
    actor: { actorId: 'owner_a', membershipVersion: 1, subject: 'owner_a', externalMembershipId: 'membership_owner_a', sessionId: 'session_owner_a' },
    identityEvidence: { id: 'evidence_a', version: 1, recordHash: 'a'.repeat(64) }, organizationEpoch: 2, operationId: '00000000-0000-0000-0000-000000000001', createdAt: '2026-11-15T12:00:00.000Z', kind: 'document', responsibilityId: null,
    purpose: 'budget_policy', text: 'Exact full policy.', contentHash: await financialPolicyTextHash('Exact full policy.') };
}
describe('financial policy canonical identities and versions', () => {
  it('derives one stable budget identity from physical asset, environment, organization and category', async () => {
    const value = await financialBudgetAccountId('development','org_a','a'.repeat(64));
    expect(value).toBe(await digest({ namespace:'pactwoven:financial-budget-account:v1',environment:'development',organizationId:'org_a',assetKey:'a'.repeat(64),category:'supplier_principal' }));
    expect(await financialBudgetAccountId('development','org_a','a'.repeat(64))).toBe(value);
    expect(await financialBudgetAccountId('development','org_b','a'.repeat(64))).not.toBe(value);
    expect(await financialBudgetAccountId('simulation','org_a','a'.repeat(64))).not.toBe(value);
  });
  it('derives fixed period identity from both exact bounds without a caller counter', async () => {
    const start='2026-11-15T00:00:00.000Z',end='2026-11-22T00:00:00.000Z',id=await financialBudgetPeriodId('a'.repeat(64),start,end);
    expect(id).toBe(await digest({ namespace:'pactwoven:financial-budget-period:v1',budgetAccountId:'a'.repeat(64),startsAt:start,endsAt:end }));
    expect(await financialBudgetPeriodId('a'.repeat(64),start,'2026-11-23T00:00:00.000Z')).not.toBe(id);
  });
  it('hashes all normalized policy bytes and the full actor/scope/operation record', async () => {
    const d=await document();expect(d.contentHash).toBe(await digest({ namespace:'pactwoven:financial-policy-text:v1',text:d.text }));
    expect(await financialPolicyRecordHash(d)).toBe(await digest({ namespace:'pactwoven:financial-policy-document:v1',record:d }));
    expect(await financialPolicyRecordHash({...d,actor:{...d.actor,sessionId:'another_session'}})).not.toBe(await financialPolicyRecordHash(d));
    await expect(validateFinancialPolicyRecord({...d,text:'Changed text.'})).rejects.toMatchObject({code:'FINANCIAL_POLICY_INVALID'});
  });
  it('requires the exact predecessor and preserves the original author and purpose', async () => {
    const first=await document(),second={...first,version:2,predecessor:await financialPolicyRecordRef(first)};
    expect((await validateFinancialPolicyRecord(second,first)).version).toBe(2);
    for(const patch of [{version:3},{predecessor:{...second.predecessor,recordHash:'b'.repeat(64)}},{purpose:'approval_policy' as const},
      {actor:{...first.actor,actorId:'owner_b'}},{organizationId:'org_b'}]) await expect(validateFinancialPolicyRecord({...second,...patch},first)).rejects.toThrow();
  });
  it('binds the original command key, actor, scope and full text', async () => {
    const c={schemaVersion:1 as const,environment:'development' as const,organizationId:'org_a',responsibilityId:null,id:'document_a',previous:null,
      organizationEpoch:2,kind:'save_document' as const,key:'original_policy_001',purpose:'budget_policy' as const,text:'Policy terms.'};
    const hash=await financialPolicyCommandHash('owner_a',c);
    expect(hash).toBe(await digest({namespace:'pactwoven:financial-policy-command:v1',actorId:'owner_a',command:c}));
    expect(await financialPolicyCommandHash('owner_b',c)).not.toBe(hash);
    expect(await financialPolicyCommandHash('owner_a',{...c,text:'Other terms.'})).not.toBe(hash);
  });
});
