import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ActorContext } from '../../contracts/src/core';
import { NativeWorkExecutionFrameSchema, PostgresNativeWorkExecutionRepository } from './native-work-execution-repository';

const actor: ActorContext = { environment: 'simulation', actorId: 'human', organizationId: 'org', principalKind: 'human',
  roles: ['owner'], siteIds: ['site'], actionSiteIds: ['site'], sessionId: 'session',
  authenticatedAt: '2026-11-19T00:00:00Z', correlationId: 'correlation' };
function sample() { return {
  root: { scope: { environment: 'simulation', organizationId: 'org', siteId: 'site' }, id: 'root', title: 'Compare packages', prompt: 'Compare permitted packages.',
    controlVersion: 2, updatedAt: '2026-11-19T00:00:00Z', expiresAt: '2026-11-20T00:00:00Z', evidenceUnavailable: false,
    state: 'waiting_children', reason: 'none', checkpointVersion: 1, checkpoint: { stage: 'working', summary: 'Comparing packages', steps: [] },
    checkpointHistorical: true, attempt: 1, attemptLimit: 4, generation: 2, coverage: [], result: null, domainCompletion: false },
  instructionRevision: 1, observedAt: '2026-11-19T00:00:02Z',
  currentExecution: { kind: 'verified', validUntil: '2026-11-19T00:00:10Z', children: [{ taskId: 'child', handoffId: 'handoff', assignmentVersion: 1, generation: 1, role: 'research', state: 'running', leaseUntil: '2026-11-19T00:00:12Z', current: true }] },
}; }
function setup(response: unknown) {
  const query = vi.fn().mockResolvedValue({ rows: [{ response }] });
  return { query, repository: new PostgresNativeWorkExecutionRepository({ query } as unknown as Pool, 'simulation') };
}
describe('human current execution read boundary', () => {
  it('uses one scoped call and preserves actual child generation across root resume', async () => {
    const frame = sample(), { query, repository } = setup(frame);
    expect(await repository.read(actor, 'root', 'site')).toEqual(frame);
    expect(query).toHaveBeenCalledExactlyOnceWith('SELECT pactwoven.native_work_execution_read($1::jsonb,$2,$3) AS response', [actor, 'root', 'site']);
  });
  it.each(['environment', 'organizationId', 'siteId', 'id'])('refuses a mismatched returned %s', async field => {
    const frame = sample();
    if (field === 'id') frame.root.id = 'other';
    else (frame.root.scope as Record<string, string>)[field] = field === 'environment' ? 'development' : 'other';
    await expect(setup(frame).repository.read(actor, 'root', 'site')).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
  });
  it.each(['environment', 'site'])('rejects out-of-scope %s before querying', async kind => {
    const { query, repository } = setup(sample());
    await expect(repository.read(kind === 'environment' ? { ...actor, environment: 'development' } : actor, 'root', kind === 'site' ? 'other' : 'site')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
  });
  it.each(['duplicate', 'old_revision', 'wrong_root_state', 'hidden', 'unexpected_metadata', 'false_outcome', 'expired', 'long_window', 'missing_lease', 'short_lease', 'ready_with_lease'])('rejects invalid %s activity', async kind => {
    const frame = sample();
    if (kind === 'duplicate') frame.currentExecution.children.push({ ...frame.currentExecution.children[0]! });
    if (kind === 'old_revision') frame.currentExecution.children[0]!.current = false;
    if (kind === 'wrong_root_state') frame.root.state = 'running';
    if (kind === 'expired') frame.currentExecution.validUntil = frame.observedAt;
    if (kind === 'long_window') frame.currentExecution.validUntil = '2026-11-19T00:01:00Z';
    if (kind === 'missing_lease') Object.assign(frame.currentExecution.children[0]!, { leaseUntil: null });
    if (kind === 'short_lease') frame.currentExecution.children[0]!.leaseUntil = frame.observedAt;
    if (kind === 'ready_with_lease') frame.currentExecution.children[0]!.state = 'ready';
    if (kind === 'hidden') frame.root.evidenceUnavailable = true;
    if (kind === 'unexpected_metadata') Object.assign(frame.currentExecution.children[0]!, { identity: { credential: 'must not be disclosed' } });
    if (kind === 'false_outcome') Object.assign(frame.currentExecution.children[0]!, { outcome: 'advice_ready' });
    await expect(setup(frame).repository.read(actor, 'root', 'site')).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
  });
  it('accepts an unavailable frame only with no exposed evidence or children', () => {
    const frame = sample(); frame.root.evidenceUnavailable = true; Object.assign(frame, { currentExecution: { kind: 'unavailable', validUntil: null, children: [] } });
    expect(NativeWorkExecutionFrameSchema.safeParse(frame).success).toBe(false);
    Object.assign(frame.root, { checkpoint: null });
    expect(NativeWorkExecutionFrameSchema.safeParse(frame).success).toBe(true);
  });
  it('maps database denials without returning provider errors', async () => {
    const { query, repository } = setup(sample()); query.mockRejectedValueOnce({ code: 'ND001', message: 'private detail' });
    await expect(repository.read(actor, 'root', 'site')).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Current work access is required.' });
    query.mockRejectedValueOnce(new Error('private transport detail'));
    await expect(repository.read(actor, 'root', 'site')).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE', message: 'Agent activity could not be refreshed.' });
  });
});
