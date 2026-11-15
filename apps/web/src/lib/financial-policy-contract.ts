import { z } from 'zod';
import { EnvironmentSchema, IdSchema, HashSchema, FinancialPolicyVersionSchema,
  FinancialPolicyHttpRequestSchema, FinancialPolicyHttpRecoveryLocatorSchema, FinancialPolicyHttpReceiptSchema,
  FinancialPolicyHttpRecordResponseSchema, FinancialPolicyHttpDraftIndexResponseSchema,
  FinancialPolicyHttpGovernanceIndexResponseSchema, FinancialPolicyHttpRecoveryResponseSchema,
  FinancialPolicyHttpScopeSchema, financialPolicyHttpRoute, type FinancialPolicyHttpRequest,
  FinancialPolicyHttpDraftSchema, FinancialPolicyHttpRecordSchema,
  FinancialPolicyHttpContextSchema, type FinancialPolicyHttpContext,
  type FinancialPolicyHttpScope, type FinancialPolicyHttpRecord, type FinancialPolicyHttpDraft,
  type FinancialGovernanceBundle, type FinancialPolicyHttpReceipt } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from '@pactwoven/contracts/canonical';

export class FinancialPolicyClientError extends Error {
  constructor(readonly code: 'input' | 'scope' | 'expired' | 'unconfirmed' | 'storage' | 'unavailable' | 'not-found') {
    super({ input: 'Exact financial-policy material is required.', scope: 'Current financial-policy access must be checked again.',
      expired: 'The financial-policy observation expired. Refresh explicitly.',
      unconfirmed: 'The financial-policy result could not be confirmed. Preserve the original reference.',
      storage: 'This tab could not safely retain or clear the original reference.',
      unavailable: 'Financial-policy access is temporarily unavailable.',
      'not-found': 'No record was found at this check. The original request remains unresolved.' }[code]);
  }
}
export function financialParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new FinancialPolicyClientError('input');
  return result.data;
}
export function freezeFinancial<T>(value: T): T {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) freezeFinancial(entry); Object.freeze(value); }
  return value;
}
export const financialSame = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const ApiBaseSchema = z.string().max(2048).refine(value => {
  try { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash &&
    (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) &&
    value === u.origin + u.pathname.replace(/\/$/, ''); } catch { return false; }
});
export const FinancialPolicyLocalScopeSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema,
  actorId: IdSchema, apiBase: ApiBaseSchema, responsibilityId: IdSchema.nullable() });
export type FinancialPolicyLocalScope = z.infer<typeof FinancialPolicyLocalScopeSchema>;
export const FinancialPolicyReferenceSchema = z.strictObject({ schemaVersion: z.literal(1),
  scope: FinancialPolicyLocalScopeSchema, locator: FinancialPolicyHttpRecoveryLocatorSchema,
}).refine(v => v.scope.responsibilityId === v.locator.responsibilityId);
export type FinancialPolicyReference = z.infer<typeof FinancialPolicyReferenceSchema>;
const HashScopeSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema });
const AttemptSchema = z.strictObject({ reference: FinancialPolicyReferenceSchema, request: FinancialPolicyHttpRequestSchema });
export type FinancialPolicyAttempt = z.infer<typeof AttemptSchema>;
export const FinancialPolicyReadTargetSchema = z.strictObject({ kind: z.enum(['document', 'draft', 'governance']),
  responsibilityId: IdSchema.nullable(), id: IdSchema, version: FinancialPolicyVersionSchema, recordHash: HashSchema.nullable(),
}).refine(v => {
  try { financialPolicyHttpRoute({ kind: v.kind === 'document' ? 'save_document' : v.kind === 'draft' ? 'save_draft' : 'propose_governance',
    responsibilityId: v.responsibilityId, id: v.id }); return true; } catch { return false; }
});
export type FinancialPolicyReadTarget = z.infer<typeof FinancialPolicyReadTargetSchema>;
export const FinancialPolicyIndexQuerySchema = z.strictObject({ responsibilityId: IdSchema.nullable(), afterId: IdSchema.nullable(),
  limit: z.number().int().min(1).max(50) });
export type FinancialPolicyIndexQuery = z.infer<typeof FinancialPolicyIndexQuerySchema>;

