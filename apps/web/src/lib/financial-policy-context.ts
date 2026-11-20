import { z } from 'zod';
import { IdSchema, RoleSchema, ResponsibilitySchema, SessionSchema, FinancialPolicyHttpContextSchema,
  type Session, type Responsibility, type FinancialPolicyHttpContext } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { getApiBase } from './config';
import { FinancialPolicyClientError, FinancialPolicyLocalScopeSchema, financialParse, financialSame, freezeFinancial,
  qualifyFinancialContextMaterial, type FinancialPolicyLocalScope } from './financial-policy-contract';

const sorted = <T extends z.ZodType>(schema: T, maximum: number) => z.array(schema).max(maximum)
  .refine(v => v.every((x, i) => i === 0 || String(v[i - 1]) < String(x)));
export const FinancialPolicyBootstrapSchema = z.strictObject({
  ...FinancialPolicyLocalScopeSchema.shape, environment: z.literal('development'), userId: IdSchema, externalOrganizationId: IdSchema,
  sessionId: z.string().min(1).max(256), organizationEpoch: z.number().int().nonnegative(), roles: sorted(RoleSchema, 9),
  siteIds: sorted(IdSchema, 100), actionSiteIds: sorted(IdSchema, 100),
  responsibility: z.strictObject({ id: IdSchema, version: z.number().int().positive(), siteId: IdSchema }).nullable(),
}).refine(v => v.roles.some(r => ['owner', 'finance', 'operations'].includes(r)) &&
  (v.responsibilityId === null ? v.responsibility === null && v.roles.some(r => r === 'owner' || r === 'finance') :
    v.responsibility?.id === v.responsibilityId && v.siteIds.includes(v.responsibility.siteId) && v.actionSiteIds.includes(v.responsibility.siteId)));
export type FinancialPolicyBootstrap = z.infer<typeof FinancialPolicyBootstrapSchema>;
export type FinancialPolicyAuth = { isLoaded?: boolean | undefined; isSignedIn?: boolean | undefined;
  userId?: string | null | undefined; orgId?: string | null | undefined; sessionId?: string | null | undefined };
export function createFinancialPolicyBootstrap(sessionInput: Session, auth: FinancialPolicyAuth, apiBase: string | null,
  responsibilityInput: Responsibility | null = null, routeId: string | null = null): FinancialPolicyBootstrap {
  const session = financialParse(SessionSchema, sessionInput);
  const responsibility = responsibilityInput === null ? null : financialParse(ResponsibilitySchema, responsibilityInput);
  if (!auth.isLoaded || !auth.isSignedIn || !auth.userId || !auth.orgId || !auth.sessionId || !apiBase || apiBase !== getApiBase() ||
    session.actor.principalKind !== 'human' || session.actor.environment !== 'development' ||
    session.actor.organizationId !== session.organization.id || session.actor.sessionId !== auth.sessionId ||
    responsibility && (responsibility.id !== routeId || responsibility.environment !== 'development' || responsibility.organizationId !== session.organization.id) ||
    (responsibility === null) !== (routeId === null)) throw new FinancialPolicyClientError('scope');
  return freezeFinancial(financialParse(FinancialPolicyBootstrapSchema, { environment: 'development', apiBase, userId: auth.userId,
    externalOrganizationId: auth.orgId, sessionId: auth.sessionId, organizationId: session.organization.id, actorId: session.actor.actorId,
    organizationEpoch: session.organization.authorityEpoch, roles: [...session.actor.roles].sort(), siteIds: [...session.actor.siteIds].sort(),
    actionSiteIds: [...session.actor.actionSiteIds].sort(), responsibilityId: routeId,
    responsibility: responsibility && { id: responsibility.id, version: responsibility.version, siteId: responsibility.siteId } }));
}
export const financialPolicyBootstrapKey = (input: FinancialPolicyBootstrap) => canonicalJson(financialParse(FinancialPolicyBootstrapSchema, input));
export function financialPolicyLocalScope(input: FinancialPolicyBootstrap): FinancialPolicyLocalScope {
  const b = financialParse(FinancialPolicyBootstrapSchema, input);
  return freezeFinancial({ environment: b.environment, organizationId: b.organizationId, actorId: b.actorId,
    apiBase: b.apiBase, responsibilityId: b.responsibilityId });
}
export type FinancialPolicyObservation = Readonly<{ bootstrap: FinancialPolicyBootstrap; context: FinancialPolicyHttpContext;
  receivedAt: number; receivedMonotonic: number; expiresAt: number }>;
