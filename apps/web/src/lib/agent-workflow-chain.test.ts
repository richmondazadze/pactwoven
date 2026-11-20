import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NativeWorkActivitySchema } from '../../../../packages/contracts/src/native-work-activity';
import { teamActivityFixture } from './native-work-team-activity.test-fixtures';
import { buildAgentWorkflowChain, selectChainObservation } from './agent-workflow-chain';

export function chainFixture() {
  const { work, activity: teamActivity, at } = teamActivityFixture();
  const activity = NativeWorkActivitySchema.parse({ rootTaskId: work.id, asOf: work.updatedAt, recordedAt: work.updatedAt,
    freshUntil: new Date(at + 10000).toISOString(), expiresAt: work.expiresAt,
    revision: { controlVersion: work.controlVersion, checkpointVersion: 1, generation: 1, instructionRevision: 0 }, freshness: 'current', observation: 'snapshot',
    agents: [{ id: 'recorded-coordinator', role: 'coordinator', label: 'Coordinator' }, { id: 'recorded-research', role: 'research', label: 'Research' }, { id: 'recorded-planner', role: 'planning', label: 'Planning' }],
    actions: [{ id: 'coord-wait', actorId: 'recorded-coordinator', kind: 'wait', target: 'team', state: 'waiting', label: 'Waiting for specialist results', recordedAt: work.updatedAt },
      { id: 'research-done', actorId: 'recorded-research', kind: 'coordinate', target: 'team', state: 'completed', label: 'Contribution recorded', recordedAt: null },
      { id: 'planner-active', actorId: 'recorded-planner', kind: 'coordinate', target: 'team', state: 'active', label: 'Working on an assigned contribution', recordedAt: null }], externalEffects: 'forbidden' });
  return { work, activity, teamActivity, now: at + 1, observing: true };
}

