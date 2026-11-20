import { z } from 'zod';
import {
  CreateNativeTaskSchema, EnvironmentSchema, IdempotencyKeySchema, IdSchema,
  NativeTaskPageSchema, NativeTaskReplySchema, NativeTaskResponseSchema, NativeTaskSearchQuerySchema,
  type CreateNativeTask, type NativeTask, type NativeTaskReply, type NativeTaskStatus,
  type NativeTaskSummary, type NativeTaskControl, type NativeTaskStep, type Session,
} from '@pactwoven/contracts';
import { RequestError, type ApiRequestOptions, type TokenSource } from './api';
import { nativeApiRequest } from './native-api';
import { getNativeApiBase } from './config';

export const nativeTaskLabels: Record<NativeTaskStatus, string> = {
  queued: 'Ready to begin', running: 'Working', waiting_for_input: 'Needs your input',
  waiting_for_reply: 'Waiting for a reply', paused: 'Paused', completed: 'Completed',
  failed: 'Needs attention', cancelled: 'Cancelled',
};
export function nativeTaskTone(status: NativeTaskStatus): 'neutral' | 'blue' | 'amber' | 'green' | 'red' {
  if (status === 'completed') return 'green';
  if (status === 'running' || status === 'queued') return 'blue';
  if (status === 'failed') return 'red';
  if (status === 'waiting_for_input' || status === 'waiting_for_reply') return 'amber';
  return 'neutral';
}
export const nativeAgentLabels = { coordinator: 'Coordinator', research: 'Research', planning: 'Planning', supplier: 'Supplier', evidence: 'Evidence' } as const;
export const nativeStepLabels = { pending: 'Up next', working: 'Working', waiting: 'Waiting', completed: 'Done', failed: 'Needs attention' } as const;
export const nativeTaskPath = (id: string) => `/app/work/${encodeURIComponent(IdSchema.parse(id))}`;
export const nativeTaskQueryKey = (session: Session, id: string) => ['native-task', getNativeApiBase(), session.actor.environment, session.organization.id, session.actor.actorId, session.actor.sessionId, id] as const;
export const nativeTaskListKey = (session: Session) => ['native-tasks', getNativeApiBase(), session.actor.environment, session.organization.id, session.actor.actorId, session.actor.sessionId] as const;
export type NativeTaskListView = { q: string; filter: 'all' | 'active' | 'completed'; limit: number };
export const nativeTaskSearchKey = (session: Session, view: NativeTaskListView) => [...nativeTaskListKey(session),
  JSON.stringify([session.organization.authorityEpoch, session.actor.roles, session.actor.siteIds, session.actor.actionSiteIds]), view.q.trim(), view.filter, view.limit] as const;
