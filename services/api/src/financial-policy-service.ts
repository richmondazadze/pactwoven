import { z } from 'zod';
import { EnvironmentSchema, IdSchema, HashSchema, FinancialPolicyVersionSchema, FinancialPolicyRefSchema,
  FinancialPolicyReadSchema, FinancialPolicyPageSchema, FinancialPolicyHttpContextSchema, FinancialPolicyHttpScopeSchema,
  FinancialPolicyHttpRecordResponseSchema, FinancialPolicyHttpDraftIndexResponseSchema, FinancialPolicyHttpGovernanceIndexResponseSchema,
  FinancialPolicyHttpRecoveryLocatorSchema, FinancialPolicyHttpRecoveryResponseSchema, FinancialPolicyHttpAssetContextSchema,
  FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES, encodeSolanaBase58,
  type Environment, type FinancialPolicyReadQuery, type FinancialPolicyListQuery, type FinancialPolicyRead,
  type FinancialPolicyHttpPolicyView, type FinancialPolicyHttpBudgetObservation, type FinancialPolicyHttpContext,
  type FinancialPolicyHttpRecordResponse, type FinancialPolicyHttpDraftIndexResponse, type FinancialPolicyHttpGovernanceIndexResponse,
  type FinancialPolicyHttpRecoveryLocator, type FinancialPolicyHttpRecoveryResponse } from '@pactwoven/contracts';
import { FinancialIdentityEvidenceSchema, FinancialPolicyReaderScopeSchema, FinancialPolicyContextSchema,
  FinancialGovernanceIndexQuerySchema, FinancialGovernanceIndexSchema, FinancialPolicyOriginalSchema,
  type FinancialPolicyReadObservation, type FinancialPolicyReaderScope, type FinancialPolicyContextQuery,
  type FinancialGovernanceIndexQuery, type FinancialPolicyOriginalQuery } from '@pactwoven/db';
import { DomainError, canonicalJson, commandDigest, projectFinancialPolicyHttpView, projectFinancialPolicyHttpReceipt,
  financialPolicyHttpRequestFromStoredCommand, financialPolicyHttpRequestHash, financialBudgetAccountId,
  financialBudgetPeriodId, physicalAssetKey, provenanceBytes } from '@pactwoven/domain';
import { assertFinancialPolicyObservationFresh, validateFinancialPolicyObservation,
  type FinancialPolicyApiVerifier, type FinancialPolicyApiIdentityEvidence } from './financial-policy-verifier.js';

export const FinancialPolicyApiRecordSelectorSchema = z.strictObject({ responsibilityId: IdSchema.nullable(), id: IdSchema,
  version: FinancialPolicyVersionSchema, kind: z.enum(['document', 'draft', 'governance']) }).refine(v =>
  v.kind === 'document' || (v.kind === 'draft') === (v.responsibilityId !== null));
