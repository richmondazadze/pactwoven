import { z } from 'zod';
import { EnvironmentSchema, FinancialPolicyRefSchema, FinancialPolicyPreparationRequestSchema, FinancialPolicyHttpAssetContextSchema,
  FinancialPolicyPreparationResponseSchema, FINANCE_DEVNET_ASSET, encodeSolanaBase58,
  type Environment, type FinancialPolicyPreparationRequest, type FinancialPolicyPreparationResponse,
  type FinancialPolicyPreparationMaterial, type FinancialPolicyPreparationTarget, type FinancialPolicyRead,
  type FinancialPolicyHttpBudgetObservation, type FinancialPolicyHttpDocumentView } from '@pactwoven/contracts';
import { FinancialIdentityEvidenceSchema, FinancialPolicyReaderScopeSchema, FinancialPolicyPreparationQuerySchema,
  FinancialPolicyPreparationSchema, type FinancialPolicyReadObservation, type FinancialPolicyReaderScope,
  type FinancialPolicyPreparationQuery } from '@pactwoven/db';
import { DomainError, canonicalJson, commandDigest, projectFinancialPolicyHttpView, financialPolicyTextHash,
  physicalAssetKey, financialBudgetAccountId, financialBudgetPeriodId, validateFinancialGovernanceBundle, provenanceBytes } from '@pactwoven/domain';
import { validateFinancialPolicyObservation, assertFinancialPolicyObservationFresh,
  type FinancialPolicyApiVerifier, type FinancialPolicyApiIdentityEvidence } from './financial-policy-verifier.js';

export type FinancialPolicyPreparationGateway = {
  prepare(token: string, responsibilityId: string | null, selection: FinancialPolicyPreparationRequest): Promise<FinancialPolicyPreparationResponse>;
};
export type FinancialPolicyPreparationGatewayDependencies = {
  environment: Environment; issuer: string; verifier: FinancialPolicyApiVerifier;
  readers: { resolveObserver(environment: Environment, observation: FinancialPolicyReadObservation): Promise<unknown> };
  authentication: { append(evidence: FinancialPolicyApiIdentityEvidence): Promise<unknown> };
  preparationReader: { prepare(evidenceId: string, scope: FinancialPolicyReaderScope, query: FinancialPolicyPreparationQuery): Promise<unknown> };
  now?: () => number;
};
const errors = {
  AUTH_REQUIRED: [401, 'Sign in again.'], SETUP_REQUIRED: [503, 'Financial-policy preparation is not configured.'],
  NOT_FOUND: [404, 'Resource not found.'],
  FINANCIAL_POLICY_INPUT_INVALID: [422, 'Use the exact supported policy preparation parameters.'],
  FINANCIAL_POLICY_ACCESS_DENIED: [403, 'Current scoped policy access is required.'],
  FINANCIAL_POLICY_SCOPE_CHANGED: [409, 'The policy scope changed. Refresh the review.'],
  FINANCIAL_POLICY_EXPIRED: [409, 'The policy observation expired.'],
  FINANCIAL_POLICY_UNAVAILABLE: [409, 'The complete policy review is unavailable.'],
  FINANCIAL_POLICY_OUTCOME_UNKNOWN: [503, 'The financial-policy preparation could not be verified.'],
  BODY_TOO_LARGE: [413, 'The policy preparation request exceeds its size limit.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Send uncompressed UTF-8 JSON.'],
  REQUEST_TIMEOUT: [408, 'The policy preparation request body did not arrive in time.'],
} as const;
export function safeFinancialPolicyPreparationApiError(error: unknown) {
  const code = error instanceof DomainError && Object.hasOwn(errors, error.code) ? error.code as keyof typeof errors : 'FINANCIAL_POLICY_OUTCOME_UNKNOWN';
  const [status, message] = errors[code]; return { code, status, message };
}
export const financialPolicyPreparationUnverified = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, errors.FINANCIAL_POLICY_OUTCOME_UNKNOWN[1]);
const invalid = () => new DomainError('FINANCIAL_POLICY_INPUT_INVALID', 422, errors.FINANCIAL_POLICY_INPUT_INVALID[1]);
const expired = () => new DomainError('FINANCIAL_POLICY_EXPIRED', 409, errors.FINANCIAL_POLICY_EXPIRED[1]);
const denied = () => new DomainError('FINANCIAL_POLICY_ACCESS_DENIED', 403, errors.FINANCIAL_POLICY_ACCESS_DENIED[1]);
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const clone = <T>(value: T): T => structuredClone(value);
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw financialPolicyPreparationUnverified(); return parsed.data;
}
export function snapshotFinancialPolicyPreparationSelection(responsibilityId: unknown, selection: unknown): FinancialPolicyPreparationQuery {
  const parsed = FinancialPolicyPreparationQuerySchema.safeParse({ responsibilityId, selection });
  if (!parsed.success) throw invalid(); return parsed.data;
}

