import { FinancialPolicyPreparationRequestSchema, FinancialPolicyPreparationResponseSchema, financialPolicyHttpRoute,
  type FinancialPolicyPreparationRequest, type FinancialPolicyPreparationResponse, type FinancialPolicyHttpRecord,
  type FinancialPolicyRef } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { FinancialPolicyClientError, financialParse, financialSame, freezeFinancial, matchFinancialScope,
  qualifyFinancialDraftBasis, qualifyFinancialRecordMaterial } from './financial-policy-contract';
import type { FinancialPolicyObservation } from './financial-policy-context';

export type FinancialPolicyPreparationSelection = Extract<FinancialPolicyPreparationRequest, { action: 'save_document' | 'save_draft' }>;
export function parseFinancialPolicyPreparationSelection(input: unknown, responsibilityId: string | null): FinancialPolicyPreparationSelection {
  const selection = freezeFinancial(financialParse(FinancialPolicyPreparationRequestSchema, input));
  if (selection.action !== 'save_document' && selection.action !== 'save_draft' ||
    selection.action === 'save_document' && (selection.purpose === 'financial_mandate') !== (responsibilityId !== null))
    throw new FinancialPolicyClientError('input');
  try { financialPolicyHttpRoute({ kind: selection.action, id: selection.targetId, responsibilityId }); }
  catch { throw new FinancialPolicyClientError('input'); }
  return selection;
}
export type QualifiedFinancialPolicyPreparation = Readonly<{
  selection: FinancialPolicyPreparationSelection; response: FinancialPolicyPreparationResponse;
  observation: FinancialPolicyObservation; receivedAt: number; receivedMonotonic: number; expiresAt: number;
}>;
const qualified = new WeakSet<object>();
/** Recognition means public material consistency, never private identity or action authorization. */
export function assertQualifiedFinancialPolicyPreparation(value: QualifiedFinancialPolicyPreparation): void {
  if (!qualified.has(value)) throw new FinancialPolicyClientError('unconfirmed');
}

export async function qualifyFinancialPolicyPreparation(input: unknown, selectionInput: unknown, observation: FinancialPolicyObservation,
  receivedAt: number, receivedMonotonic: number, guard: (expiresAt?: number) => void = () => {}): Promise<QualifiedFinancialPolicyPreparation> {
  const selection = parseFinancialPolicyPreparationSelection(selectionInput, observation.bootstrap.responsibilityId);
  const response = freezeFinancial(financialParse(FinancialPolicyPreparationResponseSchema, input));
  guard(); matchFinancialScope(response.scope, observation.context.scope);
  if (response.responsibilityId !== observation.bootstrap.responsibilityId || !financialSame(response.selection, selection))
    throw new FinancialPolicyClientError('unconfirmed');
  const expiresAt = Math.min(observation.expiresAt, Date.parse(response.observation.expiresAt));
  if (![receivedAt, receivedMonotonic].every(v => Number.isFinite(v) && v >= 0) ||
    Date.parse(response.observation.observedAt) > receivedAt || receivedAt >= expiresAt) throw new FinancialPolicyClientError('expired');
  // Publish the stricter parsed deadline to the caller's abort guard before any hash awaits.
  guard(expiresAt);
  // Parsing the wide public contract must not add actions to this initial client.
  const material = response.material;
  if (material.action !== 'save_document' && material.action !== 'save_draft') throw new FinancialPolicyClientError('input');
  if (material.draftScope !== null && !financialSame(material.draftScope, observation.context.draftScope))
    throw new FinancialPolicyClientError('expired');

  const records = new Map<string, { reference: FinancialPolicyRef; record: FinancialPolicyHttpRecord }>();
  async function record(reference: FinancialPolicyRef, value: FinancialPolicyHttpRecord) {
    guard();
    const key = canonicalJson([value.environment, value.organizationId, value.id, value.version]), previous = records.get(key);
    if (previous && (!financialSame(previous.reference, reference) || !financialSame(previous.record, value)))
      throw new FinancialPolicyClientError('unconfirmed');
    if (!previous) {
      records.set(key, { reference, record: value });
      await qualifyFinancialRecordMaterial(value); guard();
    }
  }
  if (response.target.state === 'exact') {
    await record(response.target.record.reference, response.target.record.record); guard();
    for (const document of response.target.historicalDocuments) { await record(document.reference, document.record); guard(); }
  }
  if (material.draftScope) { await qualifyFinancialDraftBasis(response.scope, material.draftScope); guard(); }
  if (material.action === 'save_draft' && material.document) { await record(material.document.reference, material.document.record); guard(); }
  guard();
  const result = freezeFinancial({ selection, response, observation, receivedAt, receivedMonotonic, expiresAt });
  qualified.add(result); return result;
}