export type FinancialPolicyApiRecordSelector = z.infer<typeof FinancialPolicyApiRecordSelectorSchema>;
export type FinancialPolicyGateway = {
  context(token: string, responsibilityId: string | null, assetKey: string | null): Promise<FinancialPolicyHttpContext>;
  index(token: string, responsibilityId: string | null, query: FinancialGovernanceIndexQuery): Promise<FinancialPolicyHttpDraftIndexResponse | FinancialPolicyHttpGovernanceIndexResponse>;
  get(token: string, selector: FinancialPolicyApiRecordSelector): Promise<FinancialPolicyHttpRecordResponse>;
  recover(token: string, locator: FinancialPolicyHttpRecoveryLocator): Promise<FinancialPolicyHttpRecoveryResponse>;
};
export type FinancialPolicyGatewayDependencies = {
  environment: Environment; issuer: string; verifier: FinancialPolicyApiVerifier;
  readers: {
    resolveObserver(environment: Environment, observation: FinancialPolicyReadObservation): Promise<unknown>;
    context(evidenceId: string, scope: FinancialPolicyReaderScope, query: FinancialPolicyContextQuery): Promise<unknown>;
    governance(evidenceId: string, scope: FinancialPolicyReaderScope, query: FinancialGovernanceIndexQuery): Promise<unknown>;
    original(evidenceId: string, scope: FinancialPolicyReaderScope, query: FinancialPolicyOriginalQuery): Promise<unknown>;
  };
  repository: {
    readFinancialPolicy(evidenceId: string, query: FinancialPolicyReadQuery): Promise<unknown>;
    listFinancialPolicyDrafts(evidenceId: string, query: FinancialPolicyListQuery): Promise<unknown>;
  };
  authentication: { append(evidence: FinancialPolicyApiIdentityEvidence): Promise<unknown> };
  now?: () => number;
};
const unknown = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'The financial-policy response could not be verified.');
const denied = () => new DomainError('FINANCIAL_POLICY_ACCESS_DENIED', 403, 'Current scoped policy access is required.');
const expired = () => new DomainError('FINANCIAL_POLICY_EXPIRED', 409, 'The policy observation expired.');
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const clone = <T>(value: T): T => structuredClone(value);
const full = (scope: FinancialPolicyReaderScope) => scope.roles.some(role => role === 'owner' || role === 'finance');
function checked<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input); if (!parsed.success) throw unknown(); return parsed.data;
}
export function validateFinancialPolicyWire<T>(schema: z.ZodType<T>, input: unknown): T {
  const v = checked(schema, input);
  if (new TextEncoder().encode(JSON.stringify(v)).byteLength > FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES) throw unknown();
  return v;
}
const errors = {
  AUTH_REQUIRED: [401, 'Sign in again.'], SETUP_REQUIRED: [503, 'Financial-policy reads are not configured.'],
  NOT_FOUND: [404, 'Resource not found.'],
  FINANCIAL_POLICY_INPUT_INVALID: [422, 'Use the exact supported policy read parameters.'],
  FINANCIAL_POLICY_ACCESS_DENIED: [403, 'Current scoped policy access is required.'],
  FINANCIAL_POLICY_SCOPE_CHANGED: [409, 'The policy scope changed. Refresh the review.'],
  FINANCIAL_POLICY_EXPIRED: [409, 'The policy observation expired.'],
  FINANCIAL_POLICY_UNAVAILABLE: [409, 'The complete policy review is unavailable.'],
  FINANCIAL_POLICY_KEY_CONFLICT: [409, 'Preserve the original policy request identity.'],
  FINANCIAL_POLICY_OUTCOME_UNKNOWN: [503, 'The financial-policy response could not be verified.'],
} as const;
export function safeFinancialPolicyApiError(error: unknown) {
  const code = error instanceof DomainError && Object.hasOwn(errors, error.code) ? error.code as keyof typeof errors : 'FINANCIAL_POLICY_OUTCOME_UNKNOWN';
  const [status, message] = errors[code]; return { code, status, message };
}
type Session = { observation: FinancialPolicyReadObservation; scope: FinancialPolicyReaderScope; evidenceId: string;
  observedAt: number; expiresAt: number };

