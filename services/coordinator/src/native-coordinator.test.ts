import { describe, expect, it, vi } from 'vitest';
import type { NativeDispatchClaim, NativeTask, NativeTaskClaim, NativeTaskProgress, NativeTaskWorkerRepository } from '@pactwoven/contracts';
import { NativeCoordinator } from './native-coordinator.js';
import { NativeGatewayError, azureDeployments, type ModelRequest, type ModelResult, type NativeModelGateway } from './azure-gateway.js';
import { evidenceValidUntil, type EvidenceDocument } from './native-evidence.js';

const timestamp = '2026-11-18T12:00:00Z';
const plan = { title: 'Office seating plan', objective: 'Compare seating approaches', constraints: ['Advisory only'], researchBrief: 'Review supplied facts', planningBrief: 'Compare options', requiresFreshEvidence: false, question: null };
const research = { summary: 'The available context supports a planning comparison.', findings: [{ text: 'Comfort should be checked.', kind: 'inference', quotes: [] }], uncertainties: ['No current prices were verified.'] };
const planning = { summary: 'Compare ergonomic fit first.', recommendations: [{ title: 'Check adjustable chairs', explanation: 'Prioritize fit and durability.', documentIds: [], conditions: ['Verify actual pricing before buying.'] }], unresolved: ['Current prices are unknown.'], escalationReason: null };
const synthesis = { title: 'Seating recommendation', summary: 'Compare ergonomics before committing.', recommendation: 'Shortlist adjustable seating, then verify fit and actual delivery.', documentIds: [], limitations: ['No live prices or availability checked.'], question: null };
function task(): NativeTask {
  return { id: 'task-one', title: 'New work', status: 'queued', phase: 'Queued', siteId: 'site-one', createdAt: timestamp, updatedAt: timestamp,
    version: 1, availableActions: ['pause', 'cancel', 'message'], prompt: 'Help plan comfortable office seating. Do not place orders.', mode: 'advise',
    steps: [], messages: [], artifacts: [], events: [] };
}
class TestRepository implements NativeTaskWorkerRepository {
  task = task(); checkpoint: Record<string, unknown> = {}; held = true; available = true; updates: NativeTaskProgress[] = [];
  onProgress: ((update: NativeTaskProgress) => void) | undefined;
  async claim(): Promise<NativeTaskClaim | null> {
    if (!this.available) return null;
    return { task: structuredClone(this.task), environment: 'development', organizationId: 'org-one', actorId: 'actor-one', leaseToken: 'lease-one', checkpoint: structuredClone(this.checkpoint) };
  }
  async renew() { return this.held; }
  async progress(_claim: NativeTaskClaim, update: NativeTaskProgress) {
    if (!this.held) return false;
    this.checkpoint = structuredClone(update.checkpoint); this.updates.push(structuredClone(update));
    this.task.status = update.status ?? this.task.status;
    if (update.title) this.task.title = update.title;
    if (update.steps) this.task.steps = structuredClone(update.steps);
    if (update.message) this.task.messages.push({ ...update.message, createdAt: timestamp });
    if (update.artifact) this.task.artifacts.push({ ...update.artifact, createdAt: timestamp });
    this.onProgress?.(update);
    return true;
  }
  async release() {}
}
class TestGateway implements NativeModelGateway {
  calls: ModelRequest<unknown>[] = [];
  values: Record<string, unknown> = { pactwoven_plan: plan, pactwoven_research: research, pactwoven_planning: planning, pactwoven_synthesis: synthesis, pactwoven_escalation: planning };
  onCall?: (request: ModelRequest<unknown>) => Promise<void>;
  async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.calls.push(request as ModelRequest<unknown>);
    await this.onCall?.(request as ModelRequest<unknown>);
    return { value: request.schema.parse(this.values[request.schemaName]), deployment: azureDeployments[request.role], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  }
}
const create = (repository: TestRepository, gateway: TestGateway, extra: Partial<ConstructorParameters<typeof NativeCoordinator>[0]> = {}) =>
  new NativeCoordinator({ repository, gateway, workerId: 'worker-one', retryDelayMilliseconds: 0, ...extra });

