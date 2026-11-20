import { z } from 'zod';
import { IdSchema, InstantSchema } from './core';
import { NativeWorkIntentScopeSchema } from './native-work-intent';
const Counter=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Current authorized metadata about already accepted contributions. This is
 * deliberately separate from active execution and historical checkpoints. */
export const NativePaidContributorsSchema=z.strictObject({
 scope:NativeWorkIntentScopeSchema,rootTaskId:IdSchema,instructionRevision:Counter.max(16),
 rootGeneration:Counter.min(1),controlVersion:Counter.min(1),checkpointVersion:Counter,
 observedAt:InstantSchema,availableUntil:InstantSchema.nullable(),
 state:z.enum(['recorded','unavailable','not_applicable']),quoteId:IdSchema.nullable(),active:z.literal(false),
 contributors:z.array(z.strictObject({id:z.string().regex(/^[a-f0-9]{32}$/),role:z.enum(['research','planning','escalation']),
  status:z.literal('recorded'),completedAt:InstantSchema})).max(32),
}).superRefine((value,ctx)=>{
 const recorded=value.state==='recorded',observed=Date.parse(value.observedAt),until=value.availableUntil===null?null:Date.parse(value.availableUntil);
 if(recorded?value.quoteId===null||value.contributors.length===0||until===null||until<=observed||until-observed>10000:
  value.quoteId!==null||value.contributors.length!==0||until!==null)ctx.addIssue({code:'custom',message:'Recorded contributors require a current bounded attachment.'});
 if(new Set(value.contributors.map(x=>x.id)).size!==value.contributors.length||value.contributors.some(x=>Date.parse(x.completedAt)>observed))ctx.addIssue({code:'custom',message:'Contributor facts must be unique and already recorded.'});
});
export type NativePaidContributors=z.infer<typeof NativePaidContributorsSchema>;
