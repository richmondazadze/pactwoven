import { describe, expect, it } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import { NativeWorkTeamActivityResponseSchema } from '../../../packages/contracts/src/native-work-team-activity';
import { projectNativeWorkTeamActivity } from './native-work-team-activity';
const at = '2026-11-19T12:00:00Z';
function fixture() {
  const session: Session = { actor: { actorId: 'operator', principalKind: 'human', organizationId: 'org', environment: 'development',
    roles: ['owner'], siteIds: ['office'], actionSiteIds: ['office'], sessionId: 'session', authenticatedAt: at, correlationId: 'test' },
    organization: { id: 'org', name: 'Company', authorityEpoch: 1 }, sites: [{ id: 'office', name: 'Office', timeZone: 'America/Chicago' }] };
  const scope = { environment: 'development', organizationId: 'org', siteId: 'office' };
  const root = { scope, id: 'root', title: 'Private title', prompt: 'Private prompt', controlVersion: 2,
    state: 'waiting_children', reason: 'none', checkpointVersion: 3,
    checkpoint: { stage: 'working', summary: 'I clicked Pay and transferred money', steps: [{ id: 'step', title: 'Payment confirmed', state: 'active' }] },
    checkpointHistorical: true, attempt: 1, attemptLimit: 4, generation: 4, coverage: [], result: null,
    updatedAt: at, expiresAt: '2026-11-20T12:00:00Z', evidenceUnavailable: false, domainCompletion: false };
  const children = [{ taskId: 'research_task', handoffId: 'handoff_research', assignmentVersion: 1, generation: 1,
    role: 'research', state: 'running', leaseUntil: '2026-11-19T12:00:07Z' as string | null, current: true }];
  const frame = { root, instructionRevision: 1, observedAt: at, currentExecution: { kind: 'verified', validUntil: '2026-11-19T12:00:07Z', children } };
  const project = (now = at) => projectNativeWorkTeamActivity(session, 'root', 'office', frame, now);
  return { session, frame, root, children, project };
}
describe('separate current execution projection', () => {
  it('shows leased working specialists while preserving the old historical checkpoint', () => {
    const f=fixture(), value=f.project();
    expect(value.teamActivity).toMatchObject({status:'verified',validUntil:'2026-11-19T12:00:07Z',agents:[{label:'Research',state:'working'}],authority:'none'});
    expect(f.root.checkpointHistorical).toBe(true);
    for(const text of ['Private title','Private prompt','clicked Pay','Payment confirmed','research_task','handoff_research'])expect(JSON.stringify(value)).not.toContain(text);
  });
  it('does not extend observation beyond the shortest lease',()=>{const f=fixture();expect(f.project('2026-11-19T12:00:06Z').teamActivity.validUntil).toBe(f.frame.currentExecution.validUntil);expect(f.project('2026-11-19T12:00:07Z').teamActivity).toMatchObject({status:'unavailable',agents:[],validUntil:null});});
  it('displays ready assignments as waiting without a working pointer claim',()=>{const f=fixture();f.children[0]!.state='ready';f.children[0]!.leaseUntil=null;expect(f.project().teamActivity.agents[0]!.state).toBe('queued');});
  it.each(['paused','cancelled','completed','blocked','running','waiting_external'])('withholds running claims on %s root',state=>{const f=fixture();f.root.state=state;let value;try{value=f.project();}catch{return;}expect(value.teamActivity.agents).toEqual([]);});
  it.each(['scope','future','old','unleased','shortlease','duplicate','stale'])('rejects %s metadata',kind=>{const f=fixture();if(kind==='scope')f.root.scope.organizationId='other';if(kind==='future')f.frame.observedAt='2026-11-19T12:00:01Z';if(kind==='old')f.frame.observedAt='2026-11-19T11:59:59Z';if(kind==='unleased')f.children[0]!.leaseUntil=null;if(kind==='shortlease')f.children[0]!.leaseUntil='2026-11-19T12:00:03Z';if(kind==='duplicate')f.children.push({...f.children[0]!});if(kind==='stale')f.children[0]!.current=false;expect(()=>f.project()).toThrow();});
  it('rejects overlong observation windows and private public fields',()=>{const f=fixture();f.frame.currentExecution.validUntil='2026-11-19T12:00:20Z';expect(()=>f.project()).toThrow();const v=fixture().project();expect(NativeWorkTeamActivityResponseSchema.safeParse({...v,teamActivity:{...v.teamActivity,checkpoint:{text:'private'}}}).success).toBe(false);});
  it('does not disclose unavailable raw evidence',()=>{const f=fixture();f.root.evidenceUnavailable=true;f.root.checkpoint=null as never;let value;try{value=f.project();}catch{return;}expect(value.teamActivity.agents).toEqual([]);});
});
