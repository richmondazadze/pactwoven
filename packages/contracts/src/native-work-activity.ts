import { z } from 'zod';
import { IdSchema, InstantSchema } from './core';
import { NativeWorkIntentScopeSchema } from './native-work-intent';

const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const NativeWorkActivityRoleSchema = z.enum(['coordinator', 'research', 'planning', 'escalation']);
export const NativeWorkActivityStateSchema = z.enum(['queued', 'active', 'waiting', 'paused', 'cancelled', 'completed', 'needs_review']);
export const NativeWorkActivitySchema = z.strictObject({
  rootTaskId: IdSchema,
  asOf: InstantSchema,
  recordedAt: InstantSchema,
  freshUntil: InstantSchema,
  expiresAt: InstantSchema,
  revision: z.strictObject({ controlVersion: Version, checkpointVersion: Counter, generation: Version,
    instructionRevision: Counter.nullable() }),
  freshness: z.enum(['current', 'historical', 'unavailable']),
  observation: z.literal('snapshot'),
  agents: z.array(z.strictObject({ id: IdSchema, role: NativeWorkActivityRoleSchema,
    label: z.string().min(1).max(80) })).max(33),
  actions: z.array(z.strictObject({ id: IdSchema, actorId: IdSchema,
    kind: z.enum(['plan', 'coordinate', 'review', 'result', 'wait']),
    target: z.enum(['plan', 'team', 'result']), state: NativeWorkActivityStateSchema,
    label: z.string().min(1).max(120), recordedAt: InstantSchema.nullable() })).max(33),
  externalEffects: z.literal('forbidden'),
}).superRefine((value, context) => {
  const actors = new Set(value.agents.map(agent => agent.id));
  if (actors.size !== value.agents.length || new Set(value.actions.map(action => action.id)).size !== value.actions.length ||
      value.actions.some(action => !actors.has(action.actorId) || action.recordedAt !== null && Date.parse(action.recordedAt) > Date.parse(value.asOf))) {
    context.addIssue({ code: 'custom', message: 'Activity must reference unique recorded actors and actions.' });
  }
  if (Date.parse(value.recordedAt) > Date.parse(value.asOf) || Date.parse(value.freshUntil) < Date.parse(value.asOf) ||
      Date.parse(value.freshUntil) - Date.parse(value.asOf) > 10_000) {
    context.addIssue({ code: 'custom', message: 'Activity observation time must be bounded.' });
  }
  if (value.freshness !== 'current' && value.actions.some(action => action.state === 'active')) {
    context.addIssue({ code: 'custom', message: 'Historical activity cannot be presented as active.' });
  }
  if (value.freshness === 'unavailable' && (value.agents.length || value.actions.length)) {
    context.addIssue({ code: 'custom', message: 'Unavailable evidence must not disclose activity.' });
  }
});
export const NativeWorkActivityResponseSchema = z.strictObject({ scope: NativeWorkIntentScopeSchema, activity: NativeWorkActivitySchema });
export type NativeWorkActivity = z.infer<typeof NativeWorkActivitySchema>;
export type NativeWorkActivityAction = NativeWorkActivity['actions'][number];
export type NativeWorkActivityResponse = z.infer<typeof NativeWorkActivityResponseSchema>;
export const isNativeWorkActivityHttpRoute = (path: string, method: string): boolean =>
  /^\/v1\/agent-work\/[A-Za-z0-9_-]{1,128}\/activity$/.test(path) && ['GET', 'OPTIONS'].includes(method);