/** Public consistency checks are not authentication. The private gateway supplies the evaluated decision. */
export async function validateFinancialPolicyPreparationResponse(responsibilityId: string | null,
  selection: FinancialPolicyPreparationRequest, input: unknown, now: () => number = Date.now): Promise<FinancialPolicyPreparationResponse> {
  const q = snapshotFinancialPolicyPreparationSelection(responsibilityId, selection), v = checked(FinancialPolicyPreparationResponseSchema, input);
  const fresh = () => {
    const at = now();
    if (!Number.isFinite(at) || Date.parse(v.observation.observedAt) > at || Date.parse(v.observation.expiresAt) <= at)
      throw financialPolicyPreparationUnverified();
  };
  fresh();
  if (v.responsibilityId !== q.responsibilityId || !equal(v.selection, q.selection)) throw financialPolicyPreparationUnverified();
  const documents: FinancialPolicyHttpDocumentView[] = [...v.target.historicalDocuments];
  if (v.target.state === 'exact' && v.target.record.record.kind === 'document') documents.push(v.target.record as FinancialPolicyHttpDocumentView);
  const m = v.material;
  if (m.action === 'save_draft' && m.document) documents.push(m.document);
  if (m.action === 'propose_governance') {
    if (m.budgetDocument) documents.push(m.budgetDocument);
    if (m.approvalDocument) documents.push(m.approvalDocument);
    if (m.asset) {
      const a = m.asset;
      if (a.genesis !== FINANCE_DEVNET_ASSET.genesis || a.tokenProgram !== FINANCE_DEVNET_ASSET.tokenProgram ||
        a.mint !== FINANCE_DEVNET_ASSET.mint || a.decimals !== 6 || a.policy !== 'solana-original-devnet-usdc-v1' ||
        a.pin.key !== await physicalAssetKey({ genesis: a.genesis, tokenProgram: a.tokenProgram, mint: a.mint }) ||
        m.budgetAccountId !== await financialBudgetAccountId(v.scope.environment, v.scope.organizationId, a.pin.key))
        throw financialPolicyPreparationUnverified();
      fresh();
      for (const p of m.periods) {
        if (p.id !== await financialBudgetPeriodId(m.budgetAccountId!, p.startsAt, p.endsAt)) throw financialPolicyPreparationUnverified(); fresh();
      }
    }
  }
  for (const d of documents) { if (d.record.contentHash !== await financialPolicyTextHash(d.record.text)) throw financialPolicyPreparationUnverified(); fresh(); }
  const scopes = [];
  if ((m.action === 'save_document' || m.action === 'save_draft') && m.draftScope) scopes.push(m.draftScope);
  if (v.target.state === 'exact' && v.target.record.record.kind === 'draft') scopes.push(v.target.record.record.draft.scope);
  for (const d of scopes) {
    if (d.authorityHash !== await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1',
      record: { ...d.authority, environment: v.scope.environment, organizationId: v.scope.organizationId } })) throw financialPolicyPreparationUnverified(); fresh();
  }
  const bundles = [];
  if (v.target.state === 'exact' && v.target.record.record.kind === 'governance') bundles.push(v.target.record.record.bundle);
  if (m.action === 'propose_governance' && m.acceptedConfiguration) bundles.push(m.acceptedConfiguration.record.bundle);
  for (const bundle of bundles) {
    try { await validateFinancialGovernanceBundle(v.scope.environment, v.scope.organizationId, bundle); }
    catch { throw financialPolicyPreparationUnverified(); }
    fresh();
  }
  fresh(); return v;
}
type Session = { observation: FinancialPolicyReadObservation; scope: FinancialPolicyReaderScope; evidenceId: string; observedAt: number; expiresAt: number };

