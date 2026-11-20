import { z } from 'zod';
import {
  EnvironmentSchema, IdSchema, IdempotencyKeySchema, NativeMemoryNoteCommandSchema,
  NativeMemoryNotePageSchema, NativeMemoryNoteResponseSchema, NativeMemoryNoteOperationSchema,
  NativeMemoryNoteQuerySchema, type NativeMemoryNoteCommand, type NativeMemoryNoteOperation,
  type NativeMemoryNoteDetail, type Session,
} from '@pactwoven/contracts';
import { RequestError, requestApiAtBase, type ApiRequestOptions, type TokenSource } from './api';
import { getNativeApiBase } from './config';

export const memoryStatusLabels = { available: 'Available', needs_review: 'Needs review', removed: 'Removed' } as const;
export type MemoryFilter = 'all' | keyof typeof memoryStatusLabels;
export const readableMemorySites = (session: Session) => session.actor.principalKind === 'human' ? session.sites.filter(site => session.actor.siteIds.includes(site.id)) : [];
export const canWriteMemory = (session: Session, siteId: string) => readableMemorySites(session).some(site => site.id === siteId) && session.actor.actionSiteIds.includes(siteId) && session.actor.roles.some(role => role === 'owner' || role === 'operations');
export const memoryPath = (siteId: string, id?: string) => `/app/memory${id ? `/${encodeURIComponent(IdSchema.parse(id))}` : ''}?site=${encodeURIComponent(IdSchema.parse(siteId))}`;
const ScopeSchema = z.strictObject({ apiBase: z.string().min(1).max(2048), environment: EnvironmentSchema,
  organizationId: IdSchema, actorId: IdSchema, sessionId: z.string().min(1).max(256), siteId: IdSchema });
