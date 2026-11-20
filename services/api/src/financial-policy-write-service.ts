import { z } from 'zod';
import { snapshotFinancialPolicyWriteRequest, validateFinancialPolicyWriteResponse } from './financial-worker-result.js';
export { snapshotFinancialPolicyWriteRequest, validateFinancialPolicyWriteResponse } from './financial-worker-result.js';
import { EnvironmentSchema, FinancialPolicyCommandSchema, FinancialPolicyResultSchema, FinancialPolicyRefSchema,
  FinancialPolicyHttpScopeSchema,
  type Environment, type FinancialPolicyCommand, type FinancialPolicyHttpRequest, type FinancialPolicyHttpMutationResponse } from '@pactwoven/contracts';
import { FinancialIdentityEvidenceSchema, FinancialPolicyReaderScopeSchema, FinancialPolicyOriginalSchema,
  type FinancialPolicyReadObservation, type FinancialPolicyReaderScope, type FinancialPolicyOriginalQuery } from '@pactwoven/db';
import { DomainError, canonicalJson, commandDigest, financialPolicyHttpRequestHash,
  financialPolicyHttpRequestFromStoredCommand, projectFinancialPolicyHttpReceipt } from '@pactwoven/domain';
import { assertFinancialPolicyObservationFresh, validateFinancialPolicyObservation,
  type FinancialPolicyApiVerifier, type FinancialPolicyApiIdentityEvidence } from './financial-policy-verifier.js';

export type FinancialPolicyWriteKind = 'save_document' | 'save_draft' | 'withdraw_draft' | 'propose_governance';
export type FinancialPolicyWriteRequest = Extract<FinancialPolicyHttpRequest, { kind: FinancialPolicyWriteKind }>;
type WriteCommand = Extract<FinancialPolicyCommand, { kind: FinancialPolicyWriteKind }>;
export type FinancialPolicyWriteGateway = { submit(token: string, request: FinancialPolicyWriteRequest): Promise<FinancialPolicyHttpMutationResponse> };
export type FinancialPolicyWriteGatewayDependencies = {
  environment: Environment; issuer: string; verifier: FinancialPolicyApiVerifier;
  readers: {
    resolveObserver(environment: Environment, observation: FinancialPolicyReadObservation): Promise<unknown>;
    original(evidenceId: string, scope: FinancialPolicyReaderScope, query: FinancialPolicyOriginalQuery): Promise<unknown>;
  };
  repository: { mutate(evidenceId: string, command: WriteCommand): Promise<unknown> };
  authentication: { append(evidence: FinancialPolicyApiIdentityEvidence): Promise<unknown> };
  now?: () => number;
};
const errors = {
  AUTH_REQUIRED: [401, 'Sign in again.'], SETUP_REQUIRED: [503, 'Financial-policy writes are not configured.'],
  NOT_FOUND: [404, 'Resource not found.'], BODY_TOO_LARGE: [413, 'The policy request exceeds its size limit.'],
  REQUEST_TIMEOUT: [408, 'The policy request body did not arrive in time.'], UNSUPPORTED_MEDIA_TYPE: [415, 'Send uncompressed UTF-8 JSON.'],
  FINANCIAL_POLICY_INPUT_INVALID: [422, 'Use the exact supported policy write parameters.'],
  FINANCIAL_POLICY_INVALID: [422, 'The reviewed financial-policy material is inconsistent.'],
  FINANCIAL_POLICY_ACCESS_DENIED: [403, 'Current scoped policy access is required.'],
  FINANCIAL_POLICY_SCOPE_CHANGED: [409, 'The policy scope changed. Refresh the review.'],
  FINANCIAL_POLICY_EXPIRED: [409, 'The policy observation or reviewed interval expired.'],
  FINANCIAL_POLICY_UNAVAILABLE: [409, 'The complete policy review is unavailable.'],
  FINANCIAL_POLICY_KEY_CONFLICT: [409, 'Preserve the original policy request identity.'],
  FINANCIAL_POLICY_OUTCOME_UNKNOWN: [503, 'The result is unconfirmed. Preserve the original key and request hash; use original-result lookup.'],
} as const;
export function safeFinancialPolicyWriteApiError(error: unknown) {
  const code = error instanceof DomainError && Object.hasOwn(errors, error.code) ? error.code as keyof typeof errors : 'FINANCIAL_POLICY_OUTCOME_UNKNOWN';
  const [status, message] = errors[code]; return { code, status, message };
}
export const financialPolicyWriteOutcomeUnknown = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, errors.FINANCIAL_POLICY_OUTCOME_UNKNOWN[1]);
const invalid = () => new DomainError('FINANCIAL_POLICY_INPUT_INVALID', 422, errors.FINANCIAL_POLICY_INPUT_INVALID[1]);
const denied = () => new DomainError('FINANCIAL_POLICY_ACCESS_DENIED', 403, errors.FINANCIAL_POLICY_ACCESS_DENIED[1]);
const expired = () => new DomainError('FINANCIAL_POLICY_EXPIRED', 409, errors.FINANCIAL_POLICY_EXPIRED[1]);
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const clone = <T>(input: T): T => structuredClone(input);
const allowed = (kind: string): kind is FinancialPolicyWriteKind => ['save_document', 'save_draft', 'withdraw_draft', 'propose_governance'].includes(kind);
function checked<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input); if (!parsed.success) throw financialPolicyWriteOutcomeUnknown(); return parsed.data;
}