export function nativeTaskSearchPath(view: NativeTaskListView, cursor?: string) {
  const query = NativeTaskSearchQuerySchema.parse({ ...view, ...(cursor ? { cursor } : {}) });
  const params = new URLSearchParams({ limit: String(query.limit), q: query.q, filter: query.filter });
  if (query.cursor) params.set('cursor', query.cursor);
  return `/v1/tasks?${params}`;
}
export function nativeTaskProgressAnnouncement(previous: NativeTask | undefined, task: NativeTask): string {
  if (!previous || previous.id !== task.id || task.version <= previous.version) return '';
  if (task.status !== previous.status) return `${task.title}. ${nativeTaskLabels[task.status]}.${task.status === 'completed' ? ' Your result is ready.' : task.status === 'waiting_for_input' ? ' Open the conversation to review what is needed.' : ''}`;
  const completed = task.steps.filter(step => step.status === 'completed' && previous.steps.find(old => old.id === step.id)?.status !== 'completed');
  if (completed.length) return completed.length === 1 ? `Step complete: ${completed[0]!.title}.` : `${completed.length} plan steps completed.`;
  if (task.artifacts.some(artifact => !previous.artifacts.some(old => old.id === artifact.id))) return 'New supporting work is available.';
  if (task.messages.some(message => message.role !== 'user' && !previous.messages.some(old => old.id === message.id))) return 'Pactwoven added a response to the conversation.';
  const started = task.steps.find(step => step.status === 'working' && previous.steps.find(old => old.id === step.id)?.status !== 'working');
  return task.status === 'running' && started ? `Working on: ${started.title}.` : '';
}
export function canStartNativeTask(session: Session) {
  return session.actor.principalKind === 'human' && session.actor.roles.some(role => role === 'owner' || role === 'operations') && session.sites.some(site => session.actor.actionSiteIds.includes(site.id));
}
export function scopedNativeTaskSchema(session: Session, id?: string) {
  return NativeTaskResponseSchema.refine(value =>
    value.scope.environment === session.actor.environment && value.scope.organizationId === session.organization.id &&
    session.sites.some(site => site.id === value.task.siteId) && (id === undefined || value.task.id === id),
  'Task does not match the current workspace.');
}
export function nativeTaskControlResponseSchema(session: Session, id: string, command: NativeTaskControl) {
  return scopedNativeTaskSchema(session, id).refine(value => value.task.version > command.expectedVersion &&
    (command.action === 'pause' ? value.task.status === 'paused' : command.action === 'cancel' ? value.task.status === 'cancelled' :
      ['queued', 'running'].includes(value.task.status)), 'The requested task state has not been confirmed.');
}
export function nativeStepPresentation(taskStatus: NativeTaskStatus, step: NativeTaskStep) {
  if (step.status === 'completed' || step.status === 'failed') return { state: step.status, label: nativeStepLabels[step.status], active: false };
  if (taskStatus === 'paused') return { state: 'waiting', label: 'Paused', active: false };
  if (taskStatus === 'cancelled') return { state: 'waiting', label: 'Stopped', active: false };
  if (taskStatus === 'failed') return { state: 'waiting', label: 'Interrupted', active: false };
  if (taskStatus === 'completed') return { state: 'waiting', label: 'Not confirmed', active: false };
  if (taskStatus === 'queued') return { state: 'pending', label: 'Up next', active: false };
  if (taskStatus !== 'running' && step.status === 'working') return { state: 'waiting', label: 'Waiting', active: false };
  return { state: step.status, label: nativeStepLabels[step.status], active: taskStatus === 'running' && step.status === 'working' };
}
export function scopedNativeTaskPageSchema(session: Session) {
  return NativeTaskPageSchema.refine(value => value.scope.environment === session.actor.environment &&
    value.scope.organizationId === session.organization.id && value.items.every(task => session.sites.some(site => site.id === task.siteId)),
  'Tasks do not match the current workspace.');
}
export function newerNativeTask(previous: NativeTask | undefined, incoming: NativeTask): NativeTask {
  return previous?.id === incoming.id && previous.version >= incoming.version ? previous : incoming;
}
export function nativeTaskIsActive(task: NativeTaskSummary) {
  return !['completed', 'failed', 'cancelled'].includes(task.status);
}
export function nativeTaskError(error: unknown, writing = false): string {
  if (error instanceof RequestError) {
    if ([401, 403].includes(error.status)) return 'Your access needs checking. Refresh your workspace or sign in again.';
    if (error.status === 404) return 'This work is no longer available in your current workspace.';
    if (error.status === 409) return 'This work changed. Refresh it before taking the next step.';
    if (error.status === 422) return 'Check the details and try again.';
    if (error.code === 'LOCAL_RECOVERY_UNAVAILABLE') return 'Allow this site to save data in this tab so an interrupted request can be recovered.';
    if (error.code === 'LOCAL_RECOVERY_INVALID') return 'A saved request needs attention. Review your Work list before starting another task.';
    if (error.code === 'PREVIOUS_CONNECTION_PENDING') return 'A saved request belongs to your previous work connection. Its outcome needs checking before another request can be started.';
    if (error.code === 'SETUP_REQUIRED' || error.code === 'API_NOT_CONFIGURED') return 'The work service is not connected yet. Your existing records are still available.';
  }
  return writing ? 'The result has not been confirmed. Check the saved request before trying a new one.' : 'We could not refresh this work. Try again when your connection returns.';
}
// A rejected fresh attempt can be edited. A later auth/validation denial does
// not establish whether an earlier, unconfirmed dispatch was already recorded.
export function taskAttemptWasRejected(error: unknown, recovering = false) {
  if (!(error instanceof RequestError)) return false;
  if (error.code === 'VERSION_CONFLICT' && error.status === 409) return true;
  if (recovering) return false;
  return (error.code === 'VALIDATION_FAILED' && error.status === 422) ||
    (['AUTH_REQUIRED', 'SESSION_REQUIRED'].includes(error.code) && error.status === 401) ||
    (error.code === 'FORBIDDEN' && error.status === 403);
}
export function taskReadDenied(error: unknown) {
  return error instanceof RequestError && [401, 403, 404].includes(error.status);
}