// These are public material namespaces frozen by HTTP0, never private command,
// evidence, record or MFA hashes. No domain/persistence module enters the browser.
async function budgetId(environment: string, organizationId: string, assetKey: string) {
  return commandDigest({ namespace: 'pactwoven:financial-budget-account:v1', environment, organizationId, assetKey, category: 'supplier_principal' });
}
async function bundleMaterial(scope: { environment: string; organizationId: string }, bundle: FinancialGovernanceBundle) {
  if (bundle.budgetAccountId !== await budgetId(scope.environment, scope.organizationId, bundle.asset.key) ||
    bundle.period.id !== await commandDigest({ namespace: 'pactwoven:financial-budget-period:v1', budgetAccountId: bundle.budgetAccountId,
      startsAt: bundle.period.startsAt, endsAt: bundle.period.endsAt })) throw new FinancialPolicyClientError('input');
}
export async function qualifyFinancialDraftBasis(scopeInput: { environment: string; organizationId: string }, basisInput: FinancialPolicyHttpDraft['scope']) {
  const scope = freezeFinancial({ environment: financialParse(EnvironmentSchema, scopeInput.environment), organizationId: financialParse(IdSchema, scopeInput.organizationId) });
  const basis = freezeFinancial(financialParse(FinancialPolicyHttpDraftSchema.shape.scope, basisInput));
  if (basis.authorityHash !== await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1',
    record: { ...basis.authority, environment: scope.environment, organizationId: scope.organizationId } })) throw new FinancialPolicyClientError('input');
}
async function draftMaterial(scope: { environment: string; organizationId: string }, draft: FinancialPolicyHttpDraft) {
  await qualifyFinancialDraftBasis(scope, draft.scope);
  if (draft.governance && draft.asset && draft.governance.budgetAccountId !==
    await budgetId(scope.environment, scope.organizationId, draft.asset.key)) throw new FinancialPolicyClientError('input');
}
export async function qualifyFinancialRecordMaterial(input: FinancialPolicyHttpRecord): Promise<void> {
  const record = freezeFinancial(financialParse(FinancialPolicyHttpRecordSchema, input));
  if (record.kind === 'document') {
    if (record.contentHash !== await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text: record.text }))
      throw new FinancialPolicyClientError('input');
  } else if (record.kind === 'draft') await draftMaterial(record, record.draft);
  else await bundleMaterial(record, record.bundle);
}
export async function qualifyFinancialContextMaterial(input: FinancialPolicyHttpContext): Promise<void> {
  const context = freezeFinancial(financialParse(FinancialPolicyHttpContextSchema, input)), scope = context.scope;
  if (context.draftScope) await qualifyFinancialDraftBasis(scope, context.draftScope);
  if (context.asset && context.control) {
    if (context.control.budgetAccountId !== await budgetId(scope.environment, scope.organizationId, context.asset.pin.key)) throw new FinancialPolicyClientError('input');
    for (const period of context.periods) if (period.id !== await commandDigest({ namespace: 'pactwoven:financial-budget-period:v1',
      budgetAccountId: context.control.budgetAccountId, startsAt: period.startsAt, endsAt: period.endsAt })) throw new FinancialPolicyClientError('input');
  }
  if (context.acceptedConfiguration) await qualifyFinancialRecordMaterial(context.acceptedConfiguration.record);
  for (const document of context.documents) await qualifyFinancialRecordMaterial(document.record);
}
export async function financialPolicyPublicRequestHash(scopeInput: unknown, input: unknown): Promise<string> {
  const scope = freezeFinancial(financialParse(HashScopeSchema, scopeInput));
  const request = freezeFinancial(financialParse(FinancialPolicyHttpRequestSchema, input));
  if (request.kind === 'save_draft') await draftMaterial(scope, request.input.draft);
  if (request.kind === 'propose_governance') await bundleMaterial(scope, request.input.bundle);
  return commandDigest({ namespace: 'pactwoven:financial-policy-http-request:v1', ...scope,
    kind: request.kind, route: request.route, key: request.key, input: request.input });
}
/** Retains visible reviewed intent only; this provides no submit or retry capability. */
export async function createFinancialPolicyAttempt(scopeInput: unknown, input: unknown): Promise<FinancialPolicyAttempt> {
  const scope = freezeFinancial(financialParse(FinancialPolicyLocalScopeSchema, scopeInput));
  const request = freezeFinancial(financialParse(FinancialPolicyHttpRequestSchema, input));
  if (scope.responsibilityId !== request.responsibilityId) throw new FinancialPolicyClientError('input');
  const publicRequestHash = await financialPolicyPublicRequestHash({ environment: scope.environment, organizationId: scope.organizationId,
    actorId: scope.actorId }, request);
  return freezeFinancial({ reference: { schemaVersion: 1, scope, locator: { responsibilityId: request.responsibilityId,
    kind: request.kind, key: request.key, targetId: request.id, publicRequestHash } }, request });
}
export async function verifyFinancialPolicyAttempt(input: unknown): Promise<FinancialPolicyAttempt> {
  const attempt = freezeFinancial(financialParse(AttemptSchema, input));
  const expected = await createFinancialPolicyAttempt(attempt.reference.scope, attempt.request);
  if (!financialSame(attempt, expected)) throw new FinancialPolicyClientError('input');
  return attempt;
}
export function matchFinancialScope(input: unknown, expected: FinancialPolicyHttpScope) {
  const scope = financialParse(FinancialPolicyHttpScopeSchema, input);
  if (!financialSame(scope, expected)) throw new FinancialPolicyClientError('scope');
}
export async function qualifyFinancialReceipt(input: unknown, referenceInput: unknown, originalInput?: FinancialPolicyAttempt) {
  const receipt = freezeFinancial(financialParse(FinancialPolicyHttpReceiptSchema, input));
  const reference = freezeFinancial(financialParse(FinancialPolicyReferenceSchema, referenceInput));
  const original = originalInput === undefined ? undefined : freezeFinancial(financialParse(AttemptSchema, originalInput));
  const { scope, locator: l } = reference;
  // Receipt membership is historical. Only the original actor ID is compared to
  // today's viewer; the record and receipt still require their own exact version.
  if (receipt.environment !== scope.environment || receipt.organizationId !== scope.organizationId || receipt.actor.actorId !== scope.actorId ||
    receipt.responsibilityId !== l.responsibilityId || receipt.kind !== l.kind || receipt.key !== l.key ||
    receipt.publicRequestHash !== l.publicRequestHash || receipt.target.id !== l.targetId) throw new FinancialPolicyClientError('unconfirmed');
  await qualifyFinancialRecordMaterial(receipt.record);
  if (original) {
    await verifyFinancialPolicyAttempt(original);
    if (!financialSame(original.reference, reference)) throw new FinancialPolicyClientError('unconfirmed');
    const r = receipt.record, request = original.request, previous = request.input.previous;
    if (!financialSame(r.predecessor, previous) || r.version !== (previous?.version ?? 0) + 1 ||
      r.organizationEpoch !== request.input.organizationEpoch) throw new FinancialPolicyClientError('unconfirmed');
    if (request.kind === 'save_document' && (r.kind !== 'document' || r.text !== request.input.text || r.purpose !== request.input.purpose) ||
      request.kind === 'save_draft' && (r.kind !== 'draft' || !financialSame(r.draft, request.input.draft)) ||
      request.kind === 'propose_governance' && (r.kind !== 'governance' || !financialSame(r.bundle, request.input.bundle) || r.expiresAt !== request.input.expiresAt) ||
      'expectedControl' in request.input && (r.kind !== 'governance' || !financialSame(r.expectedControl, request.input.expectedControl)))
      throw new FinancialPolicyClientError('unconfirmed');
  }
  return receipt;
}
export async function qualifyFinancialRead(input: unknown, scopeInput: FinancialPolicyHttpScope, targetInput: FinancialPolicyReadTarget) {
  const value = freezeFinancial(financialParse(FinancialPolicyHttpRecordResponseSchema, input));
  const scope = freezeFinancial(financialParse(FinancialPolicyHttpScopeSchema, scopeInput));
  const target = freezeFinancial(financialParse(FinancialPolicyReadTargetSchema, targetInput));
  matchFinancialScope(value.scope, scope);
  if (value.responsibilityId !== target.responsibilityId || value.policy.record.kind !== target.kind || value.policy.reference.id !== target.id ||
    value.policy.reference.version !== target.version || target.recordHash !== null && value.policy.reference.recordHash !== target.recordHash)
    throw new FinancialPolicyClientError('unconfirmed');
  await qualifyFinancialRecordMaterial(value.policy.record);
  for (const document of value.documents) await qualifyFinancialRecordMaterial(document.record);
  return value;
}
export async function qualifyFinancialIndex(input: unknown, scopeInput: FinancialPolicyHttpScope, queryInput: FinancialPolicyIndexQuery) {
  const query = freezeFinancial(financialParse(FinancialPolicyIndexQuerySchema, queryInput));
  const scope = freezeFinancial(financialParse(FinancialPolicyHttpScopeSchema, scopeInput));
  const value = freezeFinancial(query.responsibilityId === null ? financialParse(FinancialPolicyHttpGovernanceIndexResponseSchema, input)
    : financialParse(FinancialPolicyHttpDraftIndexResponseSchema, input));
  matchFinancialScope(value.scope, scope);
  if (value.responsibilityId !== query.responsibilityId || value.items.length > query.limit ||
    query.afterId !== null && value.items.some(item => item.policy.record.id <= query.afterId!)) throw new FinancialPolicyClientError('unconfirmed');
  for (const item of value.items) await qualifyFinancialRecordMaterial(item.policy.record);
  return value;
}
export async function qualifyFinancialRecovery(input: unknown, scopeInput: FinancialPolicyHttpScope, referenceInput: FinancialPolicyReference,
  originalInput?: FinancialPolicyAttempt) {
  const value = freezeFinancial(financialParse(FinancialPolicyHttpRecoveryResponseSchema, input));
  const scope = freezeFinancial(financialParse(FinancialPolicyHttpScopeSchema, scopeInput));
  const reference = freezeFinancial(financialParse(FinancialPolicyReferenceSchema, referenceInput));
  const original = originalInput === undefined ? undefined : freezeFinancial(financialParse(AttemptSchema, originalInput));
  matchFinancialScope(value.scope, scope);
  const { responsibilityId, kind, key, targetId, publicRequestHash } = value;
  if (!financialSame({ responsibilityId, kind, key, targetId, publicRequestHash }, reference.locator) ||
    reference.scope.environment !== scope.environment || reference.scope.organizationId !== scope.organizationId || reference.scope.actorId !== scope.actor.actorId)
    throw new FinancialPolicyClientError('unconfirmed');
  if (value.receipt) await qualifyFinancialReceipt(value.receipt, reference, original);
  return value;
}
export type FinancialPolicyQualifiedReceipt = FinancialPolicyHttpReceipt;