export type MemoryScope = z.infer<typeof ScopeSchema>;
export function memoryScope(session: Session, siteId: string): MemoryScope {
  const apiBase = getNativeApiBase();
  if (!apiBase) throw new RequestError('API_NOT_CONFIGURED', 'Saved memory is not connected yet.');
  if (!readableMemorySites(session).some(site => site.id === siteId)) throw new RequestError('FORBIDDEN', 'This site is outside your access.', 403);
  return ScopeSchema.parse({ apiBase, environment: session.actor.environment, organizationId: session.organization.id,
    actorId: session.actor.actorId, sessionId: session.actor.sessionId, siteId });
}
export function memoryIdentity(session: Session, siteId: string) {
  return JSON.stringify([getNativeApiBase(), session.actor.environment, session.organization.id, session.actor.actorId,
    session.actor.sessionId, siteId, session.actor.principalKind, session.organization.authorityEpoch,
    session.actor.roles, session.actor.siteIds, session.actor.actionSiteIds]);
}
export const memoryKey = (session: Session, siteId: string) => ['native-memory', memoryIdentity(session, siteId)] as const;
const sameScope = (a: MemoryScope, b: MemoryScope) => Object.keys(a).every(key => a[key as keyof MemoryScope] === b[key as keyof MemoryScope]);
const responseScope = (scope: MemoryScope, value: { scope: { environment: string; organizationId: string; siteId: string } }) => value.scope.environment === scope.environment && value.scope.organizationId === scope.organizationId && value.scope.siteId === scope.siteId;
export function memoryPageSchema(scope: MemoryScope, status: MemoryFilter, cursor?: string) {
  return NativeMemoryNotePageSchema.refine(value => responseScope(scope, value) && value.items.length <= 20 &&
    new Set(value.items.map(item => item.id)).size === value.items.length && value.nextCursor !== cursor &&
    value.items.every(item => (status === 'all' || item.status === status) && (item.status !== 'removed' || item.title === 'Removed note')), 'Notes do not match this view.');
}
export const memoryDetailSchema = (scope: MemoryScope, id: string) => NativeMemoryNoteResponseSchema.refine(value => responseScope(scope, value) && value.note.id === id, 'Note does not match this workspace.');
export function memoryOperationSchema(scope: MemoryScope, command: NativeMemoryNoteCommand) {
  return NativeMemoryNoteOperationSchema.refine(value => responseScope(scope, value) && value.action === command.kind &&
    (command.kind === 'remember' || value.noteId === command.noteId) && (!value.current || value.current.id === value.noteId), 'The original update has not been confirmed.');
}
export function memoryListPath(siteId: string, status: MemoryFilter, cursor?: string) {
  const query = NativeMemoryNoteQuerySchema.parse({ siteId, status, limit: 20, ...(cursor ? { cursor } : {}) });
  const params = new URLSearchParams({ siteId: query.siteId, status: query.status, limit: String(query.limit) });
  if (query.cursor) params.set('cursor', query.cursor);
  return `/v1/memory?${params}`;
}
export async function memoryRequest<T>(path: string, schema: z.ZodType<T>, scope: MemoryScope, getToken: TokenSource,
  current: () => MemoryScope, options: ApiRequestOptions = {}): Promise<T> {
  if (!/^\/v1\/memory(?:\?[^#]*|\/[A-Za-z0-9_-]{1,128}\?[^#]*|\/operations\/[A-Za-z0-9_-]{8,128}\?[^#]*)?$/.test(path)) throw new RequestError('INVALID_PATH', 'This note request is not supported.');
  const check = () => {
    if (getNativeApiBase() !== scope.apiBase || !sameScope(scope, current())) throw new RequestError('SCOPE_CHANGED', 'Your workspace changed. Open the note again.');
  };
  check();
  const result = await requestApiAtBase(scope.apiBase, path, schema, async () => { check(); return getToken(); }, {
    ...options, beforeDispatch: () => { check(); options.beforeDispatch?.(); },
  });
  options.signal?.throwIfAborted(); check();
  return result;
}
const AttemptSchema = z.strictObject({ scope: ScopeSchema, key: IdempotencyKeySchema, input: NativeMemoryNoteCommandSchema }).refine(value => value.scope.siteId === value.input.siteId);
export type MemoryAttempt = z.infer<typeof AttemptSchema>;
export type MemoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>;
const prefix = 'pactwoven:memory-request:v1:';
const storageKey = (scope: MemoryScope) => `${prefix}${encodeURIComponent(JSON.stringify(ScopeSchema.parse(scope)))}`;
export function readMemoryAttempt(storage: MemoryStorage, scope: MemoryScope): MemoryAttempt | null {
  try {
    const raw = storage.getItem(storageKey(scope));
    if (raw === null) return null;
    if (raw.length > 100_000) throw Error();
    const attempt = AttemptSchema.parse(JSON.parse(raw));
    if (!sameScope(scope, attempt.scope)) throw Error();
    return attempt;
  } catch { throw new RequestError('LOCAL_RECOVERY_INVALID', 'The saved update needs a recovery review.'); }
}
export function previousMemoryConnection(storage: MemoryStorage, scope: MemoryScope): boolean {
  try {
    if (!Number.isSafeInteger(storage.length) || storage.length < 0 || storage.length > 10_000) throw Error();
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      let parsed: ReturnType<typeof ScopeSchema.safeParse> | undefined;
      try { parsed = ScopeSchema.safeParse(JSON.parse(decodeURIComponent(key.slice(prefix.length)))); } catch { continue; }
      if (!parsed?.success) continue;
      const previous = parsed.data;
      if (previous.apiBase !== scope.apiBase && previous.environment === scope.environment && previous.organizationId === scope.organizationId &&
        previous.actorId === scope.actorId && previous.sessionId === scope.sessionId && previous.siteId === scope.siteId && readMemoryAttempt(storage, previous)) return true;
    }
    return false;
  } catch { throw new RequestError('LOCAL_RECOVERY_INVALID', 'The saved update needs a recovery review.'); }
}
export function createMemoryAttempt(scope: MemoryScope, input: NativeMemoryNoteCommand): MemoryAttempt {
  return AttemptSchema.parse({ scope, key: crypto.randomUUID(), input });
}
export function storeMemoryAttempt(storage: MemoryStorage, attempt: MemoryAttempt) {
  const parsed = AttemptSchema.parse(attempt);
  if (previousMemoryConnection(storage, parsed.scope)) throw new RequestError('PREVIOUS_CONNECTION_PENDING', 'An update at your previous connection needs confirmation.');
  const previous = readMemoryAttempt(storage, parsed.scope);
  if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) throw new RequestError('LOCAL_RECOVERY_INVALID', 'Check the original update before starting another.');
  const raw = JSON.stringify(parsed);
  try { storage.setItem(storageKey(parsed.scope), raw); if (storage.getItem(storageKey(parsed.scope)) !== raw) throw Error(); }
  catch { throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE', 'This tab cannot retain the original update.'); }
}
export function clearMemoryAttempt(storage: MemoryStorage, attempt: MemoryAttempt) {
  const previous = readMemoryAttempt(storage, attempt.scope);
  if (previous && JSON.stringify(previous) !== JSON.stringify(attempt)) throw new RequestError('LOCAL_RECOVERY_INVALID', 'Another saved update needs attention.');
  storage.removeItem(storageKey(attempt.scope));
  if (storage.getItem(storageKey(attempt.scope)) !== null) throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE', 'This tab could not clear the confirmed request.');
}
export function sendMemoryAttempt(attempt: MemoryAttempt, getToken: TokenSource, current: () => MemoryScope, options: ApiRequestOptions = {}) {
  const parsed = AttemptSchema.parse(attempt);
  return memoryRequest('/v1/memory', memoryOperationSchema(parsed.scope, parsed.input), parsed.scope, getToken, current,
    { ...options, body: parsed.input, idempotencyKey: parsed.key });
}
export function recoverMemoryAttempt(attempt: MemoryAttempt, getToken: TokenSource, current: () => MemoryScope, signal: AbortSignal) {
  const parsed = AttemptSchema.parse(attempt);
  return memoryRequest(`/v1/memory/operations/${encodeURIComponent(parsed.key)}?siteId=${encodeURIComponent(parsed.scope.siteId)}`,
    z.strictObject({ operation: memoryOperationSchema(parsed.scope, parsed.input).nullable() }), parsed.scope, getToken, current, { signal });
}
export const memoryReadDenied = (error: unknown) => error instanceof RequestError && [401, 403, 404].includes(error.status);
export function memoryReviewDateIsFuture(command: NativeMemoryNoteCommand, now = Date.now()) {
  return command.kind === 'remove' || Date.parse(command.reviewBy) > now;
}
// 0028 serializes the original key, then returns any retained operation before
// checking CAS. An exact VERSION_CONFLICT therefore rejects even a replay.
// EVIDENCE_STALE can also occur projecting a retained operation; it is definite
// only for a first attempt. Auth/validation/unknown replay failures stay locked.
export function memoryAttemptRejected(error: unknown, replaying = false) {
  if (!(error instanceof RequestError)) return false;
  if (error.code === 'VERSION_CONFLICT' && error.status === 409) return true;
  if (replaying) return false;
  return ((error.code === 'EVIDENCE_STALE' && error.status === 409) ||
    (error.code === 'VALIDATION_FAILED' && error.status === 422) || (error.code === 'FORBIDDEN' && error.status === 403) ||
    (['AUTH_REQUIRED', 'SESSION_REQUIRED'].includes(error.code) && error.status === 401));
}
export function memoryError(error: unknown, context: 'read' | 'write' = 'write'): string {
  if (error instanceof RequestError) {
    if (memoryReadDenied(error)) return 'Your access to this note needs checking. Refresh the workspace or sign in again.';
    if (error.code === 'REVIEW_DATE_PAST') return 'Choose a review date and time in the future. Your draft is kept.';
    if (error.code === 'EVIDENCE_STALE') return 'The review date or your access is no longer current. Your draft is kept. Check the date and refresh workspace access before continuing.';
    if (error.code === 'VERSION_CONFLICT') return 'This note changed. Your draft is kept here. Review the current note before updating it.';
    if (error.code === 'SETUP_REQUIRED' || error.code === 'API_NOT_CONFIGURED') return 'Saved memory is not connected yet.';
    if (error.code === 'VALIDATION_FAILED') return context === 'read'
      ? 'This note view could not be loaded. Refresh the page or reopen it from Memory.'
      : 'Enter a title, note, purpose and valid review date.';
    if (error.code === 'PREVIOUS_CONNECTION_PENDING') return 'An update belongs to your previous service connection. Restore that connection to check its original result before starting another update.';
    if (error.code.startsWith('LOCAL_RECOVERY')) return 'This tab cannot safely retain or read the original update. Restore tab storage before continuing.';
    if (error.code === 'SCOPE_CHANGED') return 'Your workspace changed. Open the note again to continue.';
  }
  return 'The result could not be confirmed. Check the original update before trying again.';
}
export type MemoryDraft = { title: string; text: string; purpose: string; reviewBy: string };
export const draftFromNote = (note: NativeMemoryNoteDetail): MemoryDraft => ({ title: note.title, text: note.text ?? '', purpose: note.purpose ?? '', reviewBy: note.reviewBy ?? '' });
export function operationMessage(operation: NativeMemoryNoteOperation) {
  return operation.action === 'remove' ? 'Removed from future work. Prior records remain.' : 'Your update was saved. The current note is shown below.';
}