/** Paired private adapters only. This gateway contains no command, factor or financial-execution capability. */
export function createFinancialPolicyGateway(dependencies: FinancialPolicyGatewayDependencies): FinancialPolicyGateway {
  const environment = EnvironmentSchema.parse(dependencies.environment), issuer = z.string().url().max(512).parse(dependencies.issuer);
  const now = dependencies.now?.bind(dependencies) ?? Date.now;
  const observe = dependencies.verifier.observe.bind(dependencies.verifier), evidence = dependencies.verifier.identityEvidence.bind(dependencies.verifier);
  const resolve = dependencies.readers.resolveObserver.bind(dependencies.readers), readContext = dependencies.readers.context.bind(dependencies.readers);
  const governance = dependencies.readers.governance.bind(dependencies.readers), original = dependencies.readers.original.bind(dependencies.readers);
  const read = dependencies.repository.readFinancialPolicy.bind(dependencies.repository), list = dependencies.repository.listFinancialPolicyDrafts.bind(dependencies.repository);
  const append = dependencies.authentication.append.bind(dependencies.authentication);
  function fresh(s: Session) {
    const at = now(); assertFinancialPolicyObservationFresh(s.observation, s.scope, environment, at);
    if (s.observedAt > at || s.expiresAt <= at) throw expired();
  }
  async function wait<T>(s: Session, work: () => Promise<T>): Promise<T> {
    fresh(s); const result = await work(); fresh(s); return result;
  }
  async function session(token: string, responsibilityId: string | null): Promise<Session> {
    const observation = validateFinancialPolicyObservation(await observe(token), token, issuer, now());
    assertFinancialPolicyObservationFresh(observation, null, environment, now());
    const scope = checked(FinancialPolicyReaderScopeSchema, await resolve(environment, clone(observation)));
    assertFinancialPolicyObservationFresh(observation, scope, environment, now());
    // The old general readers also admit Operations; organization disclosure needs this explicit gate.
    if (responsibilityId === null && !full(scope)) throw denied();
    const s: Session = { observation, scope, evidenceId: '', observedAt: Date.parse(observation.observation.observedAt),
      expiresAt: Math.min(Date.parse(observation.observation.expiresAt), Date.parse(observation.observation.observedAt) + 20_000) };
    fresh(s);
    const e = checked(FinancialIdentityEvidenceSchema, evidence(clone(observation), clone(scope))), o = observation.observation;
    if (e.environment !== environment || e.organizationId !== scope.organizationId || !equal(e.actor, scope.actor) ||
      e.externalOrganizationId !== scope.externalOrganizationId || e.externalRole !== observation.identity.externalRole ||
      e.issuer !== issuer || e.tokenHash !== o.tokenHash || e.tokenIssuedAt !== o.tokenIssuedAt || e.observedAt !== o.observedAt ||
      e.sessionExpiresAt !== o.expiresAt || e.expiresAt !== new Date(Math.min(Date.parse(o.expiresAt), Date.parse(o.observedAt) + 300_000)).toISOString()) throw unknown();
    const hash = await wait(s, () => commandDigest({ namespace: 'pactwoven:financial-policy-evidence:v1', record: e }));
    const ref = checked(FinancialPolicyRefSchema, await wait(s, () => append(clone(e))));
    if (ref.id !== e.id || ref.version !== 1 || ref.recordHash !== hash) throw unknown();
    s.evidenceId = e.id; return s;
  }
  function envelope(s: Session) {
    fresh(s); const v = s.scope;
    return { schemaVersion: 1 as const, scope: checked(FinancialPolicyHttpScopeSchema, { environment: v.environment,
      organizationId: v.organizationId, actor: { actorId: v.actor.actorId, membershipVersion: v.actor.membershipVersion },
      organizationEpoch: v.organizationEpoch, roles: [...v.roles].sort(), siteIds: [...v.siteIds], actionSiteIds: [...v.actionSiteIds] }),
      observation: { observedAt: new Date(s.observedAt).toISOString(), expiresAt: new Date(Math.min(s.expiresAt, s.observedAt + 20_000)).toISOString() },
      effectiveAuthority: false as const, financialState: null };
  }
  const queryFor = (s: Session, responsibilityId: string | null, id: string, version: number | null): FinancialPolicyReadQuery =>
    ({ environment, organizationId: s.scope.organizationId, responsibilityId, id, version });
  async function view(s: Session, selector: FinancialPolicyReadQuery, value: unknown, budget: FinancialPolicyHttpBudgetObservation | null): Promise<FinancialPolicyHttpPolicyView> {
    const raw = checked(FinancialPolicyReadSchema, value);
    if (raw.record.kind === 'draft' && (!s.scope.siteIds.includes(raw.record.draft.scope.site.id) ||
      !s.scope.actionSiteIds.includes(raw.record.draft.scope.site.id))) throw denied();
    return wait(s, () => projectFinancialPolicyHttpView(selector, raw, budget));
  }
  async function context(s: Session, responsibilityId: string | null, assetKey: string | null): Promise<FinancialPolicyHttpContext> {
    const r = checked(FinancialPolicyContextSchema, await wait(s, () => readContext(s.evidenceId, clone(s.scope), { responsibilityId, assetKey, documents: [] })));
    const observed = Date.parse(r.observedAt), expiry = Date.parse(r.expiresAt), at = now();
    if (!equal(r.scope, s.scope) || r.responsibilityId !== responsibilityId || (r.draftScope === null) !== (responsibilityId === null) ||
      r.documents.length !== 0 || observed > at || expiry <= at || expiry <= observed || expiry > observed + 20_000) throw unknown();
    s.observedAt = Math.min(s.observedAt, observed); s.expiresAt = Math.min(s.expiresAt, expiry, s.observedAt + 20_000); fresh(s);
    const d = r.draftScope;
    if (d) {
      if (d.authority.environment !== environment || d.authority.organizationId !== s.scope.organizationId || d.authority.responsibility.id !== responsibilityId ||
        d.site.id !== d.authority.responsibility.siteId || !s.scope.siteIds.includes(d.site.id) || !s.scope.actionSiteIds.includes(d.site.id)) throw denied();
      if (d.authorityHash !== await wait(s, () => commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: d.authority }))) throw unknown();
    }
    if (r.configurationVisibility !== (full(s.scope) ? 'full' : 'references_only') ||
      !full(s.scope) && (r.acceptedConfiguration !== null || r.periods.length !== 0)) throw unknown();
    let asset = null;
    if (r.asset) {
      const a = r.asset;
      asset = checked(FinancialPolicyHttpAssetContextSchema, { pin: a.pin, genesis: encodeSolanaBase58(provenanceBytes(a.genesisHex)),
        tokenProgram: encodeSolanaBase58(provenanceBytes(a.tokenProgramHex)), mint: encodeSolanaBase58(provenanceBytes(a.mintHex)), decimals: a.decimals, policy: a.policy });
      if (a.pin.key !== assetKey || a.pin.key !== await wait(s, () => physicalAssetKey({ genesis: asset!.genesis, tokenProgram: asset!.tokenProgram, mint: asset!.mint })) ||
        r.control?.budgetAccountId !== await wait(s, () => financialBudgetAccountId(environment, s.scope.organizationId, a.pin.key))) throw unknown();
    } else if (!r.blockers.includes(assetKey === null ? 'ASSET_MISSING' : 'ASSET_CHANGED')) throw unknown();
    for (const p of r.periods) {
      if (!r.control || p.id !== await wait(s, () => financialBudgetPeriodId(r.control!.budgetAccountId, p.startsAt, p.endsAt))) throw unknown();
    }
    let acceptedConfiguration = null;
    if (r.acceptedConfiguration) {
      if (!r.control?.accepted) throw unknown();
      const ref = r.control.accepted;
      acceptedConfiguration = await view(s, queryFor(s, null, ref.id, ref.version), r.acceptedConfiguration,
        { status: 'observed', control: r.control, currentBudgetConfiguration: true });
    }
    const authority = d?.authority;
    return validateFinancialPolicyWire(FinancialPolicyHttpContextSchema, { ...envelope(s),
      kind: responsibilityId === null ? 'organization' : 'responsibility', responsibilityId, configurationVisibility: r.configurationVisibility,
      draftScope: d && authority ? { authority: { schemaVersion: authority.schemaVersion, responsibility: authority.responsibility,
        generation: authority.generation, family: authority.family, legacyHead: authority.legacyHead }, authorityHash: d.authorityHash, site: d.site } : null,
      asset, control: r.control, acceptedConfiguration, periods: r.periods, documents: [], blockers: [...new Set(r.blockers)].sort(), actions: [] });
  }
  function cursor(items: FinancialPolicyRead[], nextId: string | null, q: FinancialGovernanceIndexQuery) {
    if (items.length > q.limit || items.some((item, i) => i === 0 ? q.afterId !== null && item.record.id <= q.afterId : items[i - 1]!.record.id >= item.record.id) ||
      nextId !== null && (items.length !== q.limit || nextId !== items.at(-1)?.record.id)) throw unknown();
  }
  return {
    async context(token, responsibilityId, assetKey) {
      const rid = IdSchema.nullable().parse(responsibilityId), key = HashSchema.nullable().parse(assetKey);
      return context(await session(token, rid), rid, key);
    },
    async index(token, responsibilityId, query) {
      const rid = IdSchema.nullable().parse(responsibilityId), q = FinancialGovernanceIndexQuerySchema.parse(query), s = await session(token, rid);
      if (rid !== null) {
        await context(s, rid, null);
        const page = checked(FinancialPolicyPageSchema, await wait(s, () => list(s.evidenceId, { environment, organizationId: s.scope.organizationId, responsibilityId: rid, ...clone(q) })));
        cursor(page.items, page.nextId, q); const items = [];
        for (const item of page.items) items.push({ policy: await view(s, queryFor(s, rid, item.record.id, null), item, null), actions: [] });
        return validateFinancialPolicyWire(FinancialPolicyHttpDraftIndexResponseSchema, { ...envelope(s), kind: 'responsibility', responsibilityId: rid, items, nextId: page.nextId });
      }
      const page = checked(FinancialGovernanceIndexSchema, await wait(s, () => governance(s.evidenceId, clone(s.scope), clone(q))));
      cursor(page.items.map(item => item.policy), page.nextId, q); const items = [];
      for (const item of page.items) items.push({ policy: await view(s, queryFor(s, null, item.policy.record.id, null), item.policy,
        { status: 'observed', control: item.control, currentBudgetConfiguration: item.currentBudgetConfiguration }), actions: [] });
      return validateFinancialPolicyWire(FinancialPolicyHttpGovernanceIndexResponseSchema, { ...envelope(s), kind: 'organization', responsibilityId: null, items, nextId: page.nextId });
    },
    async get(token, selector) {
      const selected = FinancialPolicyApiRecordSelectorSchema.parse(selector), s = await session(token, selected.responsibilityId);
      if (selected.responsibilityId !== null) await context(s, selected.responsibilityId, null);
      const q = queryFor(s, selected.responsibilityId, selected.id, selected.version), raw = await wait(s, () => read(s.evidenceId, clone(q)));
      if (raw === null) throw new DomainError('NOT_FOUND', 404, 'Resource not found.');
      const policy = await view(s, q, raw, selected.kind === 'governance' ? { status: 'unavailable', control: null, currentBudgetConfiguration: null } : null);
      if (policy.record.kind !== selected.kind) throw unknown();
      const refs = policy.record.kind === 'draft' ? policy.record.draft.documents : policy.record.kind === 'governance' ? policy.record.bundle.documents : [];
      const documents = [];
      for (const ref of refs) {
        const documentQuery = queryFor(s, ref.purpose === 'financial_mandate' ? selected.responsibilityId : null, ref.id, ref.version);
        if (documentQuery.responsibilityId === null && !full(s.scope)) throw denied();
        const rawDocument = await wait(s, () => read(s.evidenceId, clone(documentQuery)));
        if (rawDocument === null) throw new DomainError('FINANCIAL_POLICY_UNAVAILABLE', 409, 'The complete policy review is unavailable.');
        const document = await view(s, documentQuery, rawDocument, null);
        if (document.record.kind !== 'document' || document.record.purpose !== ref.purpose ||
          !equal(document.reference, { id: ref.id, version: ref.version, recordHash: ref.recordHash })) throw unknown();
        documents.push(document);
      }
      return validateFinancialPolicyWire(FinancialPolicyHttpRecordResponseSchema, { ...envelope(s), responsibilityId: selected.responsibilityId, policy, documents, actions: [] });
    },
    async recover(token, locator) {
      const q = FinancialPolicyHttpRecoveryLocatorSchema.parse(locator), s = await session(token, q.responsibilityId);
      // This paired private reader rechecks current actor and responsibility sites within the original lookup.
      const raw = await wait(s, () => original(s.evidenceId, clone(s.scope), { responsibilityId: q.responsibilityId, kind: q.kind, key: q.key, targetId: q.targetId }));
      if (raw === null) return validateFinancialPolicyWire(FinancialPolicyHttpRecoveryResponseSchema, { ...envelope(s), ...q, status: 'not_recorded', receipt: null });
      const pair = checked(FinancialPolicyOriginalSchema, raw), r = pair.result, a = r.body.actor;
      if (r.environment !== environment || r.organizationId !== s.scope.organizationId || r.responsibilityId !== q.responsibilityId ||
        r.kind !== q.kind || r.key !== q.key || r.body.id !== q.targetId || a.actorId !== s.scope.actor.actorId ||
        a.subject !== s.scope.actor.subject || a.externalMembershipId !== s.scope.actor.externalMembershipId) throw unknown();
      const originalScope = { environment, organizationId: s.scope.organizationId, actorId: s.scope.actor.actorId };
      const request = await wait(s, () => financialPolicyHttpRequestFromStoredCommand(originalScope, pair.command));
      if (q.publicRequestHash !== await wait(s, () => financialPolicyHttpRequestHash(originalScope, request))) throw unknown();
      const receipt = await wait(s, () => projectFinancialPolicyHttpReceipt({ scope: originalScope, request, publicRequestHash: q.publicRequestHash }, pair.command, pair.result));
      return validateFinancialPolicyWire(FinancialPolicyHttpRecoveryResponseSchema, { ...envelope(s), ...q, status: 'recorded', receipt });
    },
  };
}
