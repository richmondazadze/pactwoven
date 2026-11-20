import { describe, expect, it } from 'vitest';
import { addDelegatedUsage, adviceArtifact, checkAdvice, DelegatedOutputRejected, publicEvidence, reportDelegatedUsage } from './delegated-output';
import type { DelegatedAdviceOutput, DelegatedEvidence } from '../../../packages/contracts/src/delegated-execution';
import { DelegatedPlanOutputSchema } from '../../../packages/contracts/src/delegated-execution';
const now = Date.now();
const evidence: DelegatedEvidence[] = [{ id: 'memory-1', title: 'Preference', text: 'Prefer blue chairs. Supplier response is pending.',
  kind: 'saved_memory', url: null, observedAt: new Date(now - 100).toISOString(), validUntil: new Date(now + 60000).toISOString() }];
const advice: DelegatedAdviceOutput = { title: 'Chair options', summary: 'Blue upholstery is a recorded preference.',
  findings: [{ kind: 'source_statement', text: 'The operator prefers blue.', citations: [{ id: 'memory-1', quote: 'Prefer blue chairs.' }] }], recommendations: ['Confirm chair dimensions.'], limitations: ['Stock was not verified.'], question: null };
const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
describe('delegated advisory output provenance', () => {
  it('retains exact source quotes and identifies statements separately from inference', () => expect(checkAdvice(advice, evidence)).toEqual(advice));
  it.each([{ id: 'memory-1', quote: 'Prefer red chairs.' }, { id: 'invented', quote: 'Prefer blue chairs.' }])('rejects invented quote or source identities', citation => {
    expect(() => checkAdvice({ ...advice, findings: [{ ...advice.findings[0], citations: [citation] }] }, evidence)).toThrow(DelegatedOutputRejected);
  });
  it('rejects source statements without an original quote', () => expect(() => checkAdvice({ ...advice, findings: [{ ...advice.findings[0], citations: [] }] }, evidence)).toThrow());
  it('rejects duplicate evidence IDs', () => expect(() => checkAdvice(advice, [...evidence, ...evidence])).toThrow());
  it('keeps cited excerpts only and records role/deployment/usage as runtime data', () => {
    const result = adviceArtifact({ schemaVersion: 1, stepId: 'chairs', title: 'Compare', brief: 'Review seating', role: 'research', memoryReferences: [] },
      { value: advice, usage, deployment: 'gpt-6.1-terra' }, evidence);
    expect(result).toMatchObject({ advisoryOnly: true, domainCompletion: false, role: 'research', deployment: 'gpt-6.1-terra', usage });
    expect(result.evidence[0]?.text).toBe('Prefer blue chairs.'); expect(JSON.stringify(result)).not.toContain('Supplier response');
    expect(checkAdvice(result.advice, result.evidence)).toEqual(advice);
  });
  it.each(['gpt-6.1-sol', 'gpt-6-astra'])('rejects a research response attributed to %s', deployment => {
    expect(() => adviceArtifact({ schemaVersion: 1, stepId: 'chairs', title: 'Compare', brief: 'Review', role: 'research', memoryReferences: [] },
      { value: advice, usage, deployment: deployment as 'gpt-6.1-terra' }, evidence)).toThrow();
  });
  it('meters measured token totals without a spending cap', () => expect(addDelegatedUsage(usage, usage)).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 }));
  it('rejects mismatched or unsafe token totals', () => {
    expect(() => addDelegatedUsage(usage, { ...usage, totalTokens: 4 })).toThrow();
    expect(() => addDelegatedUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER }, usage)).toThrow();
  });
  it('does not let a model set IDs, scope, identities or references in its plan', () => {
    const plan = { objective: 'Compare', steps: [{ title: 'Research', brief: 'Read', role: 'research' }], limitations: [], question: null };
    expect(DelegatedPlanOutputSchema.safeParse(plan).success).toBe(true);
    for (const injected of [{ ...plan, authority: {} }, { ...plan, steps: [{ ...plan.steps[0], memoryReferences: [] }] }, { ...plan, steps: [{ ...plan.steps[0], serviceId: 'other' }] }]) expect(DelegatedPlanOutputSchema.safeParse(injected).success).toBe(false);
  });
  it('caps retained public evidence to the original15minute policy even if a reader offers a longer expiry', () => {
    const observed = '2026-11-18T12:00:00Z';
    const [result] = publicEvidence([{ id: 'public', title: 'Page', text: 'Quoted page.', source: { title: 'Page', url: 'https://example.com/' }, origin: 'retrieved', observedAt: observed, validUntil: '2026-11-19T12:00:00Z' }], Date.parse(observed)+1000);
    expect(result?.validUntil).toBe('2026-11-18T12:15:00.000Z');
  });
  it('does not let a telemetry callback invalidate retained model usage', () => expect(() => reportDelegatedUsage(() => { throw Error('Logger failed'); }, usage)).not.toThrow());
  it('rejects public sources that lack protected provenance or are expired', () => {
    expect(() => publicEvidence([{ title: 'Forged', text: 'x', observedAt: new Date(now).toISOString(), validUntil: new Date(now + 1000).toISOString() } as never], now)).toThrow();
    expect(() => publicEvidence(Array(4).fill({}), now)).toThrow();
  });
});
