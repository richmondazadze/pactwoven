import { describe, expect, it } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import { NativeWorkActivityResponseSchema } from '../../../packages/contracts/src/native-work-activity';
import { projectNativeWorkActivity } from './native-work-activity';

const at = '2026-11-19T12:00:00Z';
function fixture() {
  const session: Session = { actor: { actorId: 'operator', principalKind: 'human', organizationId: 'org', environment: 'development',
    roles: ['owner'], siteIds: ['office'], actionSiteIds: ['office'], sessionId: 'session', authenticatedAt: at, correlationId: 'test' },
    organization: { id: 'org', name: 'Company', authorityEpoch: 1 }, sites: [{ id: 'office', name: 'Office', timeZone: 'America/Chicago' }] };
  const scope = { environment: 'development', organizationId: 'org', siteId: 'office' };
  const root = { scope, id: 'root', title: 'Private title', prompt: 'Private prompt', controlVersion: 2,
    state: 'running', reason: 'none', checkpointVersion: 3,
    checkpoint: { stage: 'working', summary: 'I clicked Pay and transferred money', steps: [{ id: 'step', title: 'Payment confirmed', state: 'active' }] },
    checkpointHistorical: false, attempt: 1, attemptLimit: 4, generation: 4, coverage: [], result: null,
    updatedAt: at, expiresAt: '2026-11-20T12:00:00Z', evidenceUnavailable: false, domainCompletion: false };
  const children = [{ taskId: 'research_task', handoffId: 'handoff_research', assignmentVersion: 1, generation: 1,
    role: 'research', state: 'running', outcome: null as string | null, current: true }];
  const frame = { root, instructionRevision: 1, observedAt: at, children };
  const project = (now = at) => projectNativeWorkActivity(session, 'root', 'office', frame, now);
  return { session, frame, root, children, project };
}
describe('truthful native work activity projection', () => {
  it('shows actual root and specialist lifecycle without treating prose as payment or browser facts', () => {
    const f = fixture(), value = f.project(), serialized = JSON.stringify(value);
    expect(value.activity.agents.map(agent => agent.role)).toEqual(['coordinator', 'research']);
    expect(value.activity.actions.map(action => action.state)).toEqual(['active', 'active']);
    expect(value.activity.actions[1]!.recordedAt).toBeNull();
    expect(value.activity).toMatchObject({ observation: 'snapshot', externalEffects: 'forbidden', freshness: 'current',
      revision: { controlVersion: 2, checkpointVersion: 3, generation: 4, instructionRevision: 1 } });
    for (const secret of ['Private title', 'Private prompt', 'clicked Pay', 'Payment confirmed', 'research_task', 'handoff_research']) expect(serialized).not.toContain(secret);
  });
  it('keeps public actor and action identity stable on repeated reads, without inventing an event sequence', () => {
    const f = fixture(), first = f.project();
    f.frame.observedAt = '2026-11-19T12:00:03Z';
    const second = f.project(f.frame.observedAt);
    expect(second.activity.agents).toEqual(first.activity.agents);
    expect(second.activity.actions).toEqual(first.activity.actions);
    expect(second.activity).not.toHaveProperty('sequence');
  });
  it('identifies distinct same-role specialists without changing their identity after completion', () => {
    const f = fixture();f.children.push({ ...f.children[0]!, taskId: 'research_two', handoffId: 'handoff_two' });
    const before = f.project();f.children[0]!.state = 'settled';f.children[0]!.outcome = 'advice_ready';
    const after = f.project();expect(after.activity.agents).toEqual(before.activity.agents);
    expect(new Set(after.activity.agents.map(agent => agent.id)).size).toBe(3);
    expect(after.activity.actions.some(action => action.state === 'completed' && action.label === 'Contribution recorded')).toBe(true);
  });
  it('refuses obsolete instruction-lineage children rather than inferring currentness from generation', () => {
    const f = fixture();f.children[0]!.current = false;
    expect(() => f.project()).toThrow();
  });
  it.each(['paused', 'cancelled', 'completed', 'blocked'])('does not animate retained active children when root is %s', state => {
    const f = fixture();f.root.state = state;
    expect(f.project().activity.actions.every(action => action.state !== 'active')).toBe(true);
  });
  it('refuses unreleased external-wait states in the P3 schema', () => {
    const f = fixture(); f.root.state = 'waiting_external'; expect(() => f.project()).toThrow();
  });
  it('holds historical checkpoints and expired task authority passive', () => {
    const f = fixture();f.root.checkpointHistorical = true;f.children.splice(0);
    expect(f.project().activity).toMatchObject({ freshness: 'historical' });
    expect(f.project().activity.actions.every(action => action.state !== 'active')).toBe(true);
    f.root.checkpointHistorical = false;f.root.expiresAt = at;
    expect(f.project().activity.freshness).toBe('historical');
  });
  it('withholds unavailable evidence and rejects contradictory raw disclosure', () => {
    const f = fixture();f.root.evidenceUnavailable = true;
    expect(() => f.project()).toThrow();
    Object.assign(f.root, { checkpoint: null });f.children.splice(0);
    expect(f.project().activity).toMatchObject({ freshness: 'unavailable', agents: [], actions: [] });
  });
  it('does not renew a delayed observation lifetime', () => {
    const f = fixture(), value = f.project('2026-11-19T12:00:09Z');
    expect(value.activity.asOf).toBe(at);
    expect(value.activity.freshUntil).toBe('2026-11-19T12:00:10.000Z');
    expect(() => f.project('2026-11-19T12:00:11Z')).toThrow();
  });
  it('refuses future or pre-update observation dates', () => {
    const f = fixture();f.frame.observedAt = '2026-11-19T12:00:01Z';expect(() => f.project()).toThrow();
    f.frame.observedAt = '2026-11-19T11:59:59Z';expect(() => f.project()).toThrow();
  });
  it('refuses cross-scope root data and unauthorized people before projection', () => {
    for (const [field, value] of [['environment', 'simulation'], ['organizationId', 'other'], ['siteId', 'warehouse']] as const) {
      const f = fixture();f.root.scope[field] = value;expect(() => f.project()).toThrow();
    }
    const f = fixture();f.session.actor.siteIds = [];expect(() => f.project()).toThrow();
  });
  it('refuses duplicate child identities and contradictory recorded outcomes', () => {
    const f = fixture();f.children.push({ ...f.children[0]! });expect(() => f.project()).toThrow();
    f.children.pop();f.children[0]!.outcome = 'advice_ready';expect(() => f.project()).toThrow();
    f.children[0]!.outcome = null;f.children[0]!.state = 'settled';
    expect(f.project().activity.actions[1]!.state).toBe('needs_review');
  });
  it('does not permit payment properties, invented actors or historical active states in the public contract', () => {
    const value = fixture().project();
    expect(NativeWorkActivityResponseSchema.safeParse({ ...value, payment: 'confirmed' }).success).toBe(false);
    expect(NativeWorkActivityResponseSchema.safeParse({ ...value, activity: { ...value.activity, freshness: 'historical' } }).success).toBe(false);
    expect(NativeWorkActivityResponseSchema.safeParse({ ...value, activity: { ...value.activity, agents: [] } }).success).toBe(false);
  });
});
