import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentWorkflowChain } from './agent-workflow-chain';
import { AgentActivityWorkspace } from './demo-workspace';
import { NativeWorkActivitySchema } from '../../../../packages/contracts/src/native-work-activity';
import { teamActivityFixture } from '../lib/native-work-team-activity.test-fixtures';
vi.mock('./native-agent-work-hooks', () => ({ canObserveAgentWork: () => true }));
function fixture() {
  const { work, activity: teamActivity, at } = teamActivityFixture();
  const activity = NativeWorkActivitySchema.parse({ rootTaskId: work.id, asOf: work.updatedAt, recordedAt: work.updatedAt, freshUntil: new Date(at + 10000).toISOString(), expiresAt: work.expiresAt,
    revision: { controlVersion: work.controlVersion, checkpointVersion: 1, generation: 1, instructionRevision: 0 }, freshness: 'current', observation: 'snapshot',
    agents: [{ id: 'private-coordinator', role: 'coordinator', label: 'Coordinator' }], actions: [{ id: 'private-action', actorId: 'private-coordinator', kind: 'wait', target: 'team', state: 'waiting', label: 'Waiting for specialist results', recordedAt: work.updatedAt }], externalEffects: 'forbidden' });
  return { work, activity, teamActivity, observing: true };
}
describe('interactive agent workflow', () => {
  it('shows selectable recorded stages and real agents without raw IDs or mutation controls', () => {
    const html = renderToStaticMarkup(createElement(AgentWorkflowChain, fixture()));
    for (const text of ['Agent workflow stages', 'Make a plan', 'Work together', 'Bring it together', 'Research', 'Planning', 'Working', 'aria-pressed=', 'Selected workflow details', 'aria-controls=']) expect(html).toContain(text);
    for (const text of ['opaque-agent', 'opaque-planner', 'private-coordinator', 'private-action', 'Approve', 'Cancel work', 'iframe', 'Payment confirmed', 'aria-valuenow']) expect(html).not.toContain(text);
  });
  it('queued and waiting branches remain distinguishable and no hidden synthetic sources are added', () => {
    const html = renderToStaticMarkup(createElement(AgentWorkflowChain, fixture()));
    expect(html).toContain('Ready to start'); expect(html).toContain('Waiting for specialist results'); expect(html).not.toContain('Sources</'); expect(html).not.toContain('Not recorded yet');
  });
  it('observation pause is explicit and suppresses current working markers', () => {
    const html = renderToStaticMarkup(createElement(AgentWorkflowChain, { ...fixture(), observing: false }));
    expect(html).toContain('Connection paused'); expect(html).toContain('data-live="false"'); expect(html).not.toContain('agent-chain-pointer');
  });
  it('the surrounding workspace can retain result and full history without a duplicate graph', () => {
    const f = fixture(); const result = { title: 'Saved plan', summary: 'Full summary', artifacts: [{ id: 'saved-artifact', title: 'Agenda', text: 'Full agenda text' }], advisoryOnly: true as const, evidenceValidUntil: null };
    const html = renderToStaticMarkup(createElement(AgentActivityWorkspace, { activity: f.activity, detailsOnly: true, result }));
    expect(html).toContain('Full agenda text'); expect(html).toContain('Activity details'); expect(html).not.toContain('demo-workspace-board'); expect(html).not.toContain('Agents assigned to this work');
  });
});