describe('native durable coordinator', () => {
  it('runs coordinator, research and planning with persisted actual results and usage', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); const meter = vi.fn();
    expect(await create(repository, gateway, { onUsage: meter }).runOnce()).toEqual({ status: 'completed', taskId: 'task-one' });
    expect(gateway.calls.map(call => call.role)).toEqual(['coordinator', 'research', 'planning', 'coordinator']);
    expect(repository.task.title).toBe(plan.title);
    expect(repository.task.artifacts.map(artifact => artifact.kind)).toEqual(['research', 'comparison', 'report']);
    expect(repository.task.messages[0]?.text).toContain('No live prices or availability checked.');
    expect(repository.task.steps.every(step => step.status === 'completed')).toBe(true);
    expect(repository.checkpoint.usage).toEqual({ inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    expect(meter).toHaveBeenCalledTimes(4);
    expect(gateway.calls.every(call => call.instructions.includes('ADVISE mode'))).toBe(true);
  });
  it('does not call a model when the queue is empty', async () => {
    const repository = new TestRepository(); repository.available = false; const gateway = new TestGateway();
    expect(await create(repository, gateway).runOnce()).toEqual({ status: 'idle' }); expect(gateway.calls).toHaveLength(0);
  });
  it('asks for an essential constraint and waits durably', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); gateway.values.pactwoven_plan = { ...plan, question: 'How many chairs are needed?' };
    expect(await create(repository, gateway).runOnce()).toMatchObject({ status: 'waiting' });
    expect(repository.task.status).toBe('waiting_for_input'); expect(gateway.calls).toHaveLength(1);
    expect(repository.task.messages[0]?.text).toBe('How many chairs are needed?');
  });
  it('never substitutes imagined live research when fresh sources are required', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); gateway.values.pactwoven_plan = { ...plan, requiresFreshEvidence: true };
    expect(await create(repository, gateway).runOnce()).toMatchObject({ status: 'waiting' });
    expect(gateway.calls).toHaveLength(1);
    expect(repository.task.messages[0]?.text).toContain('I have not checked live prices or availability.');
    expect(repository.task.artifacts).toHaveLength(0);
  });
  it('uses only scoped retrieved documents and checks literal quotes', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); gateway.values.pactwoven_plan = { ...plan, requiresFreshEvidence: true };
    const document: EvidenceDocument = { id: 'source-one', title: 'Provided supplier quote', text: 'The quote is 125 units.', source: { title: 'Supplier', url: 'https://supplier.example/quote' }, origin: 'retrieved', observedAt: timestamp, validUntil: evidenceValidUntil(timestamp) };
    gateway.values.pactwoven_research = { ...research, findings: [{ text: 'The quoted amount is 125 units.', kind: 'quoted_fact', quotes: [{ documentId: document.id, text: 'The quote is 125 units.' }] }] };
    gateway.values.pactwoven_synthesis = { ...synthesis, documentIds: ['source-one'] };
    const read = vi.fn().mockResolvedValue([document]);
    expect(await create(repository, gateway, { evidenceReader: { read }, now: () => Date.parse(timestamp) }).runOnce()).toMatchObject({ status: 'completed' });
    expect(read.mock.calls[0]?.[0]).toMatchObject({ environment: 'development', organizationId: 'org-one', actorId: 'actor-one', siteId: 'site-one', taskId: 'task-one' });
    expect(repository.task.artifacts[0]?.sources).toEqual([document.source]);
    expect(repository.task.artifacts[0]?.text).toContain('“The quote is 125 units.”');
  });
  it.each([
    { text: 'Invented verified fact', kind: 'quoted_fact', quotes: [] },
    { text: 'Invented quote', kind: 'quoted_fact', quotes: [{ documentId: 'missing', text: 'made up' }] },
  ])('rejects fabricated evidence before recommendations are created', async finding => {
    const repository = new TestRepository(); const gateway = new TestGateway(); gateway.values.pactwoven_research = { ...research, findings: [finding] };
    expect(await create(repository, gateway).runOnce()).toMatchObject({ status: 'failed' });
    expect(gateway.calls).toHaveLength(2); expect(repository.task.artifacts).toHaveLength(0);
  });
  it('rejects an invented final citation even when earlier steps passed', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); gateway.values.pactwoven_synthesis = { ...synthesis, documentIds: ['invented-source'] };
    expect(await create(repository, gateway).runOnce()).toMatchObject({ status: 'failed' });
    expect(repository.task.artifacts.some(item => item.kind === 'report')).toBe(false);
  });
  it('resumes a saved stage after interruption without rerunning completed specialists', async () => {
    const repository = new TestRepository(); const first = new TestGateway(); const controller = new AbortController();
    repository.onProgress = update => { if (update.artifact?.kind === 'research') controller.abort(); };
    expect(await create(repository, first).runOnce({ signal: controller.signal })).toMatchObject({ status: 'interrupted' });
    expect(first.calls.map(call => call.schemaName)).toEqual(['pactwoven_plan', 'pactwoven_research']);
    repository.onProgress = undefined;
    const second = new TestGateway();
    expect(await create(repository, second).runOnce()).toMatchObject({ status: 'completed' });
    expect(second.calls.map(call => call.schemaName)).toEqual(['pactwoven_planning', 'pactwoven_synthesis']);
    expect(repository.task.artifacts.filter(item => item.kind === 'research')).toHaveLength(1);
  });
  it('does not reuse a checkpoint after user steering changes the objective context', async () => {
    const repository = new TestRepository(); const first = new TestGateway(); const controller = new AbortController();
    repository.onProgress = update => { if (update.artifact?.kind === 'research') controller.abort(); };
    await create(repository, first).runOnce({ signal: controller.signal }); repository.onProgress = undefined;
    repository.task.messages.push({ id: 'steering-one', role: 'user', text: 'Actually plan for six people.', createdAt: timestamp });
    const second = new TestGateway();
    await create(repository, second).runOnce(); expect(second.calls[0]?.schemaName).toBe('pactwoven_plan');
    expect(second.calls[0]?.input).toContain('six people');
  });
  it('caps retries durably and does not retry refusals', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); gateway.onCall = async () => { throw new NativeGatewayError('RATE_LIMITED', true); };
    expect(await create(repository, gateway).runOnce()).toMatchObject({ status: 'failed' }); expect(gateway.calls).toHaveLength(3);
    expect(repository.checkpoint.attempts).toMatchObject({ plan: 3 });
    const second = new TestGateway(); await create(repository, second).runOnce(); expect(second.calls).toHaveLength(0);
    const refusalRepo = new TestRepository(); const refusal = new TestGateway(); refusal.onCall = async () => { throw new NativeGatewayError('REFUSED'); };
    await create(refusalRepo, refusal).runOnce(); expect(refusal.calls).toHaveLength(1);
  });
  it('uses Astra once for a concrete ambiguity, without recursive escalation', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); gateway.values.pactwoven_planning = { ...planning, escalationReason: 'Two constraints conflict.' };
    gateway.values.pactwoven_escalation = { ...planning, escalationReason: 'Do it again.' };
    await create(repository, gateway).runOnce(); expect(gateway.calls.map(call => call.role)).toEqual(['coordinator', 'research', 'planning', 'escalation', 'coordinator']);
    expect(repository.checkpoint.escalationComplete).toBe(true);
  });
  it('retries unfinished work only after a new operator resume, retaining completed stages and usage', async () => {
    const repository = new TestRepository();
    const failing = new TestGateway();
    failing.onCall = async request => { if (request.schemaName === 'pactwoven_planning') throw new NativeGatewayError('NETWORK', true); };
    expect(await create(repository, failing).runOnce()).toMatchObject({ status: 'failed' });
    expect(repository.checkpoint.attempts).toMatchObject({ planning: 3 });
    expect(repository.task.artifacts).toHaveLength(1);
    const restart = new TestGateway();
    await create(repository, restart).runOnce();
    expect(restart.calls).toHaveLength(0);
    repository.task.status = 'queued';
    repository.task.events.push({ sequence: 10, kind: 'resumed', title: 'Retry requested', detail: '', agent: null, createdAt: timestamp });
    const recovered = new TestGateway();
    expect(await create(repository, recovered).runOnce()).toMatchObject({ status: 'completed' });
    expect(recovered.calls.map(call => call.schemaName)).toEqual(['pactwoven_planning', 'pactwoven_synthesis']);
    expect(repository.task.artifacts.filter(artifact => artifact.kind === 'research')).toHaveLength(1);
    expect(repository.checkpoint.usage).toEqual({ inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    expect(repository.checkpoint.resumedThrough).toBe(10);
  });
  it('does not reuse an old resume event to renew exhausted attempts after a restart', async () => {
    const repository = new TestRepository();
    repository.task.events.push({ sequence: 4, kind: 'resumed', title: 'Resume requested', detail: '', agent: null, createdAt: timestamp });
    const failing = new TestGateway();
    failing.onCall = async () => { throw new NativeGatewayError('NETWORK', true); };
    await create(repository, failing).runOnce();
    const restart = new TestGateway();
    await create(repository, restart).runOnce();
    expect(restart.calls).toHaveLength(0);
  });
  it('aborts an in-flight call when lease renewal fails, without publishing its result', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway();
    gateway.onCall = async request => { repository.held = false; await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })); };
    expect(await create(repository, gateway, { heartbeatMilliseconds: 5 }).runOnce()).toMatchObject({ status: 'interrupted' });
    expect(repository.task.artifacts).toHaveLength(0); expect(repository.task.status).toBe('running');
    expect(repository.updates).toHaveLength(3);
  });
  it('preserves evidence when the run deadline expires and does not leak raw failures', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway();
    gateway.onCall = async request => new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
    expect(await create(repository, gateway, { runDeadlineMilliseconds: 5 }).runOnce()).toMatchObject({ status: 'failed' });
    expect(repository.updates.at(-1)?.event.detail).toContain('execution time limit');
    const failed = new TestRepository(); const bad = new TestGateway(); bad.onCall = async () => { throw new Error('secret-connection-string'); };
    await create(failed, bad).runOnce(); expect(JSON.stringify(failed.updates)).not.toContain('secret-connection-string');
  });
  it('does not reset a malformed persisted checkpoint and bypass retry bounds', async () => {
    const repository = new TestRepository(); repository.checkpoint = { schemaVersion: 999, attempts: { plan: 99 } }; const gateway = new TestGateway();
    expect(await create(repository, gateway).runOnce()).toMatchObject({ status: 'failed' });
    expect(gateway.calls).toHaveLength(0); expect(repository.updates.at(-1)?.event.detail).toContain('recovery review');
  });
  it('returns committed completion even if cancellation arrives during the final save', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); const controller = new AbortController();
    repository.onProgress = update => { if (update.status === 'completed') controller.abort(); };
    expect(await create(repository, gateway).runOnce({ signal: controller.signal })).toMatchObject({ status: 'completed' });
    expect(repository.task.status).toBe('completed');
  });
  it('never presents source-reader errors as fabricated evidence', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway();
    const read = vi.fn().mockRejectedValue(new Error('private network diagnostic'));
    expect(await create(repository, gateway, { evidenceReader: { read } }).runOnce()).toMatchObject({ status: 'failed' });
    expect(gateway.calls).toHaveLength(0); expect(repository.task.artifacts).toHaveLength(0);
    expect(JSON.stringify(repository.updates)).not.toContain('private network diagnostic');
  });
  it('makes already available source documents visible to the coordinator before it asks questions', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway();
    const document: EvidenceDocument = { id: 'source-one', title: 'Provided quote', text: 'Ten chairs cost 1100 units delivered.', source: null, origin: 'user_supplied', observedAt: timestamp };
    await create(repository, gateway, { evidenceReader: { read: async () => [document] } }).runOnce();
    expect(gateway.calls[0]?.input).toContain('Ten chairs cost 1100 units delivered.');
    expect(repository.updates[0]?.phase).toBe('Checking available sources');
  });
  it('does not truncate an oversized conversation silently', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway();
    repository.task.messages = Array.from({ length: 3 }, (_, i) => ({ id: `message-${i}`, role: 'user', text: 'x'.repeat(30_000), createdAt: timestamp }));
    expect(await create(repository, gateway).runOnce()).toMatchObject({ status: 'waiting' });
    expect(gateway.calls).toHaveLength(0); expect(repository.task.messages.at(-1)?.text).toContain('too long');
  });
  it('does not let a broken metering observer replay a successful model call', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway();
    expect(await create(repository, gateway, { onUsage: () => { throw new Error('logging unavailable'); } }).runOnce()).toMatchObject({ status: 'completed' });
    expect(gateway.calls).toHaveLength(4);
  });
});