describe('recorded workflow and live agent identity', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-11-20T05:00:00Z'); });
  afterEach(() => vi.useRealTimers());
  it('shows concurrent lease cards beside completed contributions without joining different IDs by name', () => {
    const view = buildAgentWorkflowChain(chainFixture());
    expect(view.nodes.map(node => [node.label, node.state])).toEqual([['Coordinator', 'waiting'], ['Research contribution', 'completed'], ['Research', 'working'], ['Planning', 'queued']]);
    expect(view.completedContributions).toBe(1); expect(view.workingCount).toBe(1);
    expect(view.nodes.some(node => node.key === 'recorded:recorded-planner')).toBe(false);
    expect(view.stages.find(stage => stage.id === 'team')?.state).toBe('working');
  });
  it('represents every verified concurrent worker and counts no queued worker as active', () => {
    const f = chainFixture(); f.teamActivity.agents[1]!.state = 'working';
    const view = buildAgentWorkflowChain(f); expect(view.workingCount).toBe(2); expect(view.status).toBe('2 agents are working');
  });
  it('does not manufacture a team, earlier completion or a handoff from an empty snapshot', () => {
    const f = chainFixture(); const view = buildAgentWorkflowChain({ work: { ...f.work, state: 'queued' }, observing: true, now: f.now });
    expect(view.nodes).toEqual([]); expect(view.coordinatorStage).toBeNull();
    expect(view.stages.every(stage => stage.state === 'not_started' && !stage.recorded)).toBe(true);
  });
  it('recorded active specialist data alone is not proof of a currently leased worker', () => {
    const f = chainFixture(); const view = buildAgentWorkflowChain({ ...f, teamActivity: undefined });
    expect(view.workingCount).toBe(0); expect(view.nodes.find(node => node.role === 'planning')?.state).toBe('unknown');
  });
  it.each(['paused', 'cancelled', 'completed', 'needs_review'] as const)('never shows executing specialists after root %s', state => {
    const f = chainFixture(), view = buildAgentWorkflowChain({ ...f, work: { ...f.work, state } });
    expect(view.live).toBe(false); expect(view.nodes.some(node => node.live)).toBe(false);
    expect(view.nodes.find(node => node.role === 'research')?.state).toBe('completed');
  });
  it.each(['offline', 'lease-expiry', 'root-expiry', 'unavailable'] as const)('suppresses live activity at %s', reason => {
    const f = chainFixture();
    if (reason === 'offline') f.observing = false;
    if (reason === 'lease-expiry') f.now = Date.parse(f.teamActivity.validUntil!);
    if (reason === 'root-expiry') f.now = Date.parse(f.work.expiresAt);
    if (reason === 'unavailable') f.work.evidenceUnavailable = true;
    const view = buildAgentWorkflowChain(f); expect(view.workingCount).toBe(0);
    if (reason === 'unavailable') expect(view.nodes).toEqual([]);
  });
  it('does not combine metadata and content across instruction revisions', () => {
    const f = chainFixture(); f.teamActivity.instructionRevision = 1;
    const view = buildAgentWorkflowChain(f); expect(view.workingCount).toBe(0); expect(view.nodes.some(node => node.key.startsWith('current:'))).toBe(false);
  });
  it('rejects another root or control revision without disclosing its activity', () => {
    const f = chainFixture();
    expect(buildAgentWorkflowChain({ ...f, activity: { ...f.activity, rootTaskId: 'another' }, teamActivity: undefined }).nodes).toEqual([]);
    expect(buildAgentWorkflowChain({ ...f, work: { ...f.work, controlVersion: 4 } }).nodes).toEqual([]);
  });
  it('retains completed contributions as saved facts after observation becomes stale', () => {
    const f = chainFixture(), view = buildAgentWorkflowChain({ ...f, now: Date.parse(f.activity.freshUntil) });
    expect(view.observationCurrent).toBe(false); expect(view.workingCount).toBe(0); expect(view.completedContributions).toBe(1);
  });
  it('uses the actual coordinator target rather than ordering stages by action timestamps', () => {
    const f = chainFixture(); f.activity.actions[0]!.target = 'result'; f.activity.actions[0]!.kind = 'review';
    expect(buildAgentWorkflowChain(f).coordinatorStage).toBe('result');
    expect(buildAgentWorkflowChain(f).stages[0]!.state).toBe('not_started');
  });
  it('keeps contribution needs-review distinct from cancellation and never invents failure or success', () => {
    const f = chainFixture(); f.activity.actions[1]!.state = 'needs_review';
    const view = buildAgentWorkflowChain({ ...f, teamActivity: undefined });
    expect(view.nodes.find(node => node.role === 'research')?.state).toBe('needs_review'); expect(view.completedContributions).toBe(0);
  });
  it.each(['quote_ready', 'quote_expired', 'equipment_unavailable', 'approval_unconfirmed', 'purchase_recorded'] as const)('keeps %s a payment boundary without claiming payment success', equipmentStage => {
    const view = buildAgentWorkflowChain({ ...chainFixture(), equipmentStage });
    expect(view.payment).not.toBeNull(); expect(view.payment?.state).not.toBe('completed');
    expect(JSON.stringify(view.payment)).not.toMatch(/confirmed|delivered|successful/i);
  });
  it('hides result content at its exact evidence expiry', () => {
    const f = chainFixture(); f.work.result = { title: 'Result', summary: 'Advice', artifacts: [], advisoryOnly: true, evidenceValidUntil: new Date(f.now).toISOString() };
    expect(buildAgentWorkflowChain(f).canShowResult).toBe(false);
  });
});

describe('late observation handling', () => {
  it('accepts fresh same-revision states and does not replay identical observations', () => {
    const f = chainFixture(); expect(selectChainObservation(f.activity, f.activity, f.work)).toBe(f.activity);
    const next = { ...f.activity, asOf: new Date(Date.parse(f.activity.asOf) + 1).toISOString() };
    expect(selectChainObservation(f.activity, next, f.work)).toBe(next);
  });
  it('rejects backwards generation, checkpoint, time and instruction observations', () => {
    const f = chainFixture(), previous = { ...f.activity, asOf: new Date(Date.parse(f.activity.asOf) + 1000).toISOString(), revision: { ...f.activity.revision, generation: 2, checkpointVersion: 2, instructionRevision: 1 } };
    expect(selectChainObservation(previous, f.activity, f.work)).toBe(previous);
    for (const key of ['generation', 'checkpointVersion', 'instructionRevision'] as const) {
      const candidate = { ...previous, revision: { ...previous.revision, [key]: 0 } };
      expect(selectChainObservation(previous, candidate, f.work)).toBe(previous);
    }
  });
  it('never retains previous evidence after withdrawal, root/control changes or read failure', () => {
    const f = chainFixture();
    expect(selectChainObservation(f.activity, undefined, f.work)).toBeUndefined();
    expect(selectChainObservation(f.activity, { ...f.activity, freshness: 'unavailable', agents: [], actions: [] }, f.work)).toBeUndefined();
    expect(selectChainObservation(f.activity, f.activity, { ...f.work, controlVersion: 44 })).toBeUndefined();
    expect(selectChainObservation(f.activity, f.activity, { ...f.work, evidenceUnavailable: true })).toBeUndefined();
  });
});
