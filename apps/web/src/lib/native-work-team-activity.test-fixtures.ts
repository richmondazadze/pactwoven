import { NativeWorkTeamActivitySchema } from '../../../../packages/contracts/src/native-work-team-activity';
import { agentWorkFixture } from './native-agent-work.test-fixtures';
export function teamActivityFixture() {
 const work={...agentWorkFixture(),state:'waiting' as const};
 const at=Date.parse(work.updatedAt);
 const activity=NativeWorkTeamActivitySchema.parse({rootTaskId:work.id,recordedAt:work.updatedAt,asOf:work.updatedAt,controlVersion:work.controlVersion,instructionRevision:0,status:'verified',validUntil:new Date(at+7000).toISOString(),agents:[{id:'opaque-agent',role:'research',label:'Research',state:'working'},{id:'opaque-planner',role:'planning',label:'Planning',state:'queued'}],authority:'none'});
 return {work,activity,at};
}
