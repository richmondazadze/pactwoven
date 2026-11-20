import { FinancialPolicyOriginalClosureLocatorSchema, type FinancialPolicyOriginalClosureLocator,
  type FinancialPolicyOriginalClosureRequest, type FinancialPolicyOriginalClosureResponse,
  type FinancialPolicyOriginalStatusResponse } from '@pactwoven/contracts';
import { FinancialPolicyOriginalStatusSchema, FinancialPolicyOriginalClosureIntentSchema,
  type FinancialPolicyClosures } from '@pactwoven/db';
import { DomainError, canonicalJson, financialAuthorityFenceHash, financialPolicyHttpRequestFromStoredCommand,
  financialPolicyHttpRequestHash, projectFinancialPolicyHttpReceipt } from '@pactwoven/domain';
import { createFinancialPolicyObservationSession, type FinancialPolicyObservationSession,
  type FinancialPolicyObservationSessionDependencies } from './financial-policy-observation-session.js';
import { financialPolicyClosureUnverified, snapshotFinancialPolicyClosureRequest,
  validateFinancialPolicyClosureResponse, validateFinancialPolicyOriginalStatusResponse } from './financial-worker-closure-result.js';

export type FinancialPolicyClosureGateway = {
  status(token: string, locator: FinancialPolicyOriginalClosureLocator): Promise<FinancialPolicyOriginalStatusResponse>;
  close(token: string, request: FinancialPolicyOriginalClosureRequest): Promise<FinancialPolicyOriginalClosureResponse>;
};
export type FinancialPolicyClosureGatewayDependencies = FinancialPolicyObservationSessionDependencies & {
  closures: { [K in keyof FinancialPolicyClosures]: (...args: Parameters<FinancialPolicyClosures[K]>) => Promise<unknown> };
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const denied = () => new DomainError('FINANCIAL_POLICY_ACCESS_DENIED', 403, 'Current scoped policy access is required.');
const changed = () => new DomainError('FINANCIAL_POLICY_SCOPE_CHANGED', 409, 'The policy scope changed. Refresh the review.');
const conflict = () => new DomainError('FINANCIAL_POLICY_KEY_CONFLICT', 409, 'Preserve the original policy request identity.');
/** Close only an exact unresolved original key; never save policy material or retry a write. */
export function createFinancialPolicyClosureGateway(dependencies: FinancialPolicyClosureGatewayDependencies): FinancialPolicyClosureGateway {
  const sessions = createFinancialPolicyObservationSession(dependencies), { wait, fresh, now } = sessions;
  const status = dependencies.closures.status.bind(dependencies.closures), close = dependencies.closures.close.bind(dependencies.closures);
  async function response(s: FinancialPolicyObservationSession, q: FinancialPolicyOriginalClosureLocator, raw: unknown) {
    const parsed = FinancialPolicyOriginalStatusSchema.safeParse(raw); if (!parsed.success) throw financialPolicyClosureUnverified();
    const value = parsed.data; let receipt = null;
    if (value.status === 'recorded') {
      const { command, result } = value.original, a = result.body.actor, scope = s.scope;
      if (result.environment !== scope.environment || result.organizationId !== scope.organizationId || result.actorId !== scope.actor.actorId ||
        a.actorId !== scope.actor.actorId || a.subject !== scope.actor.subject || a.externalMembershipId !== scope.actor.externalMembershipId)
        throw financialPolicyClosureUnverified();
      const hashScope = { environment: scope.environment, organizationId: scope.organizationId, actorId: scope.actor.actorId };
      const request = await wait(s, () => financialPolicyHttpRequestFromStoredCommand(hashScope, command));
      const hash = await wait(s, () => financialPolicyHttpRequestHash(hashScope, request));
      // Verify the genuine pair before classifying any locator mismatch as a conflict.
      receipt = await wait(s, () => projectFinancialPolicyHttpReceipt({ scope: hashScope, request, publicRequestHash: hash }, command, result));
      if (result.responsibilityId !== q.responsibilityId || result.kind !== q.kind || result.key !== q.key || result.body.id !== q.targetId ||
        hash !== q.publicRequestHash) throw conflict();
    }
    return wait(s, () => validateFinancialPolicyOriginalStatusResponse(q, { ...sessions.envelope(s), ...q,
      status: value.status, receipt, closure: value.closure }, now));
  }
  async function read(s: FinancialPolicyObservationSession, q: FinancialPolicyOriginalClosureLocator) {
    return response(s, q, await wait(s, () => status(s.evidenceId, structuredClone(s.scope), structuredClone(q))));
  }
  function checkStableIdentity(s: FinancialPolicyObservationSession, input: FinancialPolicyOriginalClosureRequest) {
    const e = input.expected, v = s.scope;
    if (e.environment !== v.environment || e.organizationId !== v.organizationId || e.actor.actorId !== v.actor.actorId) throw denied();
  }
  function checkExpected(s: FinancialPolicyObservationSession, input: FinancialPolicyOriginalClosureRequest) {
    const e = input.expected, v = s.scope;
    if (e.actor.membershipVersion !== v.actor.membershipVersion || e.organizationEpoch !== v.organizationEpoch) throw changed();
    if (e.draftScope && (!v.siteIds.includes(e.draftScope.site.id) || !v.actionSiteIds.includes(e.draftScope.site.id))) throw denied();
  }
  return {
    async status(token, locator) {
      const q = FinancialPolicyOriginalClosureLocatorSchema.parse(locator), s = await sessions.open(token, q.responsibilityId);
      return read(s, q);
    },
    async close(token, request) {
      const input = snapshotFinancialPolicyClosureRequest(request), q = input.locator;
      const s = await sessions.open(token, q.responsibilityId); checkStableIdentity(s, input);
      const before = await read(s, q);
      if (before.status !== 'not_recorded') return wait(s, () => validateFinancialPolicyClosureResponse(input, before, now));
      checkExpected(s, input);
      if (q.responsibilityId === null && !s.scope.roles.includes('owner')) throw denied();
      const d = input.expected.draftScope;
      const draftScope = d && { ...d, authority: { ...d.authority, environment: s.scope.environment, organizationId: s.scope.organizationId } };
      if (draftScope && draftScope.authorityHash !== await wait(s, () => financialAuthorityFenceHash(draftScope.authority))) throw changed();
      const intent = FinancialPolicyOriginalClosureIntentSchema.parse({ schemaVersion: 1, purpose: input.purpose, reason: input.reason,
        locator: q, expected: { organizationEpoch: input.expected.organizationEpoch, draftScope } });
      fresh(s);
      // SQL serializes this namespace with the original save. No acknowledgement loss causes another close.
      try {
        const acknowledged = await response(s, q, await wait(s, () => close(s.evidenceId, structuredClone(s.scope), structuredClone(intent))));
        if (acknowledged.status === 'not_recorded') throw financialPolicyClosureUnverified();
        const confirmed = await read(s, q);
        if (!same(acknowledged, confirmed)) throw financialPolicyClosureUnverified();
        return await wait(s, () => validateFinancialPolicyClosureResponse(input, confirmed, now));
      } catch { throw financialPolicyClosureUnverified(); }
    },
  };
}