type Session = { observation: FinancialPolicyReadObservation; scope: FinancialPolicyReaderScope; evidenceId: string };
/** Configuration-only writes through paired private capabilities; no automatic retry or consent surface. */
export function createFinancialPolicyWriteGateway(dependencies: FinancialPolicyWriteGatewayDependencies): FinancialPolicyWriteGateway {
  const environment = EnvironmentSchema.parse(dependencies.environment), issuer = z.string().url().max(512).parse(dependencies.issuer);
  const observe = dependencies.verifier.observe.bind(dependencies.verifier), evidence = dependencies.verifier.identityEvidence.bind(dependencies.verifier);
  const resolve = dependencies.readers.resolveObserver.bind(dependencies.readers), original = dependencies.readers.original.bind(dependencies.readers);
  const mutate = dependencies.repository.mutate.bind(dependencies.repository), append = dependencies.authentication.append.bind(dependencies.authentication);
  const now = dependencies.now?.bind(dependencies) ?? Date.now;
  const fresh = (s: Session) => assertFinancialPolicyObservationFresh(s.observation, s.scope, environment, now());
  async function wait<T>(s: Session, work: () => Promise<T>): Promise<T> { fresh(s); const result = await work(); fresh(s); return result; }
  async function session(token: string, responsibilityId: string | null): Promise<Session> {
    const observation = validateFinancialPolicyObservation(await observe(token), token, issuer, now());
    assertFinancialPolicyObservationFresh(observation, null, environment, now());
    const scope = checked(FinancialPolicyReaderScopeSchema, await resolve(environment, clone(observation)));
    assertFinancialPolicyObservationFresh(observation, scope, environment, now());
    // An existing receipt is readable by owner/finance; new organization writes require owner below.
    if (responsibilityId === null && !scope.roles.some(role => role === 'owner' || role === 'finance')) throw denied();
    const s = { observation, scope, evidenceId: '' }, o = observation.observation;
    const e = checked(FinancialIdentityEvidenceSchema, evidence(clone(observation), clone(scope)));
    if (e.environment !== environment || e.organizationId !== scope.organizationId || !equal(e.actor, scope.actor) ||
      e.externalOrganizationId !== scope.externalOrganizationId || e.externalRole !== observation.identity.externalRole || e.issuer !== issuer ||
      e.tokenHash !== o.tokenHash || e.tokenIssuedAt !== o.tokenIssuedAt || e.observedAt !== o.observedAt || e.sessionExpiresAt !== o.expiresAt ||
      e.expiresAt !== new Date(Math.min(Date.parse(o.expiresAt), Date.parse(o.observedAt) + 300_000)).toISOString()) throw financialPolicyWriteOutcomeUnknown();
    const hash = await wait(s, () => commandDigest({ namespace: 'pactwoven:financial-policy-evidence:v1', record: e }));
    const reference = checked(FinancialPolicyRefSchema, await wait(s, () => append(clone(e))));
    if (reference.id !== e.id || reference.version !== 1 || reference.recordHash !== hash) throw financialPolicyWriteOutcomeUnknown();
    s.evidenceId = e.id; return s;
  }
  const hashScope = (s: Session) => ({ environment, organizationId: s.scope.organizationId, actorId: s.scope.actor.actorId });
  const locator = (r: FinancialPolicyWriteRequest): FinancialPolicyOriginalQuery => ({ responsibilityId: r.responsibilityId, kind: r.kind, key: r.key, targetId: r.id });
  function binding(s: Session, request: FinancialPolicyWriteRequest, result: z.infer<typeof FinancialPolicyResultSchema>) {
    const a = result.body.actor;
    if (result.environment !== environment || result.organizationId !== s.scope.organizationId || result.responsibilityId !== request.responsibilityId ||
      result.kind !== request.kind || result.key !== request.key || result.body.id !== request.id || result.actorId !== s.scope.actor.actorId ||
      a.actorId !== s.scope.actor.actorId || a.subject !== s.scope.actor.subject || a.externalMembershipId !== s.scope.actor.externalMembershipId) throw financialPolicyWriteOutcomeUnknown();
  }
  async function stored(s: Session, request: FinancialPolicyWriteRequest, hash: string, raw: unknown) {
    const pair = checked(FinancialPolicyOriginalSchema, raw); binding(s, request, pair.result);
    const storedRequest = await wait(s, () => financialPolicyHttpRequestFromStoredCommand(hashScope(s), pair.command));
    const storedHash = await wait(s, () => financialPolicyHttpRequestHash(hashScope(s), storedRequest));
    // Verify internal command/result consistency before classifying different visible material as a key conflict.
    const receipt = await wait(s, () => projectFinancialPolicyHttpReceipt({ scope: hashScope(s), request: storedRequest, publicRequestHash: storedHash }, pair.command, pair.result));
    if (hash !== storedHash || !equal(request, storedRequest)) throw new DomainError('FINANCIAL_POLICY_KEY_CONFLICT', 409, errors.FINANCIAL_POLICY_KEY_CONFLICT[1]);
    return { pair, receipt };
  }
  function command(s: Session, request: FinancialPolicyWriteRequest): WriteCommand {
    const base = { schemaVersion: 1 as const, environment, organizationId: s.scope.organizationId, responsibilityId: request.responsibilityId,
      id: request.id, key: request.key, previous: request.input.previous, organizationEpoch: request.input.organizationEpoch };
    let input: unknown;
    switch (request.kind) {
      case 'save_document': input = { ...base, kind: request.kind, purpose: request.input.purpose, text: request.input.text }; break;
      case 'withdraw_draft': input = { ...base, kind: request.kind }; break;
      case 'save_draft': {
        const d = request.input.draft;
        input = { ...base, kind: request.kind, draft: { ...d, scope: { ...d.scope,
          authority: { ...d.scope.authority, environment, organizationId: s.scope.organizationId } } } }; break;
      }
      case 'propose_governance': input = { ...base, kind: request.kind, bundle: request.input.bundle,
        expectedControl: request.input.expectedControl, expiresAt: request.input.expiresAt }; break;
    }
    const parsed = FinancialPolicyCommandSchema.parse(input);
    if (!allowed(parsed.kind)) throw invalid(); return parsed as WriteCommand;
  }
  function newWrite(s: Session, request: FinancialPolicyWriteRequest) {
    fresh(s);
    if (request.responsibilityId === null && !s.scope.roles.includes('owner')) throw denied();
    if (request.input.organizationEpoch !== s.scope.organizationEpoch) throw new DomainError('FINANCIAL_POLICY_SCOPE_CHANGED', 409, errors.FINANCIAL_POLICY_SCOPE_CHANGED[1]);
    const sites = request.kind === 'save_draft' ? [request.input.draft.scope.site.id] : request.kind === 'propose_governance' ? request.input.bundle.approval.actionSiteIds : [];
    if (sites.some(site => !s.scope.siteIds.includes(site) || !s.scope.actionSiteIds.includes(site))) throw denied();
    const expiresAt = request.kind === 'save_draft' ? request.input.draft.expiresAt : request.kind === 'propose_governance' ? request.input.expiresAt : null;
    if (expiresAt !== null && Date.parse(expiresAt) <= now()) throw expired();
    // Responsibility site/author/predecessor and all current material are rechecked under the existing SQL locks.
  }
  async function response(s: Session, request: FinancialPolicyWriteRequest, receipt: Awaited<ReturnType<typeof projectFinancialPolicyHttpReceipt>>) {
    fresh(s); const v = s.scope, o = s.observation.observation;
    const wire = { schemaVersion: 1, scope: checked(FinancialPolicyHttpScopeSchema, { environment, organizationId: v.organizationId,
      actor: { actorId: v.actor.actorId, membershipVersion: v.actor.membershipVersion }, organizationEpoch: v.organizationEpoch,
      roles: [...v.roles].sort(), siteIds: [...v.siteIds], actionSiteIds: [...v.actionSiteIds] }),
      observation: { observedAt: o.observedAt, expiresAt: new Date(Math.min(Date.parse(o.expiresAt), Date.parse(o.observedAt) + 20_000)).toISOString() },
      status: 'recorded', receipt, effectiveAuthority: false, financialState: null };
    return wait(s, () => validateFinancialPolicyWriteResponse(request, wire));
  }
  return {
    async submit(token, input) {
      const request = snapshotFinancialPolicyWriteRequest(input), s = await session(token, request.responsibilityId);
      const hash = await wait(s, () => financialPolicyHttpRequestHash(hashScope(s), request));
      const before = await wait(s, () => original(s.evidenceId, clone(s.scope), locator(request)));
      if (before !== null) return response(s, request, (await stored(s, request, hash, before)).receipt);
      newWrite(s, request);
      const submitted = command(s, request), roundTrip = await wait(s, () => financialPolicyHttpRequestFromStoredCommand(hashScope(s), submitted));
      if (!equal(request, roundTrip) || hash !== await wait(s, () => financialPolicyHttpRequestHash(hashScope(s), roundTrip))) throw financialPolicyWriteOutcomeUnknown();
      fresh(s);
      // From invocation onward, a failure cannot prove no durable result exists. Never repeat the write.
      try {
        const acknowledged = checked(FinancialPolicyResultSchema, await wait(s, () => mutate(s.evidenceId, clone(submitted))));
        binding(s, request, acknowledged);
        await wait(s, () => projectFinancialPolicyHttpReceipt({ scope: hashScope(s), request, publicRequestHash: hash }, submitted, acknowledged));
        const confirmation = await wait(s, () => original(s.evidenceId, clone(s.scope), locator(request)));
        if (confirmation === null) throw financialPolicyWriteOutcomeUnknown();
        const verified = await stored(s, request, hash, confirmation);
        if (!equal(verified.pair.command, submitted) || !equal(verified.pair.result, acknowledged)) throw financialPolicyWriteOutcomeUnknown();
        return await response(s, request, verified.receipt);
      } catch { throw financialPolicyWriteOutcomeUnknown(); }
    },
  };
}
