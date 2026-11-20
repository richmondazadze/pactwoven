import { describe, expect, it } from 'vitest';
import { DelegatedAdviceArtifactSchema, DelegatedAdviceOutputSchema } from '../../../packages/contracts/src/delegated-execution';
import { delegatedChildAdvice, delegatedAdviceInput, checkAdvice, DelegatedOutputRejected, renderDelegatedAdvice } from './delegated-output';

const completeStage = (index: number) => `Stage ${index}: ${'Discuss the fictional plan and record the agreed next step. '.repeat(22)}Finish this stage with a clear handoff.`;
const advice = { title: 'A complete workshop', summary: 'Cover the whole requested workshop.', findings: [],
  recommendations: Array.from({ length: 6 }, (_, index) => completeStage(index + 1)), limitations: [], question: null };
const artifact = () => DelegatedAdviceArtifactSchema.parse({ schemaVersion: 1, kind: 'delegated_advice_v1', advisoryOnly: true,
  domainCompletion: false, stepId: 'step-1', role: 'planning', advice, evidence: [], deployment: 'gpt-6.1-sol',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });

describe('complete delegated advice context', () => {
  it('retains the complete closing stage of a valid child beyond the old8000-character slice', () => {
    const body = artifact();
    expect(renderDelegatedAdvice(body.advice).length).toBeGreaterThan(8000);
    const context = delegatedChildAdvice(body);
    expect(context).toEqual({ role: 'planning', title: advice.title, text: renderDelegatedAdvice(advice) });
    expect(context.text.endsWith('Finish this stage with a clear handoff.')).toBe(true);
    expect(JSON.parse(delegatedAdviceInput({ childAdvice: [context] })).childAdvice[0].text).toBe(context.text);
  });
  it('rejects full context over the existing150000-character input budget without returning a clipped substitute', () => {
    expect(() => delegatedAdviceInput({ childAdvice: [delegatedChildAdvice(artifact())], extra: 'x'.repeat(150000) })).toThrow(DelegatedOutputRejected);
    expect(delegatedAdviceInput({ text: 'x'.repeat(149989) }).length).toBe(150000);
    expect(() => delegatedAdviceInput({ text: 'x'.repeat(149990) })).toThrow(DelegatedOutputRejected);
  });
  it('keeps six recommendations and1600 characters as the same strict schema limits', () => {
    expect(DelegatedAdviceOutputSchema.safeParse({ ...advice, recommendations: ['x'.repeat(1600)] }).success).toBe(true);
    expect(DelegatedAdviceOutputSchema.safeParse({ ...advice, recommendations: ['x'.repeat(1601)] }).success).toBe(false);
    expect(DelegatedAdviceOutputSchema.safeParse({ ...advice, recommendations: Array(7).fill('A complete stage.') }).success).toBe(false);
  });
  it('does not mistake terse or non-English advice for truncation or weaken citation rejection', () => {
    const terse = { ...advice, recommendations: ['09:00–10:00 — Introductions', '確認事項をまとめる'], findings: [] };
    expect(checkAdvice(terse, [])).toEqual(terse);
    expect(() => checkAdvice({ ...terse, findings: [{ kind: 'source_statement', text: 'A sourced statement', citations: [{ id: 'invented', quote: 'Not supplied' }] }] }, [])).toThrow(DelegatedOutputRejected);
  });
});
