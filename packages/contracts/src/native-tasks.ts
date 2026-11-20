import { z } from 'zod';
import { EnvironmentSchema, IdSchema, InstantSchema, type ActorContext } from './core';

export const NativeAgentRoleSchema = z.enum(['coordinator', 'research', 'planning', 'supplier', 'evidence']);
export const NativeTaskStatusSchema = z.enum(['queued', 'running', 'waiting_for_input', 'waiting_for_reply', 'paused', 'completed', 'failed', 'cancelled']);
export const NativeStepStatusSchema = z.enum(['pending', 'working', 'waiting', 'completed', 'failed']);
export const NativeSourceSchema = z.strictObject({ title: z.string().min(1).max(300), url: z.url().max(2048).refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; }, 'Source must be an HTTPS reference without credentials.') });
export const NativeTaskStepSchema = z.strictObject({
  id: IdSchema, agent: NativeAgentRoleSchema, title: z.string().min(1).max(180),
  status: NativeStepStatusSchema, summary: z.string().max(2000),
});
export const NativeTaskMessageSchema = z.strictObject({
  id: IdSchema, role: z.enum(['user', 'assistant']), text: z.string().min(1).max(30_000), createdAt: InstantSchema,
});
export const NativeTaskArtifactSchema = z.strictObject({
  id: IdSchema, kind: z.enum(['research', 'comparison', 'plan', 'report']), title: z.string().min(1).max(180),
  text: z.string().min(1).max(50_000), sources: z.array(NativeSourceSchema).max(60), createdAt: InstantSchema,
});
export const NativeTaskEventSchema = z.strictObject({
  sequence: z.number().int().positive(), kind: z.enum(['created', 'progress', 'message', 'artifact', 'paused', 'resumed', 'cancelled', 'completed', 'failed']),
  title: z.string().min(1).max(180), detail: z.string().max(2000), agent: NativeAgentRoleSchema.nullable(), createdAt: InstantSchema,
});
export const NativeTaskSummarySchema = z.strictObject({
  id: IdSchema, title: z.string().min(1).max(180), status: NativeTaskStatusSchema,
  phase: z.string().min(1).max(180), siteId: IdSchema, createdAt: InstantSchema, updatedAt: InstantSchema,
  version: z.number().int().positive(), availableActions: z.array(z.enum(['pause', 'resume', 'cancel', 'message'])).max(4),
});
export const NativeTaskSchema = NativeTaskSummarySchema.extend({
  prompt: z.string().min(1).max(12_000), mode: z.literal('advise'),
  steps: z.array(NativeTaskStepSchema).max(32), messages: z.array(NativeTaskMessageSchema).max(100),
  artifacts: z.array(NativeTaskArtifactSchema).max(32), events: z.array(NativeTaskEventSchema).max(500),
});
export const NativeTaskScopeSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema });
export const NativeTaskResponseSchema = z.strictObject({ scope: NativeTaskScopeSchema, task: NativeTaskSchema });
export const NativeTaskSearchFilterSchema = z.enum(['all', 'active', 'completed']);
export const NativeTaskCursorSchema = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);
export const NativeTaskSearchQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(180).refine(value => !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value), 'Use a valid task title.').default(''),
  filter: NativeTaskSearchFilterSchema.default('all'), cursor: NativeTaskCursorSchema.optional(),
});
// Creation order is stable. Each page reflects current access/title/status;
// restart paging when filters change or to discover new/changed matches.
export const NativeTaskSearchResultSchema = z.strictObject({
  items: z.array(NativeTaskSummarySchema).max(100), nextCursor: NativeTaskCursorSchema.nullable(),
});
export const NativeTaskPageSchema = NativeTaskSearchResultSchema.extend({ scope: NativeTaskScopeSchema });
export type NativeTaskSearchFilter = z.infer<typeof NativeTaskSearchFilterSchema>;
export type NativeTaskSearchQuery = z.infer<typeof NativeTaskSearchQuerySchema>;
export type NativeTaskSearchResult = z.infer<typeof NativeTaskSearchResultSchema>;
export const CreateNativeTaskSchema = z.strictObject({ prompt: z.string().trim().min(1, 'Describe what you want to achieve.').max(12_000), siteId: IdSchema, mode: z.literal('advise').default('advise') });
export const NativeTaskControlSchema = z.strictObject({ action: z.enum(['pause', 'resume', 'cancel']), expectedVersion: z.number().int().positive() });
export const NativeTaskReplySchema = z.strictObject({ text: z.string().trim().min(1).max(12_000), expectedVersion: z.number().int().positive() });

export type NativeAgentRole = z.infer<typeof NativeAgentRoleSchema>;
export type NativeTaskStatus = z.infer<typeof NativeTaskStatusSchema>;
export type NativeTask = z.infer<typeof NativeTaskSchema>;
export type NativeTaskSummary = z.infer<typeof NativeTaskSummarySchema>;
export type NativeTaskEvent = z.infer<typeof NativeTaskEventSchema>;
export type NativeTaskArtifact = z.infer<typeof NativeTaskArtifactSchema>;
export type NativeTaskMessage = z.infer<typeof NativeTaskMessageSchema>;
export type NativeTaskStep = z.infer<typeof NativeTaskStepSchema>;
export type NativeSource = z.infer<typeof NativeSourceSchema>;
export type CreateNativeTask = z.infer<typeof CreateNativeTaskSchema>;
export type NativeTaskControl = z.infer<typeof NativeTaskControlSchema>;
export type NativeTaskReply = z.infer<typeof NativeTaskReplySchema>;

// Worker records never form part of the public task projection.
export type NativeTaskClaim = {
  task: NativeTask; environment: z.infer<typeof EnvironmentSchema>; organizationId: string; actorId: string;
  leaseToken: string; checkpoint: Record<string, unknown>;
};
export type NativeTaskProgress = {
  title?: string; phase: string; status?: 'running' | 'waiting_for_input' | 'waiting_for_reply' | 'completed' | 'failed';
  /** Exclusive database publication deadline for retrieved evidence. Only on
   * completed updates; schema-v2 checkpoints bind it to their exact sources. */
  evidenceValidUntil?: z.infer<typeof InstantSchema>;
  event: Omit<NativeTaskEvent, 'sequence' | 'createdAt'>;
  steps?: NativeTaskStep[]; message?: Omit<NativeTaskMessage, 'createdAt'>;
  artifact?: Omit<NativeTaskArtifact, 'createdAt'>; checkpoint: Record<string, unknown>;
};
export interface NativeTaskRepository {
  create(actor: ActorContext, key: string, input: CreateNativeTask): Promise<NativeTask>;
  list(actor: ActorContext, limit: number): Promise<NativeTaskSummary[]>;
  search(actor: ActorContext, query: NativeTaskSearchQuery): Promise<NativeTaskSearchResult>;
  get(actor: ActorContext, id: string): Promise<NativeTask>;
  control(actor: ActorContext, id: string, input: NativeTaskControl): Promise<NativeTask>;
  reply(actor: ActorContext, id: string, key: string, input: NativeTaskReply): Promise<NativeTask>;
}
export interface NativeTaskWorkerRepository {
  claim(workerId: string, leaseMilliseconds: number): Promise<NativeTaskClaim | null>;
  renew(claim: NativeTaskClaim, leaseMilliseconds: number): Promise<boolean>;
  progress(claim: NativeTaskClaim, update: NativeTaskProgress): Promise<boolean>;
  release(claim: NativeTaskClaim): Promise<void>;
}
