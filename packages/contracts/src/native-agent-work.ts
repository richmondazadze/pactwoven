import { z } from 'zod';
import { IdSchema, InstantSchema } from './core';
import { NativeWorkIntentScopeSchema } from './native-work-intent';

const text = (maximum: number) => z.string().min(1).max(maximum).regex(/\S/);
export const NativeAgentWorkStateSchema = z.enum(['queued', 'working', 'waiting', 'paused', 'cancelled', 'completed', 'needs_review']);
export const NativeAgentWorkActionSchema = z.enum(['pause', 'resume', 'cancel']);
export const NativeAgentWorkControlSchema = z.strictObject({ action: NativeAgentWorkActionSchema,
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const NativeAgentWorkProgressSchema = z.strictObject({ summary: text(4000), historical: z.boolean(),
  steps: z.array(z.strictObject({ id: IdSchema, title: text(180), state: z.enum(['planned', 'active', 'done', 'blocked']) })).max(32) });
export const NativeAgentWorkResultSchema = z.strictObject({ title: text(180), summary: text(8000),
  artifacts: z.array(z.strictObject({ id: IdSchema, title: text(180), text: text(16000) })).max(16),
  evidenceValidUntil: InstantSchema.nullable(), advisoryOnly: z.literal(true) });
export const NativeAgentWorkSchema = z.strictObject({ id: IdSchema, title: text(180), prompt: text(12000), siteName: text(180),
  state: NativeAgentWorkStateSchema, statusText: text(300), controlVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  updatedAt: InstantSchema, expiresAt: InstantSchema, availableActions: z.array(NativeAgentWorkActionSchema).max(3),
  progress: NativeAgentWorkProgressSchema.nullable(), result: NativeAgentWorkResultSchema.nullable(),
  evidenceUnavailable: z.boolean(), continuesAfterSignOut: z.literal(true), externalEffects: z.literal('forbidden') });
export const NativeAgentWorkResponseSchema = z.strictObject({ scope: NativeWorkIntentScopeSchema, work: NativeAgentWorkSchema });
export const NativeAgentWorkControlReceiptSchema = z.strictObject({ scope: NativeWorkIntentScopeSchema, operationId: z.uuid(),
  rootTaskId: IdSchema, action: NativeAgentWorkActionSchema, controlVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: NativeAgentWorkStateSchema, committedAt: InstantSchema });
export const NativeAgentWorkControlRecoverySchema = z.strictObject({ operation: NativeAgentWorkControlReceiptSchema.nullable() });
export const NativeAgentWorkListQuerySchema = z.strictObject({ siteId: IdSchema,
  limit: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().max(180).refine(value => !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value), 'Use a valid work title.').default(''),
  filter: z.enum(['all', 'active', 'completed']).default('all'),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional() });
export const NativeAgentWorkSummarySchema = z.strictObject({ id: IdSchema, title: text(180), state: NativeAgentWorkStateSchema,
  createdAt: InstantSchema, updatedAt: InstantSchema, expiresAt: InstantSchema });
export const NativeAgentWorkPageSchema = z.strictObject({ scope: NativeWorkIntentScopeSchema,
  items: z.array(NativeAgentWorkSummarySchema).max(50), nextCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).nullable() });
export type NativeAgentWork = z.infer<typeof NativeAgentWorkSchema>;
export type NativeAgentWorkResponse = z.infer<typeof NativeAgentWorkResponseSchema>;
export type NativeAgentWorkControl = z.infer<typeof NativeAgentWorkControlSchema>;
export type NativeAgentWorkControlReceipt = z.infer<typeof NativeAgentWorkControlReceiptSchema>;
export type NativeAgentWorkListQuery = z.infer<typeof NativeAgentWorkListQuerySchema>;
export type NativeAgentWorkPage = z.infer<typeof NativeAgentWorkPageSchema>;
export interface NativeAgentWorkListRepository {
  list(actor: import('./core').ActorContext, query: NativeAgentWorkListQuery): Promise<NativeAgentWorkPage>;
}
