import { NativeTaskControlSchema, type NativeTask, type NativeTaskControl, type Session } from '@pactwoven/contracts';
import { RequestError } from './api';
import { taskAttemptScope } from './native-tasks';

type TaskResponse = { scope: { environment: Session['actor']['environment']; organizationId: string }; task: NativeTask };
type ControlResult = { kind: 'confirmed'; response: TaskResponse } |
  { kind: 'rejected' | 'unknown'; error: unknown; latest?: TaskResponse | undefined };

// Snapshot values, rather than retaining mutable session arrays across token retrieval.
export function nativeControlContext(session: Session) {
  return JSON.stringify([taskAttemptScope(session), session.actor.principalKind, session.actor.organizationId,
    session.organization.authorityEpoch, session.actor.roles, session.actor.siteIds, session.actor.actionSiteIds,
    session.sites.map(site => site.id)]);
}

export function nativeControlWasRejected(error: unknown) {
  if (!(error instanceof RequestError)) return false;
  return (error.status === 409 && ['VERSION_CONFLICT', 'INVALID_TASK_STATE'].includes(error.code)) ||
    (error.status === 422 && error.code === 'VALIDATION_FAILED') ||
    (error.status === 401 && ['AUTH_REQUIRED', 'SESSION_REQUIRED'].includes(error.code)) ||
    (error.status === 403 && error.code === 'FORBIDDEN') ||
    (error.status === 404 && error.code === 'NOT_FOUND');
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const prefix = <T>(before: T[], after: T[]) => after.length >= before.length && before.every((value, index) => same(value, after[index]));

export function canRetryNativeControl(action: NativeTaskControl['action'], before: NativeTask, after: NativeTask) {
  if (action === 'resume' || !['queued', 'running'].includes(before.status) || !['queued', 'running'].includes(after.status) ||
      !before.availableActions.includes(action) || !after.availableActions.includes(action) ||
      before.id !== after.id || before.siteId !== after.siteId || before.prompt !== after.prompt ||
      before.mode !== after.mode || before.createdAt !== after.createdAt || after.version <= before.version) return false;
  // Never infer user intent from a truncated/gapped history. Existing conversation
  // and artifacts are append-only; only assistant messages can be newly recorded.
  if (!before.events.length || before.events[0]?.sequence !== 1 || !prefix(before.events, after.events) ||
      !after.events.every((event, index) => event.sequence === index + 1) ||
      !prefix(before.messages, after.messages) || !prefix(before.artifacts, after.artifacts) ||
      after.messages.slice(before.messages.length).some(message => message.role !== 'assistant')) return false;
  const appended = after.events.slice(before.events.length);
  // SQL progress increments one version and appends one event. Unrecorded state
  // changes (including a worker release) cannot pass this correspondence check.
  return appended.length === after.version - before.version && appended.every(event =>
    event.agent !== null && ['progress', 'message', 'artifact'].includes(event.kind));
}

export async function executeNativeControl(options: {
  action: NativeTaskControl['action']; task: NativeTask;
  assertCurrent: () => void;
  send: (command: NativeTaskControl, beforeDispatch: () => void) => Promise<TaskResponse>;
  read: () => Promise<TaskResponse>;
}): Promise<ControlResult> {
  const original = structuredClone(options.task);
  let latest: TaskResponse | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let dispatched = false;
    try {
      options.assertCurrent();
      const command = NativeTaskControlSchema.parse({ action: options.action, expectedVersion: latest?.task.version ?? original.version });
      const response = await options.send(command, () => { options.assertCurrent(); dispatched = true; });
      options.assertCurrent();
      return { kind: 'confirmed', response };
    } catch (error) {
      if (dispatched && !nativeControlWasRejected(error)) return { kind: 'unknown', error, latest };
      if (attempt !== 0 || options.action === 'resume' || !(error instanceof RequestError) || error.status !== 409 ||
          !(error.code === 'VERSION_CONFLICT' || (!dispatched && error.code === 'TASK_CHANGED'))) return { kind: 'rejected', error, latest };
      try {
        options.assertCurrent();
        latest = await options.read();
        options.assertCurrent();
      } catch {
        // The write was definitely rejected. A failed read does not make that
        // rejected write uncertain, and must never authorize another dispatch.
        return { kind: 'rejected', error };
      }
      if (!canRetryNativeControl(options.action, original, latest.task)) return { kind: 'rejected', error, latest };
    }
  }
  throw new Error('Unreachable task control attempt.');
}