const parsedObservations = new WeakSet<object>();
export async function qualifyFinancialContext(input: unknown, bootstrapInput: FinancialPolicyBootstrap, receivedAt: number,
  receivedMonotonic: number): Promise<FinancialPolicyObservation> {
  const bootstrap = freezeFinancial(financialParse(FinancialPolicyBootstrapSchema, bootstrapInput));
  const context = freezeFinancial(financialParse(FinancialPolicyHttpContextSchema, input));
  const s = context.scope, b = bootstrap;
  if (s.environment !== b.environment || s.organizationId !== b.organizationId || s.actor.actorId !== b.actorId ||
    s.organizationEpoch !== b.organizationEpoch || !financialSame(s.roles, b.roles) || !financialSame(s.siteIds, b.siteIds) ||
    !financialSame(s.actionSiteIds, b.actionSiteIds) || context.responsibilityId !== b.responsibilityId ||
    b.responsibility !== null && (!context.draftScope || context.draftScope.authority.responsibility.id !== b.responsibility.id ||
      context.draftScope.authority.responsibility.version !== b.responsibility.version || context.draftScope.site.id !== b.responsibility.siteId))
    throw new FinancialPolicyClientError('scope');
  const observedAt = Date.parse(context.observation.observedAt), expiresAt = Math.min(Date.parse(context.observation.expiresAt), observedAt + 20_000);
  if (![receivedAt, receivedMonotonic].every(n => Number.isFinite(n) && n >= 0) || observedAt > receivedAt || expiresAt <= receivedAt)
    throw new FinancialPolicyClientError('expired');
  await qualifyFinancialContextMaterial(context);
  const observation = freezeFinancial({ bootstrap, context, receivedAt, receivedMonotonic, expiresAt });
  parsedObservations.add(observation); return observation;
}
/** A forward-only clock. Rollback cannot extend either a request or observation. */
export function createFinancialPolicyClock(receivedAt: number, receivedMonotonic: number,
  wall: () => number = Date.now, monotonic: () => number = () => performance.now()) {
  let highest = receivedAt, lastMonotonic = receivedMonotonic, failed = false;
  if (![receivedAt, receivedMonotonic].every(n => Number.isFinite(n) && n >= 0)) throw new FinancialPolicyClientError('expired');
  return () => {
    const w = wall(), m = monotonic();
    if (failed || !Number.isFinite(w) || w < 0 || !Number.isFinite(m) || m < lastMonotonic) {
      failed = true; throw new FinancialPolicyClientError('expired');
    }
    lastMonotonic = m; highest = Math.max(highest, w, receivedAt + m - receivedMonotonic); return highest;
  };
}
export type FinancialPolicyReadAction = 'context' | 'read' | 'index' | 'lookup';
export type FinancialPolicyPermission = Readonly<{ action: FinancialPolicyReadAction; target: string }>;
export type FinancialPolicyInvalidationCause = 'observation-expired' | 'clock-error' | 'context-refresh' | 'invalidated'
  | 'adapters-replaced' | 'denied' | 'hidden' | 'activated' | 'closed';