class SliceRepository extends TestRepository {
  generation = 1;
  yields: { work: NativeDispatchClaim; progress: NativeTaskProgress; delayMilliseconds: number }[] = [];
  onYield: (() => void) | undefined;
  work(): NativeDispatchClaim {
    this.task.status = 'running';
    return { claim: { task: structuredClone(this.task), environment: 'development', organizationId: 'org-one', actorId: 'actor-one',
      leaseToken: `00000000-0000-4000-8000-${String(this.generation).padStart(12, '0')}`, checkpoint: structuredClone(this.checkpoint) },
    dispatch: { schemaVersion: 1, engineRevision: 'native-advice-v1', environment: 'development', organizationId: 'org-one', taskId: this.task.id, generation: this.generation } };
  }
  async yieldClaim(work: NativeDispatchClaim, progress: NativeTaskProgress, delayMilliseconds = 0) {
    if (!this.held || work.dispatch.generation !== this.generation) return false;
    await super.progress(work.claim, progress);
    this.yields.push({ work: structuredClone(work), progress: structuredClone(progress), delayMilliseconds });
    this.task.status = 'queued'; this.generation++;
    this.onYield?.();
    return true;
  }
}
function slice(repository: SliceRepository, gateway: TestGateway, extra: Partial<ConstructorParameters<typeof NativeCoordinator>[0]> = {}) {
  return create(repository, gateway, { dispatchRepository: repository, ...extra });
}
const sliceDeadline = () => ({ deadlineAt: Date.now() + 300_000 });