/** Identity observation plus one coherent preparation read. No command, factor, pool or financial capability is accepted. */
export function createFinancialPolicyPreparationGateway(dependencies: FinancialPolicyPreparationGatewayDependencies): FinancialPolicyPreparationGateway {
  const environment = EnvironmentSchema.parse(dependencies.environment), issuer = z.string().url().max(512).parse(dependencies.issuer);
  const now = dependencies.now?.bind(dependencies) ?? Date.now;
  const observe = dependencies.verifier.observe.bind(dependencies.verifier), evidence = dependencies.verifier.identityEvidence.bind(dependencies.verifier);
  const resolve = dependencies.readers.resolveObserver.bind(dependencies.readers), append = dependencies.authentication.append.bind(dependencies.authentication);
  const prepare = dependencies.preparationReader.prepare.bind(dependencies.preparationReader);
  function fresh(s: Session) {
    const at = now(); assertFinancialPolicyObservationFresh(s.observation, s.scope, environment, at);
    if (s.observedAt > at || s.expiresAt <= at) throw expired();
  }
  async function wait<T>(s: Session, work: () => Promise<T>): Promise<T> { fresh(s); const result = await work(); fresh(s); return result; }
  async function session(token: string, rid: string | null): Promise<Session> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new DomainError('AUTH_REQUIRED', 401, errors.AUTH_REQUIRED[1]);
    const observation = validateFinancialPolicyObservation(await observe(token), token, issuer, now());
    assertFinancialPolicyObservationFresh(observation, null, environment, now());
    const scope = checked(FinancialPolicyReaderScopeSchema, await resolve(environment, clone(observation)));
    assertFinancialPolicyObservationFresh(observation, scope, environment, now());
    if (rid === null && !scope.roles.some(r => r === 'owner' || r === 'finance')) throw denied();
    const o = observation.observation, s: Session = { observation, scope, evidenceId: '', observedAt: Date.parse(o.observedAt),
      expiresAt: Math.min(Date.parse(o.expiresAt), Date.parse(o.observedAt) + 20_000) };
    fresh(s);
    const e = checked(FinancialIdentityEvidenceSchema, evidence(clone(observation), clone(scope)));
    if (e.environment !== environment || e.organizationId !== scope.organizationId || !equal(e.actor, scope.actor) ||
      e.externalOrganizationId !== scope.externalOrganizationId || e.externalRole !== observation.identity.externalRole || e.issuer !== issuer ||
      e.tokenHash !== o.tokenHash || e.tokenIssuedAt !== o.tokenIssuedAt || e.observedAt !== o.observedAt || e.sessionExpiresAt !== o.expiresAt ||
      e.expiresAt !== new Date(Math.min(Date.parse(o.expiresAt), Date.parse(o.observedAt) + 300_000)).toISOString()) throw financialPolicyPreparationUnverified();
    const hash = await wait(s, () => commandDigest({ namespace: 'pactwoven:financial-policy-evidence:v1', record: e }));
    const ref = checked(FinancialPolicyRefSchema, await wait(s, () => append(clone(e))));
    if (ref.id !== e.id || ref.version !== 1 || ref.recordHash !== hash) throw financialPolicyPreparationUnverified();
    s.evidenceId = e.id; return s;
  }
  async function view(s: Session, raw: FinancialPolicyRead, budget: FinancialPolicyHttpBudgetObservation | null = null) {
    return wait(s, () => projectFinancialPolicyHttpView({ environment, organizationId: s.scope.organizationId,
      responsibilityId: raw.record.responsibilityId, id: raw.record.id, version: raw.record.version }, raw, budget));
  }
  async function document(s: Session, raw: FinancialPolicyRead | null): Promise<FinancialPolicyHttpDocumentView | null> {
    if (raw === null) return null;
    const v = await view(s, raw); if (v.record.kind !== 'document') throw financialPolicyPreparationUnverified(); return v as FinancialPolicyHttpDocumentView;
  }
  function basis(d: NonNullable<Extract<FinancialPolicyPreparationMaterial, { action: 'save_draft' }>['draftScope']>) {
    const a = d.authority;
    return { authority: { schemaVersion: a.schemaVersion, responsibility: { id: a.responsibility.id, version: a.responsibility.version,
      hash: a.responsibility.hash, siteId: a.responsibility.siteId }, generation: a.generation, family: a.family,
      legacyHead: a.legacyHead && { mandateId: a.legacyHead.mandateId, mandateVersion: a.legacyHead.mandateVersion,
        mandateEpoch: a.legacyHead.mandateEpoch, hash: a.legacyHead.hash, state: a.legacyHead.state } }, authorityHash: d.authorityHash,
      site: { id: d.site.id, generation: d.site.generation, recordHash: d.site.recordHash } };
  }
  return {
    async prepare(token, responsibilityId, selection) {
      const q = snapshotFinancialPolicyPreparationSelection(responsibilityId, selection), s = await session(token, q.responsibilityId);
      const r = checked(FinancialPolicyPreparationSchema, await wait(s, () => prepare(s.evidenceId, clone(s.scope), clone(q))));
      const observed = Date.parse(r.observedAt), expiry = Date.parse(r.expiresAt), at = now();
      if (!equal(r.scope, s.scope) || r.responsibilityId !== q.responsibilityId || !equal(r.selection, q.selection) ||
        !Number.isFinite(at) || observed > at || expiry <= at || expiry > s.expiresAt) throw financialPolicyPreparationUnverified();
      // SQL observes material after identity checks; that later observation does not renew the identity's lifetime.
      s.observedAt = Math.min(s.observedAt, observed); s.expiresAt = Math.min(s.expiresAt, expiry, s.observedAt + 20_000); fresh(s);
      const t = r.target; let target: FinancialPolicyPreparationTarget;
      if (t.state === 'exact') {
        const raw = t.record.record, control = t.control;
        if (raw.kind === 'governance' && (control === null || raw.state === 'OPEN' && t.record.current !== equal(raw.expectedControl, control))) throw financialPolicyPreparationUnverified();
        const record = await view(s, t.record, raw.kind === 'governance' && control ? { status: 'observed', control,
          currentBudgetConfiguration: raw.state === 'ACCEPTED' && equal(t.latestReference, control.accepted) } : null);
        const historicalDocuments = [];
        for (const d of t.historicalDocuments) historicalDocuments.push((await document(s, d))!);
        target = { state: 'exact', latestReference: { id: t.latestReference.id, version: t.latestReference.version, recordHash: t.latestReference.recordHash }, record, historicalDocuments };
      } else if (t.state === 'changed') target = { state: 'changed', latestReference: { id: t.latestReference.id,
        version: t.latestReference.version, recordHash: t.latestReference.recordHash }, record: null, historicalDocuments: [] };
      else target = { state: t.state, latestReference: null, record: null, historicalDocuments: [] };
      const m = r.material; let material: FinancialPolicyPreparationMaterial;
      if (m.action === 'save_document') material = { action: m.action, purpose: m.purpose, organizationEpoch: m.organizationEpoch,
        draftScope: m.draftScope && basis(m.draftScope), siteActive: m.siteActive };
      else if (m.action === 'save_draft') material = { action: m.action, profile: 'incomplete', draftScope: m.draftScope && basis(m.draftScope),
        siteActive: m.siteActive, document: await document(s, m.document), asset: null, account: null, governance: null, trust: null };
      else if (m.action === 'withdraw_draft') material = { action: m.action };
      else {
        if (t.state === 'exact' && t.record.record.kind === 'governance' && t.record.record.bundle.budgetAccountId === m.budgetAccountId &&
          !equal(t.control, m.control)) throw financialPolicyPreparationUnverified();
        const a = m.asset, asset = a === null ? null : checked(FinancialPolicyHttpAssetContextSchema, { pin: { key: a.pin.key, version: a.pin.version, recordHash: a.pin.recordHash,
          financialUseEpoch: a.pin.financialUseEpoch }, genesis: encodeSolanaBase58(provenanceBytes(a.genesisHex)),
          tokenProgram: encodeSolanaBase58(provenanceBytes(a.tokenProgramHex)), mint: encodeSolanaBase58(provenanceBytes(a.mintHex)), decimals: a.decimals, policy: a.policy });
        const c = m.control, control = c && { budgetAccountId: c.budgetAccountId, generation: c.generation,
          accepted: c.accepted && { id: c.accepted.id, version: c.accepted.version, recordHash: c.accepted.recordHash } };
        const accepted = m.acceptedConfiguration && control ? await view(s, m.acceptedConfiguration,
          { status: 'observed', control, currentBudgetConfiguration: true }) : null;
        if (accepted && accepted.record.kind !== 'governance') throw financialPolicyPreparationUnverified();
        material = { action: m.action, asset, budgetAccountId: m.budgetAccountId, control,
          acceptedConfiguration: accepted as Extract<FinancialPolicyPreparationMaterial, { action: 'propose_governance' }>['acceptedConfiguration'],
          periods: m.periods.map(p => ({ id: p.id, startsAt: p.startsAt, endsAt: p.endsAt })),
          budgetDocument: await document(s, m.budgetDocument), approvalDocument: await document(s, m.approvalDocument),
          eligibleActionSites: m.eligibleActionSites.map(site => ({ id: site.id, generation: site.generation, recordHash: site.recordHash })) };
      }
      const v = s.scope;
      const wire = { schemaVersion: 1, scope: { environment: v.environment, organizationId: v.organizationId,
        actor: { actorId: v.actor.actorId, membershipVersion: v.actor.membershipVersion }, organizationEpoch: v.organizationEpoch,
        roles: [...v.roles].sort(), siteIds: [...v.siteIds], actionSiteIds: [...v.actionSiteIds] },
        observation: { observedAt: new Date(s.observedAt).toISOString(), expiresAt: new Date(s.expiresAt).toISOString() }, responsibilityId: q.responsibilityId,
        selection: FinancialPolicyPreparationRequestSchema.parse(q.selection), target, material,
        decision: { action: r.decision.action, state: r.decision.state, reasons: [...r.decision.reasons], requiredAuthentication: null },
        configurationWarnings: [...r.configurationWarnings], effectiveAuthority: false, financialState: null };
      return wait(s, () => validateFinancialPolicyPreparationResponse(q.responsibilityId, q.selection, wire, now));
    },
  };
}