const TaskAttemptScopeSchema = z.strictObject({
  apiBase: z.string().min(1).max(2048), environment: EnvironmentSchema,
  organizationId: IdSchema, actorId: IdSchema, sessionId: z.string().min(1).max(256),
});
export type TaskAttemptScope = z.infer<typeof TaskAttemptScopeSchema>;
const TaskAttemptSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), scope: TaskAttemptScopeSchema, key: IdempotencyKeySchema, input: CreateNativeTaskSchema }),
  z.strictObject({ kind: z.literal('reply'), scope: TaskAttemptScopeSchema, key: IdempotencyKeySchema, taskId: IdSchema, input: NativeTaskReplySchema }),
]);
export type NativeTaskAttempt = z.infer<typeof TaskAttemptSchema>;
export type TaskAttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type TaskAttemptScanStorage = TaskAttemptStorage & Pick<Storage, 'key' | 'length'>;
export type PreviousTaskRequest = { key: string; kind: NativeTaskAttempt['kind']; taskId?: string };
const taskAttemptPrefix = 'pactwoven:task-request:v1:';
export function taskAttemptScope(session: Session): TaskAttemptScope {
  const apiBase = getNativeApiBase();
  if (!apiBase) throw new RequestError('API_NOT_CONFIGURED', 'Work is not connected.');
  return TaskAttemptScopeSchema.parse({ apiBase, environment: session.actor.environment, organizationId: session.organization.id,
    actorId: session.actor.actorId, sessionId: session.actor.sessionId });
}
export function taskScopesMatch(a: TaskAttemptScope, b: TaskAttemptScope): boolean {
  return a.apiBase === b.apiBase && a.environment === b.environment && a.organizationId === b.organizationId && a.actorId === b.actorId && a.sessionId === b.sessionId;
}
export function scopedNativeApiRequest<T>(path: string, schema: z.ZodType<T>, session: Session, getToken: TokenSource, options: ApiRequestOptions & {
  currentScope: () => TaskAttemptScope; savedScope?: TaskAttemptScope;
}): Promise<T> {
  const scope = options.savedScope ?? taskAttemptScope(session);
  const { currentScope, savedScope: _savedScope, ...transport } = options;
  const checkScope = () => {
    if (!taskScopesMatch(scope, currentScope()) || !taskScopesMatch(scope, taskAttemptScope(session))) {
      throw new RequestError('SCOPE_CHANGED', 'Workspace changed before this request was sent.');
    }
  };
  return nativeApiRequest(path, schema, async () => { checkScope(); return getToken(); }, { ...transport, beforeDispatch: () => {
    checkScope();
    transport.beforeDispatch?.();
  } });
}
export function taskAttemptStorageKey(scope: TaskAttemptScope, taskId?: string) {
  return taskAttemptPrefix + encodeURIComponent(JSON.stringify([scope.apiBase, scope.environment, scope.organizationId, scope.actorId, scope.sessionId, taskId ?? 'new']));
}
export function createTaskAttempt(scope: TaskAttemptScope, input: CreateNativeTask): NativeTaskAttempt {
  return TaskAttemptSchema.parse({ kind: 'create', scope, key: crypto.randomUUID(), input });
}
export function createTaskReplyAttempt(scope: TaskAttemptScope, taskId: string, input: NativeTaskReply): NativeTaskAttempt {
  return TaskAttemptSchema.parse({ kind: 'reply', scope, taskId, key: crypto.randomUUID(), input });
}
export function readTaskAttempt(storage: TaskAttemptStorage, scope: TaskAttemptScope, taskId?: string): NativeTaskAttempt | null {
  let raw: string | null;
  try { raw = storage.getItem(taskAttemptStorageKey(scope, taskId)); }
  catch { throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE', 'This tab cannot save a recovery request.'); }
  if (raw === null) return null;
  if (raw.length > 100_000) throw new RequestError('LOCAL_RECOVERY_INVALID', 'Saved request is not recognized.');
  const parsed = TaskAttemptSchema.safeParse((() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })());
  if (!parsed.success || !taskScopesMatch(parsed.data.scope, scope) ||
    (taskId ? parsed.data.kind !== 'reply' || parsed.data.taskId !== taskId : parsed.data.kind !== 'create')) {
    throw new RequestError('LOCAL_RECOVERY_INVALID', 'Saved request is not recognized.');
  }
  return parsed.data;
}
const TaskAttemptLocatorSchema = z.tuple([z.string().min(1).max(2048), EnvironmentSchema, IdSchema, IdSchema, z.string().min(1).max(256), IdSchema]);
/** Inspect only this identity's matching recovery slot; never dispatch to a stored origin. */
export function previousTaskRequests(storage: TaskAttemptScanStorage, scope: TaskAttemptScope, taskId?: string): PreviousTaskRequest[] {
  const references: PreviousTaskRequest[] = [];
  try {
    const length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) throw new RequestError('LOCAL_RECOVERY_INVALID', 'Saved requests need a recovery review.');
    for (let index = 0; index < length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(taskAttemptPrefix) || key.length > 16_384) continue;
      let decoded: unknown;
      try { decoded = JSON.parse(decodeURIComponent(key.slice(taskAttemptPrefix.length))); } catch { continue; }
      const parsed = TaskAttemptLocatorSchema.safeParse(decoded);
      if (!parsed.success) continue;
      const [apiBase, environment, organizationId, actorId, sessionId, slot] = parsed.data;
      if (apiBase === scope.apiBase || environment !== scope.environment || organizationId !== scope.organizationId ||
          actorId !== scope.actorId || sessionId !== scope.sessionId || slot !== (taskId ?? 'new')) continue;
      const original = readTaskAttempt(storage, { apiBase, environment, organizationId, actorId, sessionId }, taskId);
      if (original) references.push({ key: original.key, kind: original.kind, ...(original.kind === 'reply' ? { taskId: original.taskId } : {}) });
      if (references.length > 32) throw new RequestError('LOCAL_RECOVERY_INVALID', 'Saved requests need a recovery review.');
    }
    return references;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE', 'This tab cannot check its saved recovery requests.');
  }
}
export function requireCurrentTaskConnection(storage: TaskAttemptScanStorage, scope: TaskAttemptScope, taskId?: string): void {
  if (previousTaskRequests(storage, scope, taskId).length > 0) throw new RequestError('PREVIOUS_CONNECTION_PENDING', 'The original request needs a recovery review.');
}
export function storeTaskAttempt(storage: TaskAttemptStorage, attempt: NativeTaskAttempt): void {
  const parsed = TaskAttemptSchema.parse(attempt);
  const taskId = parsed.kind === 'reply' ? parsed.taskId : undefined;
  const previous = readTaskAttempt(storage, parsed.scope, taskId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) throw new RequestError('LOCAL_RECOVERY_INVALID', 'An earlier request still needs confirmation.');
  const key = taskAttemptStorageKey(parsed.scope, taskId);
  const raw = JSON.stringify(parsed);
  try {
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw Error('Storage did not retain the request.');
  } catch { throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE', 'This tab cannot save a recovery request.'); }
}
export function clearTaskAttempt(storage: TaskAttemptStorage, attempt: NativeTaskAttempt): void {
  const taskId = attempt.kind === 'reply' ? attempt.taskId : undefined;
  const previous = readTaskAttempt(storage, attempt.scope, taskId);
  if (previous && JSON.stringify(previous) === JSON.stringify(attempt)) storage.removeItem(taskAttemptStorageKey(attempt.scope, taskId));
}
export async function sendTaskAttempt(attempt: NativeTaskAttempt, session: Session, getToken: TokenSource, options: {
  signal: AbortSignal; currentScope: () => TaskAttemptScope; beforeDispatch?: () => void;
}) {
  const parsed = TaskAttemptSchema.parse(attempt);
  const schema = scopedNativeTaskSchema(session, parsed.kind === 'reply' ? parsed.taskId : undefined).refine(value =>
    (parsed.kind === 'reply' && value.task.version > parsed.input.expectedVersion && value.task.messages.some(message => message.role === 'user' && message.text === parsed.input.text)) || (parsed.kind === 'create' && value.task.siteId === parsed.input.siteId && value.task.prompt === parsed.input.prompt && value.task.mode === parsed.input.mode),
  'Saved work does not match the submitted request.');
  return scopedNativeApiRequest(parsed.kind === 'create' ? '/v1/tasks' : `/v1/tasks/${encodeURIComponent(parsed.taskId)}/messages`, schema, session, getToken, {
    body: parsed.input, idempotencyKey: parsed.key, signal: AbortSignal.any([options.signal, AbortSignal.timeout(25_000)]),
    savedScope: parsed.scope, currentScope: options.currentScope,
    beforeDispatch: () => { options.beforeDispatch?.(); },
  });
}