describe('source validity across durable work', () => {
  function evidence(at: number, text = 'The observed price is 125 units.'): EvidenceDocument {
    const observedAt = new Date(at).toISOString();
    return { id: 'source-one', title: 'Supplier quote', text, source: { title: 'Supplier quote', url: 'https://supplier.example/quote' },
      origin: 'retrieved', observedAt, validUntil: evidenceValidUntil(observedAt) };
  }
  async function pauseAfterResearch(repository: TestRepository, at: number) {
    const gateway = new TestGateway(); gateway.values.pactwoven_plan = { ...plan, requiresFreshEvidence: true };
    gateway.values.pactwoven_research = { ...research, findings: [{ text: 'The observed price is 125 units.', kind: 'quoted_fact',
      quotes: [{ documentId: 'source-one', text: 'The observed price is 125 units.' }] }] };
    const controller = new AbortController();
    repository.onProgress = update => { if (update.artifact?.kind === 'research') controller.abort(); };
    expect(await create(repository, gateway, { now: () => at, evidenceReader: { read: async () => [evidence(at)] } }).runOnce({ signal: controller.signal })).toMatchObject({ status: 'interrupted' });
    repository.onProgress = undefined;
    return gateway;
  }
  it('refreshes expired source text after restart, rebuilds dependent work, and keeps historical provenance and budgets', async () => {
    const repository = new TestRepository(); const at = Date.parse(timestamp);
    await pauseAfterResearch(repository, at);
    const oldResearch = structuredClone(repository.task.artifacts[0]);
    const gateway = new TestGateway(); gateway.values.pactwoven_plan = { ...plan, requiresFreshEvidence: true };
    const newTime = at + 15 * 60_000;
    const read = vi.fn(async () => [evidence(newTime, 'The observed price changed to 175 units.')]);
    expect(await create(repository, gateway, { now: () => newTime, evidenceReader: { read } }).runOnce()).toMatchObject({ status: 'completed' });
    expect(read).toHaveBeenCalledOnce();
    expect(gateway.calls.map(call => call.schemaName)).toEqual(['pactwoven_plan', 'pactwoven_research', 'pactwoven_planning', 'pactwoven_synthesis']);
    expect(gateway.calls[0]?.input).toContain('changed to 175'); expect(gateway.calls[0]?.input).not.toContain('125 units');
    expect(repository.task.artifacts[0]).toEqual(oldResearch);
    const historical = repository.task.artifacts.find(artifact => artifact.title.startsWith('Earlier source:'))!;
    expect(historical.text).toContain('125 units'); expect(historical.text).toContain(evidence(at).observedAt);
    expect(historical.text).toContain('not current evidence'); expect(historical.sources).toEqual([evidence(at).source]);
    expect(new Set(repository.task.artifacts.map(artifact => artifact.id)).size).toBe(repository.task.artifacts.length);
    expect(repository.checkpoint.attempts).toMatchObject({ evidence: 2, plan: 2, research: 2, planning: 1, synthesis: 1 });
    expect(repository.checkpoint.usage).toEqual({ inputTokens: 60, outputTokens: 30, totalTokens: 90 });
    expect(repository.checkpoint.evidenceRevision).toBe(1);
  });
  it('invalidates a prepared recommendation at the exact UTC date boundary before publishing it', async () => {
    const repository = new SliceRepository(); let at = Date.parse('2026-11-18T23:59:55Z'); const observed = at;
    const gateway = new TestGateway(); const read = vi.fn(async () => [evidence(at)]);
    for (let stage = 0; stage < 5; stage++) {
      expect(await slice(repository, gateway, { now: () => at, evidenceReader: { read } }).runClaimSlice(repository.work(), sliceDeadline())).toMatchObject({ status: 'yielded' });
    }
    expect(repository.checkpoint.synthesis).not.toBeNull();
    at = Date.parse('2026-11-19T00:00:00Z');
    expect(await slice(repository, gateway, { now: () => at, evidenceReader: { read } }).runClaimSlice(repository.work(), sliceDeadline())).toMatchObject({ status: 'yielded' });
    expect(repository.checkpoint.plan).toBeNull(); expect(repository.checkpoint.research).toBeNull();
    expect(repository.checkpoint.planning).toBeNull(); expect(repository.checkpoint.synthesis).toBeNull();
    expect(repository.task.artifacts.some(artifact => artifact.kind === 'report')).toBe(false);
    expect(repository.task.artifacts.at(-1)?.text).toContain(evidence(observed).observedAt);
    expect(gateway.calls).toHaveLength(4); expect(repository.checkpoint.attempts).toMatchObject({ evidence: 1, synthesis: 1 });
  });
  it('discards a model result that expires in flight, accounts for it, and refreshes without resetting attempts', async () => {
    const repository = new TestRepository(); let at = Date.parse(timestamp); const gateway = new TestGateway();
    const read = vi.fn(async () => [{ ...evidence(at), validUntil: new Date(at + 5_000).toISOString() }]);
    gateway.onCall = async () => { if (gateway.calls.length === 1) at += 5_000; };
    expect(await create(repository, gateway, { now: () => at, evidenceReader: { read } }).runOnce()).toMatchObject({ status: 'completed' });
    expect(read).toHaveBeenCalledTimes(2); expect(gateway.calls.map(call => call.schemaName)).toEqual(['pactwoven_plan', 'pactwoven_plan', 'pactwoven_research', 'pactwoven_planning', 'pactwoven_synthesis']);
    expect(repository.checkpoint.attempts).toMatchObject({ evidence: 2, plan: 2 });
    expect(repository.checkpoint.usage).toEqual({ inputTokens: 50, outputTokens: 25, totalTokens: 75 });
  });
  it('keeps the original slice deadline while refreshing an observation that expired during a model call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse(timestamp));
      const at = Date.now(); const repository = new SliceRepository(); const gateway = new TestGateway();
      const read = vi.fn(async () => [{ ...evidence(at), validUntil: new Date(at + 5_000).toISOString() }]);
      const deadline = { deadlineAt: at + 120_000 };
      await slice(repository, gateway, { evidenceReader: { read } }).runClaimSlice(repository.work(), deadline);
      gateway.onCall = async () => { vi.setSystemTime(at + 30_000); };
      expect(await slice(repository, gateway, { evidenceReader: { read } }).runClaimSlice(repository.work(), deadline)).toMatchObject({ status: 'yielded' });
      expect(repository.checkpoint.documentsLoaded).toBe(false); expect(repository.checkpoint.plan).toBeNull();
      expect(await slice(repository, gateway, { evidenceReader: { read } }).runClaimSlice(repository.work(), deadline)).toMatchObject({ status: 'yielded' });
      expect(read).toHaveBeenCalledOnce(); expect(gateway.calls).toHaveLength(1);
      expect(repository.checkpoint.attempts).toMatchObject({ evidence: 1, plan: 1 });
    } finally { vi.useRealTimers(); }
  });
  it('fails closed on cached expired observations and cannot reset its source-attempt cap across restarts', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); const at = Date.parse(timestamp);
    const read = vi.fn(async () => [evidence(at)]);
    for (let restart = 0; restart < 3; restart++) {
      expect(await create(repository, gateway, { now: () => at + 900_000, evidenceReader: { read } }).runOnce()).toMatchObject({ status: 'waiting' });
    }
    expect(read).toHaveBeenCalledTimes(3); expect(gateway.calls).toHaveLength(0);
    expect(repository.checkpoint.attempts).toMatchObject({ evidence: 3, plan: 0 });
    expect(repository.task.messages.at(-1)?.text).toContain('source-attempt limit');
    expect(repository.task.artifacts.every(artifact => artifact.text.includes('not current evidence'))).toBe(true);
    expect(repository.task.artifacts).toHaveLength(3);
  });
  it('refreshes a legacy checkpoint with missing validity without promoting old results or resetting usage', async () => {
    const repository = new TestRepository(); const at = Date.parse(timestamp);
    await pauseAfterResearch(repository, at);
    repository.checkpoint.schemaVersion = 1; delete repository.checkpoint.evidenceRevision;
    for (const document of repository.checkpoint.documents as EvidenceDocument[]) delete document.validUntil;
    const gateway = new TestGateway(); const read = vi.fn(async () => [evidence(at + 1_000, 'A fresh observation.')]);
    expect(await create(repository, gateway, { now: () => at + 1_000, evidenceReader: { read } }).runOnce()).toMatchObject({ status: 'completed' });
    expect(repository.checkpoint.schemaVersion).toBe(2); expect(read).toHaveBeenCalledOnce();
    expect(gateway.calls[0]?.schemaName).toBe('pactwoven_plan'); expect(gateway.calls[0]?.input).toContain('fresh observation');
    expect(repository.checkpoint.attempts).toMatchObject({ evidence: 2, plan: 2, research: 2 });
    expect(repository.checkpoint.usage).toEqual({ inputTokens: 60, outputTokens: 30, totalTokens: 90 });
    expect(repository.task.artifacts.some(artifact => artifact.text.includes('Valid until: Not recorded'))).toBe(true);
  });
  it('retains old observations and honestly waits when the previously available source is now unavailable', async () => {
    const repository = new TestRepository(); const at = Date.parse(timestamp); await pauseAfterResearch(repository, at);
    const gateway = new TestGateway(); gateway.values.pactwoven_plan = { ...plan, requiresFreshEvidence: true };
    const read = vi.fn(async () => []);
    expect(await create(repository, gateway, { now: () => at + 900_000, evidenceReader: { read } }).runOnce()).toMatchObject({ status: 'waiting' });
    expect(gateway.calls.map(call => call.schemaName)).toEqual(['pactwoven_plan']);
    expect(repository.task.messages.at(-1)?.text).toContain('no live source was available');
    expect(repository.task.artifacts.some(artifact => artifact.kind === 'report')).toBe(false);
    expect(repository.task.artifacts.some(artifact => artifact.text.includes('Historical source observation'))).toBe(true);
    expect(repository.checkpoint.documents).toEqual([]);
  });
  it('stops at saved-record capacity without deleting historical source bytes or calling another provider', async () => {
    const repository = new TestRepository(); const at = Date.parse(timestamp); await pauseAfterResearch(repository, at);
    while (repository.task.artifacts.length < 32) repository.task.artifacts.push({ id: `historical-${repository.task.artifacts.length}`, kind: 'research', title: 'Earlier work', text: 'Preserved work.', sources: [], createdAt: timestamp });
    const before = structuredClone(repository.task.artifacts); const gateway = new TestGateway(); const read = vi.fn(async () => []);
    expect(await create(repository, gateway, { now: () => at + 900_000, evidenceReader: { read } }).runOnce()).toMatchObject({ status: 'waiting' });
    expect(repository.task.artifacts).toEqual(before); expect(repository.checkpoint.documents).toEqual([evidence(at)]);
    expect(repository.checkpoint.research).toBeNull(); expect(repository.task.messages.at(-1)?.text).toContain('saved-record limit');
    expect(gateway.calls).toHaveLength(0); expect(read).not.toHaveBeenCalled();
  });
  it.each(['legacy', 'slice'] as const)('preserves every source around before/after-commit archive errors in %s work', async mode => {
    for (const timing of ['before', 'after'] as const) {
      const repository = new SliceRepository(); const at = Date.parse(timestamp); const gateway = new TestGateway();
      const documents = [0, 1, 2].map(index => ({ ...evidence(at, `Original source bytes ${index}`), id: `source-${index}`, title: `Source ${index}` }));
      const controller = new AbortController();
      repository.onProgress = update => { if (update.phase === 'Sources are ready for review') controller.abort(); };
      await create(repository, gateway, { now: () => at, evidenceReader: { read: async () => documents } }).runOnce({ signal: controller.signal });
      repository.onProgress = undefined;
      const release = vi.spyOn(repository, 'release');
      const fresh = { now: () => at + 900_000, evidenceReader: { read: async () => documents.map(document => ({ ...document, observedAt: new Date(at + 900_000).toISOString(), validUntil: evidenceValidUntil(new Date(at + 900_000).toISOString()) })) } };
      let archives = 0;
      const originalProgress = repository.progress.bind(repository), originalYield = repository.yieldClaim.bind(repository);
      const rejectArchive = async (update: NativeTaskProgress, apply: () => Promise<boolean>) => {
        if (update.artifact?.title.startsWith('Earlier source:') && ++archives === 2) {
          if (timing === 'after') await apply();
          throw new Error('The archive response was not confirmed.');
        }
        return apply();
      };
      if (mode === 'legacy') repository.progress = (claim, update) => rejectArchive(update, () => originalProgress(claim, update));
      else repository.yieldClaim = (work, progress, delay = 0) => rejectArchive(progress, () => originalYield(work, progress, delay));
      const run = () => mode === 'legacy' ? create(repository, gateway, fresh).runOnce()
        : slice(repository, gateway, fresh).runClaimSlice(repository.work(), sliceDeadline());
      if (mode === 'slice') expect(await run()).toMatchObject({ status: 'yielded' });
      expect(await run()).toMatchObject({ status: 'interrupted' });
      expect(release).not.toHaveBeenCalled();
      expect(repository.updates.some(update => update.status === 'failed')).toBe(false);
      for (const document of documents) {
        expect(JSON.stringify(repository.checkpoint).includes(document.text) || repository.task.artifacts.some(artifact => artifact.text.includes(document.text))).toBe(true);
      }
      repository.progress = originalProgress; repository.yieldClaim = originalYield;
      for (let attempt = 0; attempt < 9; attempt++) { if ((await run()).status === 'completed') break; }
      const history = repository.task.artifacts.filter(artifact => artifact.title.startsWith('Earlier source:'));
      expect(history).toHaveLength(3); expect(new Set(history.map(artifact => artifact.id)).size).toBe(3);
      for (const document of documents) expect(history.some(artifact => artifact.text.includes(document.text) && artifact.text.includes(document.observedAt))).toBe(true);
      expect(repository.task.status).toBe('completed');
      expect(repository.checkpoint.attempts).toMatchObject({ evidence: 2, plan: 1, research: 1, planning: 1, synthesis: 1 });
    }
  });
  it('checks freshness after the attempt save and dispatches no model with the expired input', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); let at = Date.parse(timestamp);
    const read = vi.fn(async () => [evidence(at)]);
    repository.onProgress = update => { if (update.phase === 'Understanding your objective') at += 900_000; };
    expect(await create(repository, gateway, { now: () => at, evidenceReader: { read } }).runOnce()).toMatchObject({ status: 'waiting' });
    expect(gateway.calls).toHaveLength(0); expect(read).toHaveBeenCalledTimes(3);
    expect(repository.checkpoint.attempts).toMatchObject({ evidence: 3, plan: 3 });
    expect(repository.checkpoint.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
  it('keeps remaining source bytes when a partial multi-source archive reaches32 records', async () => {
    const repository = new TestRepository(); const at = Date.parse(timestamp); const gateway = new TestGateway();
    const documents = [0, 1, 2].map(index => ({ ...evidence(at, `Original source ${index}`), id: `source-${index}`, title: `Source ${index}` }));
    const controller = new AbortController();
    repository.onProgress = update => { if (update.phase === 'Sources are ready for review') controller.abort(); };
    await create(repository, gateway, { now: () => at, evidenceReader: { read: async () => documents } }).runOnce({ signal: controller.signal });
    repository.onProgress = undefined;
    repository.task.artifacts = Array.from({ length: 31 }, (_, index) => ({ id: `earlier-${index}`, kind: 'research' as const, title: 'Earlier record', text: 'Preserved.', sources: [], createdAt: timestamp }));
    const read = vi.fn(async () => []);
    expect(await create(repository, gateway, { now: () => at + 900_000, evidenceReader: { read } }).runOnce()).toMatchObject({ status: 'waiting' });
    expect(repository.task.artifacts).toHaveLength(32); expect(repository.task.artifacts.at(-1)?.text).toContain(documents[0]!.text);
    expect(repository.checkpoint.documents).toEqual(documents.slice(1));
    expect(read).not.toHaveBeenCalled(); expect(gateway.calls).toHaveLength(0);
  });
  it('checks remaining slice time after a slow attempt save before dispatching the model', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse(timestamp)); const repository = new SliceRepository(); const gateway = new TestGateway();
      const deadline = { deadlineAt: Date.now() + 120_000 };
      await slice(repository, gateway).runClaimSlice(repository.work(), deadline);
      repository.onProgress = update => { if (update.phase === 'Understanding your objective') vi.setSystemTime(Date.now() + 30_000); };
      expect(await slice(repository, gateway).runClaimSlice(repository.work(), deadline)).toMatchObject({ status: 'yielded' });
      expect(gateway.calls).toHaveLength(0); expect(repository.checkpoint.attempts).toMatchObject({ plan: 1 });
    } finally { vi.useRealTimers(); }
  });
  it('rebuilds after the database definitively rolls back an expired final publication', async () => {
    const repository = new TestRepository(); const gateway = new TestGateway(); let at = Date.parse(timestamp);
    const initial = at; let rejected = false;
    const original = repository.progress.bind(repository);
    const finals: NativeTaskProgress[] = [];
    repository.progress = async (claim, update) => {
      if (update.status === 'completed') {
        finals.push(structuredClone(update));
        if (!rejected) {
          rejected = true; at += 900_000;
          throw Object.assign(new Error('Evidence expired under the database lock.'), { code: 'EVIDENCE_STALE', status: 409 });
        }
      }
      return original(claim, update);
    };
    const read = vi.fn(async () => [evidence(at, `Observation at ${at}`)]);
    expect(await create(repository, gateway, { now: () => at, evidenceReader: { read } }).runOnce()).toMatchObject({ status: 'completed' });
    expect(finals).toHaveLength(2);
    expect(finals[0]).toHaveProperty('evidenceValidUntil', evidenceValidUntil(new Date(initial).toISOString()));
    expect(finals[1]).toHaveProperty('evidenceValidUntil', evidenceValidUntil(new Date(at).toISOString()));
    expect(repository.task.artifacts.filter(artifact => artifact.kind === 'report')).toHaveLength(1);
    expect(repository.task.messages).toHaveLength(1);
    expect(repository.checkpoint.attempts).toMatchObject({ evidence: 2, plan: 2, research: 2, planning: 2, synthesis: 2 });
    expect(repository.checkpoint.usage).toEqual({ inputTokens: 80, outputTokens: 40, totalTokens: 120 });
  });
});

