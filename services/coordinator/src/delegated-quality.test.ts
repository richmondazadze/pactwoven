import { describe, expect, it } from 'vitest';
import { azureDeployments, createAzureGateway, NativeGatewayError, type ModelRequest, type ModelResult } from './azure-gateway';
import { checkQualityReview, qualifyDelegatedAdvice, qualityCategories, qualityPassages, qualityReviewSchema } from './delegated-quality';
import { renderDelegatedAdvice } from './delegated-output';
import type { DelegatedAdviceOutput } from '../../../packages/contracts/src/delegated-execution';

const fragment: DelegatedAdviceOutput = { title: 'Four-hour workshop', summary: 'The complete four-hour schedule is below.', findings: [], recommendations: [':00'], limitations: [], question: null };
const complete: DelegatedAdviceOutput = { ...fragment, summary: 'A four-hour workshop.', recommendations: ['00:00–01:00 — Welcome.', '01:00–02:00 — Develop options and break.', '02:00–03:00 — Test improvements.', '03:00–04:00 — Choose next steps and close.'] };
const initial = (verdict: 'accept' | 'reject' = 'accept') => ({ verdict, checks: qualityCategories.map(category => ({ category, requirement: `Evaluate ${category}.`, status: verdict === 'reject' && category === 'deliverables' ? 'missing' : 'satisfied', passageIds: ['draft-p001'] })), repairGuidance: verdict === 'accept' ? null : 'Deliver the complete requested agenda.' });
const repeated = (verdict: 'accept' | 'reject' = 'accept') => ({ verdict, checks: qualityCategories.map((_category, index) => ({ criterionId: `criterion-00${index + 1}`, status: verdict === 'reject' && index === 0 ? 'missing' : 'satisfied', passageIds: ['repair-p001'] })), repairGuidance: verdict === 'accept' ? null : 'The requested agenda is still absent.' });
const usage = { inputTokens: 7, outputTokens: 3, totalTokens: 10 };
function fixture(values: unknown[], advice = fragment) {
  const calls: Array<Omit<ModelRequest<unknown>, 'signal'>> = [], returned: Array<{role: string; result: ModelResult<unknown>}> = [];
  let now = 1000, revoked = false;
  const options = { context: { prompt: 'Give a four-hour workshop agenda.', childAdvice: [{ text: renderDelegatedAdvice(complete) }] }, advice, evidence: [], deadlineAt: 100000,
    now: () => now, assertCurrent: () => { if (revoked) throw Error('Lease revoked'); },
    run: async <T>(request: Omit<ModelRequest<T>, 'signal'>): Promise<ModelResult<T>> => { calls.push(request); const value = values.shift(); if (value instanceof Error) throw value; return { value: value as T, usage, deployment: azureDeployments[request.role] }; },
    recordReturned: (role: 'coordinator' | 'escalation', result: ModelResult<unknown>) => { returned.push({ role, result }); } };
  return { options, calls, returned, setNow: (value: number) => { now = value; }, revoke: () => { revoked = true; } };
}
describe('bounded root advisory quality gate with exact passages and frozen criteria', () => {
  it.each([fragment, { ...fragment, recommendations: ['00:00–03:20 — Workshop activities.'] }])('repairs one confirmed missing deliverable then reviews every frozen criterion', async bad => {
    const f = fixture([initial('reject'), complete, repeated()], bad);
    expect(await qualifyDelegatedAdvice(f.options)).toEqual({ state: 'accepted', advice: complete, repaired: true });
    expect(f.calls.map(c => [c.role, c.schemaName])).toEqual([['escalation', 'delegated_advice_quality'], ['coordinator', 'delegated_root_advice_repair'], ['escalation', 'delegated_advice_quality']]);
    const rereview = JSON.parse(f.calls[2]!.input), repair = JSON.parse(f.calls[1]!.input);
    expect(rereview.candidate.passages.map((p: any) => p.text).join('')).toBe(`${complete.title}\n\n${renderDelegatedAdvice(complete)}`);
    expect(rereview.frozenCriteria).toEqual(qualityCategories.map((category, index) => ({ criterionId: `criterion-00${index+1}`, category, requirement: `Evaluate ${category}.` })));
    expect(repair.context.childAdvice[0].text).toBe(renderDelegatedAdvice(complete)); expect(repair.qualityReview.checks.every((c: any) => !('quotes' in c))).toBe(true);
    expect(f.returned.map(r => r.role)).toEqual(['escalation', 'coordinator', 'escalation']); expect(f.returned.reduce((s, r) => s+r.result.usage.totalTokens, 0)).toBe(30);
  });
  it('preserves all exact text once across codepoint-safe chunks and draft namespaces', () => {
    const advice = { ...complete, recommendations: ['x'.repeat(1130)+'😀'.repeat(40)+'\n\n   \t'+ 'e\u0301日本語 '.repeat(180)] };
    const p = qualityPassages(advice, 'draft'), full = `${advice.title}\n\n${renderDelegatedAdvice(advice)}`;
    expect(p.map(x => x.text).join('')).toBe(full); expect(p.length).toBeGreaterThan(1); expect(p.every(x => x.text.length <= 1200 && x.text.length > 0)).toBe(true);
    expect(p.every(x => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(x.text))).toBe(true); expect(Object.isFrozen(p)).toBe(true); expect(p.every(Object.isFrozen)).toBe(true);
    expect(qualityPassages(advice, 'repair').every(x => x.id.startsWith('repair-'))).toBe(true);
  });
  it('preserves whitespace-only passages but refuses to count them as support', () => {
    const advice={...fragment,recommendations:[' '.repeat(1600)]},p=qualityPassages(advice,'draft'),blank=p.find(item=>! /\S/.test(item.text));expect(blank).toBeDefined();
    expect(p.map(item=>item.text).join('')).toBe(`${advice.title}\n\n${renderDelegatedAdvice(advice)}`);
    expect(()=>checkQualityReview({...initial(),checks:initial().checks.map(c=>({...c,passageIds:[blank!.id]}))},p)).toThrow();
  });
  it.each(['\uD800','\uDC00'])('blocks malformed Unicode intact instead of normalizing or dropping it', async text => {
    const f=fixture([],{...fragment,recommendations:[text]});expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(0);
  });
  it('exposes only exact passage IDs in the dynamic strict schema and resolves their immutable original text', () => {
    const p=qualityPassages(fragment,'draft'),schema=qualityReviewSchema(p),review=checkQualityReview(initial(),p);
    expect(schema.safeParse({...initial(),checks:initial().checks.map(c=>({...c,passageIds:['invented']}))}).success).toBe(false);
    expect(review.checks.every(c=>c.quotes[0]===p[0]!.text)).toBe(true);
  });
  it('accepts relevant references without a punctuation, English or minimum-length content heuristic', async () => {
    const terse={...complete,recommendations:['確認事項']};const f=fixture([initial()],terse);expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'accepted',advice:terse,repaired:false});expect(f.calls).toHaveLength(1);
  });
  it.each([
    {...initial(),checks:[]}, {...initial(),checks:initial().checks.slice(0,3)},
    {...initial(),checks:initial().checks.map(c=>({...c,category:'deliverables'}))},
    {...initial(),checks:initial().checks.map(c=>({...c,requirement:' \n\t'}))},
    {...initial(),checks:initial().checks.map(c=>({...c,passageIds:[]}))},
    {...initial(),checks:initial().checks.map(c=>({...c,passageIds:['draft-p001','draft-p001']}))},
    {...initial(),checks:initial().checks.map(c=>({...c,passageIds:['repair-p001']}))},
    {...initial(),checks:initial().checks.map(c=>({...c,passageIds:['invented']}))},
    {...initial(),checks:initial().checks.map(c=>({...c,quotes:['invented quotation']}))},
    {...initial(),checks:initial().checks.map(c=>({...c,status:'missing'}))},
    {...initial('reject'),checks:initial().checks}, {...initial('reject'),repairGuidance:null}, {...initial('reject'),repairGuidance:' \n'},
  ])('blocks invalid initial coverage/reference/verdict without repair',async value=>{const f=fixture([value]);expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(1);expect(f.returned).toHaveLength(1);});
  it('allows an absent passage only for a missing or unresolved check, never a satisfied one',()=>{
    const r=initial('reject');r.checks[0]!.passageIds=[];expect(checkQualityReview(r,qualityPassages(fragment,'draft')).verdict).toBe('reject');
  });
  it.each([
    {...repeated(),checks:repeated().checks.slice(0,2)},
    {...repeated(),checks:repeated().checks.map(()=>repeated().checks[0])},
    {...repeated(),checks:repeated().checks.map(c=>({...c,criterionId:'criterion-999'}))},
    {...repeated(),checks:repeated().checks.map(c=>({...c,requirement:'Rewritten requirement'}))},
    {...repeated(),checks:repeated().checks.map(c=>({...c,category:'deliverables'}))},
    {...repeated(),checks:repeated().checks.map(c=>({...c,passageIds:['draft-p001']}))},
    {...repeated(),checks:repeated().checks.map(c=>({...c,passageIds:['repair-p001','repair-p001']}))},
  ])('blocks dropped/duplicated/unknown/rewritten criteria and stale references after one repair',async value=>{const f=fixture([initial('reject'),complete,value]);expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(3);expect(f.returned).toHaveLength(3);});
  it('allows reordered second checks only when each frozen criterion occurs exactly once',async()=>{const f=fixture([initial('reject'),complete,{...repeated(),checks:repeated().checks.reverse()}]);expect((await qualifyDelegatedAdvice(f.options)).state).toBe('accepted');});
  it('blocks a second rejection without another repair',async()=>{const f=fixture([initial('reject'),complete,repeated('reject')]);expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(3);});
  it.each(['NETWORK','TIMEOUT','INCOMPLETE'] as const)('does not retry %s or fabricate missing usage',async code=>{const f=fixture([new NativeGatewayError(code)]);expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(1);expect(f.returned).toHaveLength(0);});
  it.each(['schema','refusal','incomplete'] as const)('accounts for actual gateway %s envelope usage before blocking',async mode=>{
    const f=fixture([]);let calls=0;const envelope={status:mode==='incomplete'?'incomplete':'completed',output:[{type:'message',role:'assistant',status:'completed',content:[mode==='refusal'?{type:'refusal'}:{type:'output_text',text:JSON.stringify({verdict:'accept',checks:[]})}]}],usage:{input_tokens:7,output_tokens:3,total_tokens:10}};
    const gateway=createAzureGateway({endpoint:'https://fixture.openai.azure.com/openai/v1',apiKey:'synthetic'},async()=>{calls++;return new Response(JSON.stringify(envelope));});f.options.run=request=>gateway.complete({...request,signal:new AbortController().signal});
    expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(calls).toBe(1);expect(f.returned).toEqual([{role:'escalation',result:{value:undefined,deployment:'gpt-6-astra',usage}}]);
  });
  it.each(['network','unparseable','inconsistent_usage'] as const)('does not fabricate usage on actual gateway %s',async mode=>{
    const f=fixture([]);let calls=0;const gateway=createAzureGateway({endpoint:'https://fixture.openai.azure.com/openai/v1',apiKey:'synthetic'},async()=>{calls++;if(mode==='network')throw Error('Synthetic network');return new Response(mode==='unparseable'?'{':JSON.stringify({status:'incomplete',output:[],usage:{input_tokens:7,output_tokens:3,total_tokens:11}}));});f.options.run=request=>gateway.complete({...request,signal:new AbortController().signal});
    expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(calls).toBe(1);expect(f.returned).toHaveLength(0);
  });
  it('does not reissue an unknown repair',async()=>{const f=fixture([initial('reject'),new NativeGatewayError('NETWORK')]);expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(2);expect(f.returned).toHaveLength(1);});
  it('requires at least fifteen seconds from the original deadline before an extra call',async()=>{const f=fixture([]);f.setNow(85001);expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(0);});
  it('cannot start repair after the original window is consumed',async()=>{const f=fixture([initial('reject')]);const run=f.options.run;f.options.run=async request=>{const r=await run(request);f.setNow(85001);return r;};expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(1);});
  it('refuses oversized full original context without dropping content',async()=>{const f=fixture([]);f.options.context.childAdvice[0]!.text='x'.repeat(150000);expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(0);});
  it('refuses an oversized complete repair context without shrinking the checklist',async()=>{const f=fixture([{...initial('reject'),repairGuidance:'x'.repeat(2400)}]);f.options.context.childAdvice[0]!.text='x'.repeat(146800);expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(1);});
  it('records returned usage before propagating a revoked lease',async()=>{const f=fixture([initial('reject')]);const run=f.options.run;f.options.run=async request=>{const r=await run(request);f.revoke();return r;};await expect(qualifyDelegatedAdvice(f.options)).rejects.toThrow('Lease revoked');expect(f.returned).toHaveLength(1);expect(f.calls).toHaveLength(1);});
  it('blocks an invalid repaired citation before rereview',async()=>{const f=fixture([initial('reject'),{...complete,findings:[{kind:'source_statement',text:'Unverified',citations:[{id:'fake',quote:'fake'}]}]}]);expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.calls).toHaveLength(2);expect(f.returned).toHaveLength(2);});
  it('counts usage before rejecting a wrong reviewer deployment',async()=>{const f=fixture([initial()]);const run=f.options.run;f.options.run=async request=>({...await run(request),deployment:'gpt-6.1-sol'});expect(await qualifyDelegatedAdvice(f.options)).toEqual({state:'blocked'});expect(f.returned).toHaveLength(1);});
});
