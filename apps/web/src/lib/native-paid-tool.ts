import { z } from 'zod';
import { IdSchema, InstantSchema } from '@pactwoven/contracts';
import { commandDigest } from '../../../../packages/contracts/src/canonical';
import { NativePaidToolViewSchema, type NativePaidToolView } from '../../../../packages/contracts/src/native-paid-tool';
import { RequestError, requestApiAtBase, type ApiRequestOptions, type TokenSource } from './api';
import { getNativeApiBase } from './config';
import { agentWorkResponseScope, type AgentWorkScope, type AgentWorkStorage } from './native-agent-work';

const PublicScope = z.strictObject({ environment: z.literal('development'), organizationId: IdSchema, siteId: IdSchema });
const Scope = z.strictObject({ apiBase: z.string().min(1).max(2048), environment: z.enum(['simulation','development','staging','production']), organizationId: IdSchema, actorId: IdSchema, sessionId: z.string().min(1).max(256), siteId: IdSchema });
const Hash = z.string().regex(/^[0-9a-f]{64}$/), Version = z.number().int().min(1).max(33);
const Receipt = z.strictObject({ commandKey: IdSchema, commandHash: Hash, previousVersion: Version, version: Version, recordedAt: InstantSchema, status: NativePaidToolViewSchema.shape.state });
const Command = z.strictObject({ operationId: IdSchema, commandKey: IdSchema, expectedVersion: Version, kind: z.enum(['cancel_before_signing','revoke']) });
const Attempt = z.strictObject({ scope: Scope, rootTaskId: IdSchema, command: Command, commandHash: Hash });
export type PaidToolControlAttempt = z.infer<typeof Attempt>;
const same = (a: AgentWorkScope, b: AgentWorkScope) => Object.keys(a).every(key => a[key as keyof AgentWorkScope] === b[key as keyof AgentWorkScope]);
const matches = (scope: AgentWorkScope, root: string, purchase: NativePaidToolView) => agentWorkResponseScope(scope, purchase) && purchase.rootTaskId === root;
export const paidToolListSchema = (scope: AgentWorkScope, root: string) => z.strictObject({ scope: PublicScope, rootTaskId: IdSchema, purchases: z.array(NativePaidToolViewSchema).max(32) }).refine(value =>
  agentWorkResponseScope(scope, value) && value.rootTaskId === root && value.purchases.every(p => matches(scope, root, p)) && new Set(value.purchases.map(p => p.operationId)).size === value.purchases.length);
export const paidToolReadSchema = (scope: AgentWorkScope, root: string, operationId: string) => z.strictObject({ scope: PublicScope, rootTaskId: IdSchema, purchase: NativePaidToolViewSchema }).refine(value =>
  agentWorkResponseScope(scope, value) && value.rootTaskId === root && matches(scope, root, value.purchase) && value.purchase.operationId === operationId);
export const paidToolRecoverySchema = (attempt: PaidToolControlAttempt) => z.strictObject({ scope: PublicScope, rootTaskId: IdSchema,
  recovery: z.strictObject({ purchase: NativePaidToolViewSchema, receipt: Receipt }).nullable() }).refine(value => agentWorkResponseScope(attempt.scope, value) && value.rootTaskId === attempt.rootTaskId &&
  (!value.recovery || matches(attempt.scope, attempt.rootTaskId, value.recovery.purchase) && value.recovery.purchase.operationId === attempt.command.operationId &&
    value.recovery.receipt.commandKey === attempt.command.commandKey && value.recovery.receipt.commandHash === attempt.commandHash &&
    value.recovery.receipt.previousVersion === attempt.command.expectedVersion && value.recovery.receipt.version === attempt.command.expectedVersion + 1 && value.recovery.purchase.version >= value.recovery.receipt.version));