describe('bounded native coordinator slices', () => {
  it('uses only the targeted claim and atomically yields each source/model stage without legacy release', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway();
    const claim = vi.spyOn(repository, 'claim'); const release = vi.spyOn(repository, 'release'); const progress = vi.spyOn(repository, 'progress');
    const callsPerSlice: number[] = []; const statuses: string[] = [];
    for (let i = 0; i < 6; i++) {
      const before = gateway.calls.length;
      statuses.push((await slice(repository, gateway).runClaimSlice(repository.work(), sliceDeadline())).status);
      callsPerSlice.push(gateway.calls.length - before);
    }
    expect(statuses).toEqual(['yielded', 'yielded', 'yielded', 'yielded', 'yielded', 'completed']);
    expect(callsPerSlice).toEqual([0, 1, 1, 1, 1, 0]);
    expect(claim).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
    expect(progress.mock.calls.filter(([, update]) => update.artifact).map(([, update]) => update.artifact?.kind)).toEqual(['report']);
    expect(repository.yields.filter(item => item.progress.artifact).map(item => item.progress.artifact?.kind)).toEqual(['research', 'comparison']);
    expect(repository.task.artifacts.map(item => item.kind)).toEqual(['research', 'comparison', 'report']);
    expect(repository.checkpoint.usage).toEqual({ inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    expect(repository.yields.every(item => item.progress.event.kind !== 'resumed')).toBe(true);
  });
  it.each([0, 50_000])('uses the pre-claim absolute deadline and starts no work with %s ms left', async remaining => {
    const repository = new SliceRepository(); const gateway = new TestGateway(); const read = vi.fn().mockResolvedValue([]);
    expect(await slice(repository, gateway, { evidenceReader: { read } }).runClaimSlice(repository.work(), { deadlineAt: Date.now() + remaining })).toMatchObject({ status: 'yielded' });
    expect(read).not.toHaveBeenCalled(); expect(gateway.calls).toHaveLength(0);
    expect(repository.checkpoint.attempts).toMatchObject({ evidence: 0, plan: 0 });
    expect(repository.task.status).toBe('queued');
  });
  it('aborts a source attempt at the remaining slice deadline and preserves a continuation instead of failure', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway(); let aborted = false;
    const read = vi.fn(request => new Promise<EvidenceDocument[]>((_resolve, reject) => request.signal.addEventListener('abort', () => { aborted = true; reject(new Error('source aborted')); }, { once: true })));
    expect(await slice(repository, gateway, { evidenceReader: { read } }).runClaimSlice(repository.work(), {
      deadlineAt: Date.now() + 30, reserveMilliseconds: 5, minimumAttemptMilliseconds: 1,
    })).toMatchObject({ status: 'yielded' });
    expect(aborted).toBe(true); expect(repository.checkpoint.attempts).toMatchObject({ evidence: 1 });
    expect(repository.checkpoint.documentsLoaded).toBe(false); expect(gateway.calls).toHaveLength(0);
    expect(repository.updates.some(update => update.status === 'failed')).toBe(false);
  });
  it('aborts a model at the slice deadline and never resets its attempt count', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway();
    await slice(repository, gateway).runClaimSlice(repository.work(), sliceDeadline());
    gateway.onCall = request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new NativeGatewayError('CANCELLED')), { once: true }));
    expect(await slice(repository, gateway).runClaimSlice(repository.work(), {
      deadlineAt: Date.now() + 30, reserveMilliseconds: 5, minimumAttemptMilliseconds: 1,
    })).toMatchObject({ status: 'yielded' });
    expect(gateway.calls).toHaveLength(1); expect(repository.checkpoint.attempts).toMatchObject({ plan: 1 });
    expect(repository.checkpoint.plan).toBeNull(); expect(repository.task.status).toBe('queued');
    expect(repository.updates.some(update => update.status === 'failed')).toBe(false);
  });
  it('retries a model at most once per delivery with persistent backoff and a shared stage cap', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway();
    await slice(repository, gateway).runClaimSlice(repository.work(), sliceDeadline());
    gateway.onCall = async () => { throw new NativeGatewayError('RATE_LIMITED', true); };
    for (const expected of ['yielded', 'yielded', 'failed']) {
      expect(await slice(repository, gateway, { retryDelayMilliseconds: 750 }).runClaimSlice(repository.work(), sliceDeadline())).toMatchObject({ status: expected });
    }
    expect(gateway.calls).toHaveLength(3); expect(repository.yields.slice(1).map(item => item.delayMilliseconds)).toEqual([750, 1500]);
    expect(repository.checkpoint.attempts).toMatchObject({ plan: 3 });
    await slice(repository, gateway).runClaimSlice(repository.work(), sliceDeadline());
    expect(gateway.calls).toHaveLength(3);
  });
  it('retains operator-resume behavior and saved specialist results across slices', async () => {
    const repository = new SliceRepository(); const failed = new TestGateway();
    failed.onCall = async request => { if (request.schemaName === 'pactwoven_planning') throw new NativeGatewayError('NETWORK', true); };
    await create(repository, failed).runOnce();
    repository.task.events.push({ sequence: 10, kind: 'resumed', title: 'Retry requested', detail: '', agent: null, createdAt: timestamp });
    const gateway = new TestGateway();
    expect(await slice(repository, gateway).runClaimSlice(repository.work(), sliceDeadline())).toMatchObject({ status: 'yielded' });
    expect(gateway.calls.map(call => call.schemaName)).toEqual(['pactwoven_planning']);
    expect(repository.checkpoint.resumedThrough).toBe(10); expect(repository.checkpoint.attempts).toMatchObject({ planning: 1 });
    expect(repository.task.artifacts.filter(item => item.kind === 'research')).toHaveLength(1);
    expect(repository.checkpoint.usage).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 });
  });
  it('keeps a verified artifact with its checkpoint when host cancellation arrives before the stage save', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway();
    await slice(repository, gateway).runClaimSlice(repository.work(), sliceDeadline());
    await slice(repository, gateway).runClaimSlice(repository.work(), sliceDeadline());
    const controller = new AbortController();
    expect(await slice(repository, gateway, { onUsage: () => controller.abort() }).runClaimSlice(repository.work(), { ...sliceDeadline(), signal: controller.signal })).toMatchObject({ status: 'yielded' });
    expect(repository.checkpoint.research).toEqual(research);
    expect(repository.yields.at(-1)?.progress.artifact?.kind).toBe('research');
    expect(repository.task.artifacts.filter(item => item.kind === 'research')).toHaveLength(1);
  });
  it('returns interrupted on an unknown yield commit without replacing it with failed or legacy release', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway(); const release = vi.spyOn(repository, 'release');
    repository.onYield = () => { throw new Error('private commit response lost'); };
    expect(await slice(repository, gateway).runClaimSlice(repository.work(), sliceDeadline())).toMatchObject({ status: 'interrupted' });
    expect(repository.checkpoint.documentsLoaded).toBe(true); expect(repository.generation).toBe(2);
    expect(repository.task.status).toBe('queued'); expect(release).not.toHaveBeenCalled();
    expect(repository.updates.some(update => update.status === 'failed')).toBe(false);
    repository.onYield = undefined;
    await slice(repository, gateway).runClaimSlice(repository.work(), sliceDeadline());
    expect(gateway.calls.map(call => call.schemaName)).toEqual(['pactwoven_plan']);
  });
  it('does not invent a continuation when atomic yield is unavailable or fenced out', async () => {
    for (const failure of ['throw', 'fenced']) {
      const repository = new SliceRepository(); const gateway = new TestGateway(); const release = vi.spyOn(repository, 'release');
      const yieldClaim = vi.fn(async () => { if (failure === 'throw') throw new Error('private database failure'); return false; });
      expect(await slice(repository, gateway, { dispatchRepository: { yieldClaim } }).runClaimSlice(repository.work(), sliceDeadline())).toMatchObject({ status: 'interrupted' });
      expect(repository.generation).toBe(1); expect(repository.checkpoint.documentsLoaded).toBe(false);
      expect(release).not.toHaveBeenCalled(); expect(repository.updates.some(update => update.status === 'failed')).toBe(false);
    }
  });
  it('stops on revoked lease without yielding a stale artifact', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway();
    await slice(repository, gateway).runClaimSlice(repository.work(), sliceDeadline());
    gateway.onCall = request => { repository.held = false; return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new NativeGatewayError('CANCELLED')), { once: true })); };
    expect(await slice(repository, gateway, { heartbeatMilliseconds: 5 }).runClaimSlice(repository.work(), sliceDeadline())).toMatchObject({ status: 'interrupted' });
    expect(repository.yields).toHaveLength(1); expect(repository.task.artifacts).toHaveLength(0);
  });
  it('returns the committed yield even when cancellation arrives with its acknowledgement', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway(); const controller = new AbortController();
    repository.onYield = () => controller.abort();
    expect(await slice(repository, gateway).runClaimSlice(repository.work(), { ...sliceDeadline(), signal: controller.signal })).toMatchObject({ status: 'yielded' });
    expect(repository.yields).toHaveLength(1);
  });
  it('validates targeted scope before any repository or model call', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway(); const work = repository.work();
    work.dispatch.organizationId = 'other-org';
    const renew = vi.spyOn(repository, 'renew'); const yieldClaim = vi.spyOn(repository, 'yieldClaim');
    await expect(slice(repository, gateway).runClaimSlice(work, sliceDeadline())).rejects.toThrow('Invalid targeted task claim');
    expect(renew).not.toHaveBeenCalled(); expect(yieldClaim).not.toHaveBeenCalled(); expect(gateway.calls).toHaveLength(0);
  });
  it('honors cancellation during lease renewal without consuming an external attempt', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway(); const controller = new AbortController();
    vi.spyOn(repository, 'renew').mockImplementation(async () => { controller.abort(); return true; });
    expect(await slice(repository, gateway).runClaimSlice(repository.work(), { ...sliceDeadline(), signal: controller.signal })).toMatchObject({ status: 'yielded' });
    expect(repository.checkpoint.attempts).toMatchObject({ evidence: 0, plan: 0 });
    expect(gateway.calls).toHaveLength(0);
  });
  it('does not turn a stopped claim into a running slice', async () => {
    const repository = new SliceRepository(); const gateway = new TestGateway(); const work = repository.work();
    work.claim.task.status = 'cancelled';
    await expect(slice(repository, gateway).runClaimSlice(work, sliceDeadline())).rejects.toThrow('Invalid targeted task claim');
    expect(gateway.calls).toHaveLength(0); expect(repository.yields).toHaveLength(0);
  });
});
