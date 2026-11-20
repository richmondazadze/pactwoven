import { z } from 'zod';
import { IdSchema, InstantSchema } from './core';
import { NativeWorkIntentScopeSchema } from './native-work-intent';

export const NativeWorkTeamActivitySchema = z.strictObject({
  rootTaskId: IdSchema, recordedAt: InstantSchema, asOf: InstantSchema,
  controlVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  instructionRevision: z.number().int().min(0).max(16),
  status: z.enum(['verified', 'unavailable']), validUntil: InstantSchema.nullable(),
  agents: z.array(z.strictObject({ id: IdSchema, role: z.enum(['research', 'planning', 'escalation']),
    label: z.enum(['Research', 'Planning', 'Review']), state: z.enum(['queued', 'working']) })).max(32),
  authority: z.literal('none'),
}).superRefine((value, context) => {
  const labels = { research: 'Research', planning: 'Planning', escalation: 'Review' } as const;
  const valid = value.validUntil === null ? NaN : Date.parse(value.validUntil);
  if (value.agents.some(agent => agent.label !== labels[agent.role]) || Date.parse(value.recordedAt) > Date.parse(value.asOf) || new Set(value.agents.map(agent => agent.id)).size !== value.agents.length ||
    value.status === 'unavailable' && (value.agents.length > 0 || value.validUntil !== null) ||
    value.status === 'verified' && (!Number.isFinite(valid) || valid <= Date.parse(value.asOf) || valid - Date.parse(value.asOf) > 10_000)) {
    context.addIssue({ code: 'custom', message: 'Team activity needs a unique, bounded current observation.' });
  }
});
export const NativeWorkTeamActivityResponseSchema = z.strictObject({ scope: NativeWorkIntentScopeSchema, teamActivity: NativeWorkTeamActivitySchema });
export type NativeWorkTeamActivity = z.infer<typeof NativeWorkTeamActivitySchema>;
export const isNativeWorkTeamActivityHttpRoute = (path: string, method: string): boolean =>
  /^\/v1\/agent-work\/[A-Za-z0-9_-]{1,128}\/team-activity$/.test(path) && ['GET', 'OPTIONS'].includes(method);
