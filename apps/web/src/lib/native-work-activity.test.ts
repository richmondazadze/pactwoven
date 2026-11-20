import { describe, expect, it } from 'vitest';
import { activityMatchesWork, nativeWorkActivitySchema } from './native-work-activity';
import { demoActivityFixture } from './demo-workspace.test-fixtures';
import { agentWorkFixture } from './native-agent-work.test-fixtures';

describe('same-work activity admission',()=>{
  const scope={apiBase:'https://native.example.test',environment:'development' as const,organizationId:'org_one',actorId:'actor_one',sessionId:'session_one',siteId:'site_one'};
  it('rejects another root, organization, site or environment',()=>{
    const activity=demoActivityFixture(),value={scope:{environment:scope.environment,organizationId:scope.organizationId,siteId:scope.siteId},activity};
    const schema=nativeWorkActivitySchema(scope,activity.rootTaskId);
    expect(schema.safeParse(value).success).toBe(true);
    for(const changed of [{environment:'production'},{organizationId:'org_other'},{siteId:'site_other'}]) expect(schema.safeParse({...value,scope:{...value.scope,...changed}}).success).toBe(false);
    expect(schema.safeParse({...value,activity:{...activity,rootTaskId:'root_other'}}).success).toBe(false);
  });
  it('requires matching control and recorded root versions before attaching activity to a result',()=>{
    const activity=demoActivityFixture(),work={...agentWorkFixture(),id:activity.rootTaskId,controlVersion:activity.revision.controlVersion,updatedAt:activity.recordedAt};
    expect(activityMatchesWork(activity,work)).toBe(true);
    expect(activityMatchesWork(activity,{...work,controlVersion:2})).toBe(false);
    expect(activityMatchesWork(activity,{...work,updatedAt:'2026-11-19T17:00:01.000Z'})).toBe(false);
    expect(activityMatchesWork(activity,{...work,id:'other_root'})).toBe(false);
  });
});