export function paidToolPath(root: string, site: string, operation?: string, action?: 'control' | 'recover') {
  return `/v1/agent-work/${encodeURIComponent(IdSchema.parse(root))}/purchases${operation ? `/${encodeURIComponent(IdSchema.parse(operation))}${action ? `/${action}` : ''}` : ''}${action ? '' : `?siteId=${encodeURIComponent(IdSchema.parse(site))}`}`;
}
export async function paidToolRequest<T>(path: string, schema: z.ZodType<T>, scope: AgentWorkScope, getToken: TokenSource, current: () => AgentWorkScope, options: ApiRequestOptions = {}) {
  const read = /^\/v1\/agent-work\/[A-Za-z0-9_-]{1,128}\/purchases(?:\/[A-Za-z0-9_-]{1,128})?\?siteId=[A-Za-z0-9_-]{1,128}$/;
  const write = /^\/v1\/agent-work\/[A-Za-z0-9_-]{1,128}\/purchases\/[A-Za-z0-9_-]{1,128}\/(?:control|recover)$/;
  if (!(options.body === undefined ? read : write).test(path)) throw new RequestError('INVALID_PATH', 'This purchase request is not supported.');
  const check = () => { if (getNativeApiBase() !== scope.apiBase || !same(scope, current())) throw new RequestError('SCOPE_CHANGED', 'Your workspace changed.'); };
  check(); const result = await requestApiAtBase(scope.apiBase, path, schema, async () => { check(); return getToken(); }, { ...options, beforeDispatch: () => { check(); options.beforeDispatch?.(); } });
  options.signal?.throwIfAborted(); check(); return result;
}
const prefix = 'pactwoven:paid-tool-control:v1:';
const storageKey = (scope: AgentWorkScope, root: string, operation: string) => `${prefix}${encodeURIComponent(JSON.stringify(Scope.parse(scope)))}:${IdSchema.parse(root)}:${IdSchema.parse(operation)}`;
export function readPaidToolAttempt(storage: AgentWorkStorage, scope: AgentWorkScope, root: string, operation: string) {
  try {
    const raw = storage.getItem(storageKey(scope, root, operation)); if (raw === null) return null;
    if (raw.length > 8000) throw Error(); const attempt = Attempt.parse(JSON.parse(raw));
    if (!same(scope, attempt.scope) || attempt.rootTaskId !== root || attempt.command.operationId !== operation) throw Error(); return attempt;
  } catch { throw new RequestError('LOCAL_RECOVERY_INVALID', 'The original purchase action needs a recovery check.'); }
}
export function storePaidToolAttempt(storage: AgentWorkStorage, input: PaidToolControlAttempt) {
  const attempt = Attempt.parse(input), key = storageKey(attempt.scope, attempt.rootTaskId, attempt.command.operationId);
  try {
    if (!Number.isSafeInteger(storage.length) || storage.length > 10000) throw Error();
    for (let i = 0; i < storage.length; i++) {
      const otherKey = storage.key(i); if (!otherKey?.startsWith(prefix) || otherKey === key) continue;
      const raw = storage.getItem(otherKey); if (!raw || raw.length > 8000) throw Error(); const other = Attempt.parse(JSON.parse(raw));
      if (other.scope.apiBase !== attempt.scope.apiBase && other.scope.environment === attempt.scope.environment && other.scope.organizationId === attempt.scope.organizationId && other.scope.siteId === attempt.scope.siteId && other.scope.actorId === attempt.scope.actorId && other.scope.sessionId === attempt.scope.sessionId && other.rootTaskId === attempt.rootTaskId && other.command.operationId === attempt.command.operationId) throw new RequestError('PREVIOUS_CONNECTION_PENDING', 'Recover the original service connection first.');
    }
    const prior = readPaidToolAttempt(storage, attempt.scope, attempt.rootTaskId, attempt.command.operationId), raw = JSON.stringify(attempt);
    if (prior && JSON.stringify(prior) !== raw) throw new RequestError('LOCAL_RECOVERY_INVALID', 'Recover the original action first.');
    storage.setItem(key, raw); if (storage.getItem(key) !== raw) throw Error();
  } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE', 'This tab cannot retain the original action.'); }
}
export function clearPaidToolAttempt(storage: AgentWorkStorage, attempt: PaidToolControlAttempt) {
  const prior = readPaidToolAttempt(storage, attempt.scope, attempt.rootTaskId, attempt.command.operationId);
  if (prior && JSON.stringify(prior) !== JSON.stringify(attempt)) throw new RequestError('LOCAL_RECOVERY_INVALID', 'A different action needs recovery.');
  try { const key = storageKey(attempt.scope, attempt.rootTaskId, attempt.command.operationId); storage.removeItem(key); if (storage.getItem(key) !== null) throw Error(); }
  catch { throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE', 'The original action could not be cleared.'); }
}
export async function createPaidToolAttempt(scope: AgentWorkScope, rootTaskId: string, operationId: string, expectedVersion: number, kind: PaidToolControlAttempt['command']['kind']) {
  const command = Command.parse({ operationId, commandKey: crypto.randomUUID(), expectedVersion, kind });
  return Attempt.parse({ scope, rootTaskId, command, commandHash: await commandDigest({ namespace: 'pactwoven.paid-tool-command.v1', command }) });
}
async function verifyAttempt(attempt: PaidToolControlAttempt) {
  Attempt.parse(attempt); if (attempt.commandHash !== await commandDigest({ namespace: 'pactwoven.paid-tool-command.v1', command: attempt.command })) throw new RequestError('LOCAL_RECOVERY_INVALID', 'The original action has changed.');
}
export async function sendPaidToolControl(attempt: PaidToolControlAttempt, getToken: TokenSource, current: () => AgentWorkScope, options: ApiRequestOptions = {}) {
  await verifyAttempt(attempt);
  const schema = paidToolReadSchema(attempt.scope, attempt.rootTaskId, attempt.command.operationId).refine(value => value.purchase.version > attempt.command.expectedVersion);
  const { operationId, ...body } = attempt.command;
  return paidToolRequest(paidToolPath(attempt.rootTaskId, attempt.scope.siteId, operationId, 'control'), schema, attempt.scope, getToken, current, { ...options, body: { siteId: attempt.scope.siteId, ...body } });
}
export async function recoverPaidToolControl(attempt: PaidToolControlAttempt, getToken: TokenSource, current: () => AgentWorkScope, options: ApiRequestOptions = {}) {
  await verifyAttempt(attempt);
  return paidToolRequest(paidToolPath(attempt.rootTaskId, attempt.scope.siteId, attempt.command.operationId, 'recover'), paidToolRecoverySchema(attempt), attempt.scope, getToken, current,
    { ...options, body: { siteId: attempt.scope.siteId, commandKey: attempt.command.commandKey, commandHash: attempt.commandHash } });
}