type Ticket = { controller: AbortController; generation: number; action: FinancialPolicyReadAction };
/** Own this once per mounted route, independently of replaceable transport adapters. */
export function createFinancialPolicyLifetime(initial: FinancialPolicyBootstrap,
  clocks: { wall?: () => number; monotonic?: () => number } = {}) {
  let bootstrap = freezeFinancial(financialParse(FinancialPolicyBootstrapSchema, initial));
  let generation = 0, visible = true, alive = true, active: Ticket | null = null;
  let observation: FinancialPolicyObservation | null = null, now: (() => number) | null = null;
  let adapterOwner: object | null = null;
  const denied = new Set<string>(), cleanups = new Set<(cause: FinancialPolicyInvalidationCause) => void>();
  const permissions = new WeakMap<object, { generation: number; used: boolean }>();
  const wall = clocks.wall ?? Date.now, monotonic = clocks.monotonic ?? (() => performance.now());
  let invalidating = false;
  function invalidate(cause: Exclude<FinancialPolicyInvalidationCause, 'context-refresh'> = 'invalidated') {
    if (invalidating) return;
    invalidating = true;
    generation++; observation = null; now = null; const old = active; active = null;
    old?.controller.abort();
    for (const clear of cleanups) { try { clear(cause); } catch { /* Cleanup cannot reopen a lifetime. */ } }
    invalidating = false;
  }
  function permitted() {
    if (!alive || !visible || invalidating || denied.has(financialPolicyBootstrapKey(bootstrap))) throw new FinancialPolicyClientError('scope');
  }
  function currentObservation() {
    permitted();
    if (!observation || !now) throw new FinancialPolicyClientError('expired');
    let currentTime: number;
    try { currentTime = now(); }
    catch { invalidate('clock-error'); throw new FinancialPolicyClientError('expired'); }
    if (currentTime >= observation.expiresAt) { invalidate('observation-expired'); throw new FinancialPolicyClientError('expired'); }
    return observation;
  }
  return {
    bootstrap: () => bootstrap,
    onInvalidate(clear: (cause: FinancialPolicyInvalidationCause) => void) { cleanups.add(clear); return () => cleanups.delete(clear); },
    authorize(action: FinancialPolicyReadAction, target: unknown): FinancialPolicyPermission {
      permitted(); if (active || !['context', 'read', 'index', 'lookup'].includes(action)) throw new FinancialPolicyClientError('scope');
      if (action !== 'context') currentObservation();
      const permission = freezeFinancial({ action, target: canonicalJson(target) });
      permissions.set(permission, { generation, used: false }); return permission;
    },
    start(permission: FinancialPolicyPermission, action: FinancialPolicyReadAction, target: unknown) {
      permitted(); const issued = permissions.get(permission);
      if (active || !issued || issued.used || issued.generation !== generation || permission.action !== action || permission.target !== canonicalJson(target))
        throw new FinancialPolicyClientError('scope');
      if (action !== 'context') currentObservation();
      issued.used = true; active = { controller: new AbortController(), generation, action };
      if (action === 'context') { observation = null; now = null; for (const clear of cleanups) { try { clear('context-refresh'); } catch { /* Already invalid. */ } } }
      return active;
    },
    assert(ticket: Ticket, expected: FinancialPolicyBootstrap) {
      permitted(); if (active !== ticket || ticket.generation !== generation || ticket.controller.signal.aborted || !financialSame(bootstrap, expected))
        throw new FinancialPolicyClientError('scope');
      if (ticket.action !== 'context') currentObservation();
    },
    owns(ticket: Ticket) { return alive && visible && active === ticket && ticket.generation === generation; },
    accept(ticket: Ticket, value: FinancialPolicyObservation) {
      if (ticket.action !== 'context' || !parsedObservations.has(value)) throw new FinancialPolicyClientError('input');
      this.assert(ticket, value.bootstrap);
      const nextNow = createFinancialPolicyClock(value.receivedAt, value.receivedMonotonic, wall, monotonic);
      let currentTime: number;
      try { currentTime = nextNow(); }
      catch { invalidate('clock-error'); throw new FinancialPolicyClientError('expired'); }
      if (currentTime >= value.expiresAt) { invalidate('observation-expired'); throw new FinancialPolicyClientError('expired'); }
      observation = value; now = nextNow;
    },
    observation: currentObservation,
    finish(ticket: Ticket) { if (active === ticket) active = null; ticket.controller.abort(); },
    invalidate,
    // Invoke synchronously on replacement; importantly this never clears denied.
    replaceAdapters() { invalidate('adapters-replaced'); adapterOwner = {}; return adapterOwner; },
    assertAdapters(owner: object) { if (owner !== adapterOwner) throw new FinancialPolicyClientError('scope'); },
    deny() { denied.add(financialPolicyBootstrapKey(bootstrap)); invalidate('denied'); },
    hide() { visible = false; invalidate('hidden'); },
    activate(next: FinancialPolicyBootstrap) {
      if (!alive) throw new FinancialPolicyClientError('scope');
      const parsed = freezeFinancial(financialParse(FinancialPolicyBootstrapSchema, next));
      invalidate('activated'); bootstrap = parsed; visible = true; permitted();
    },
    close() { alive = false; visible = false; invalidate('closed'); cleanups.clear(); },
  };
}
export type FinancialPolicyLifetime = ReturnType<typeof createFinancialPolicyLifetime>;
