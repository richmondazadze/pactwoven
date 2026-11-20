import { z } from 'zod';
import { IdSchema, FinancialPolicyResponsibilityDocumentHttpSchema, FinancialPolicyHttpContextSchema,
  FinancialPolicyPreparationRequestSchema, FinancialPolicyPreparationResponseSchema, financialPolicyHttpRoute } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { FinancialPolicyBootstrapSchema } from './financial-policy-context';
import { FinancialPolicyClientError, financialParse, financialSame } from './financial-policy-contract';

const action = z.strictObject({ kind: z.literal('save_document'), route: z.string().max(512), responsibilityId: IdSchema,
  id: IdSchema, input: FinancialPolicyResponsibilityDocumentHttpSchema });
const packet = z.strictObject({ bootstrap: FinancialPolicyBootstrapSchema, action,
  selection: FinancialPolicyPreparationRequestSchema, context: FinancialPolicyHttpContextSchema,
  preparation: FinancialPolicyPreparationResponseSchema });
export type FinancialPolicyNewTextMaterial = z.infer<typeof packet>;

function exactKeys(value: object, keys: readonly string[]) {
  if (!financialSame(Object.keys(value).sort(), [...keys].sort())) throw new FinancialPolicyClientError('input');
}
function digestHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Equality material only. Callers must independently establish live provenance and authority. */
export function digestFinancialPolicyNewTextMaterial(input: unknown): Promise<string> {
  // Parse whole inputs before any projection; an unknown field must never disappear in a picked subset.
  const value = financialParse(packet, input), { bootstrap: b, action: a, selection: s, context: c, preparation: p } = value;
  exactKeys(b, ['environment', 'organizationId', 'actorId', 'apiBase', 'responsibilityId', 'userId', 'externalOrganizationId',
    'sessionId', 'organizationEpoch', 'roles', 'siteIds', 'actionSiteIds', 'responsibility']);
  exactKeys(c, ['schemaVersion', 'scope', 'observation', 'effectiveAuthority', 'financialState', 'asset', 'control',
    'acceptedConfiguration', 'periods', 'documents', 'blockers', 'actions', 'kind', 'responsibilityId', 'configurationVisibility', 'draftScope']);
  exactKeys(p, ['schemaVersion', 'scope', 'observation', 'responsibilityId', 'selection', 'decision', 'target', 'material',
    'configurationWarnings', 'effectiveAuthority', 'financialState']);
  exactKeys(c.observation, ['observedAt', 'expiresAt']); exactKeys(p.observation, ['observedAt', 'expiresAt']);
  if (b.responsibilityId === null || b.responsibility === null || c.kind !== 'responsibility' ||
    a.input.previous !== null || a.input.text.includes('\r') || a.input.text.normalize('NFC') !== a.input.text ||
    s.action !== 'save_document' || s.previous !== null || s.purpose !== 'financial_mandate' ||
    p.selection.action !== 'save_document' || p.material.action !== 'save_document' ||
    p.decision.state !== 'reviewable' || p.target.state !== 'absent' || p.material.siteActive !== true ||
    a.route !== financialPolicyHttpRoute({ kind: a.kind, responsibilityId: a.responsibilityId, id: a.id }) || a.responsibilityId !== b.responsibilityId ||
    c.responsibilityId !== b.responsibilityId || p.responsibilityId !== b.responsibilityId ||
    c.scope.environment !== b.environment || c.scope.organizationId !== b.organizationId || c.scope.actor.actorId !== b.actorId ||
    c.scope.organizationEpoch !== b.organizationEpoch || !financialSame(c.scope.roles, b.roles) ||
    !financialSame(c.scope.siteIds, b.siteIds) || !financialSame(c.scope.actionSiteIds, b.actionSiteIds) ||
    c.draftScope.authority.responsibility.id !== b.responsibility.id ||
    c.draftScope.authority.responsibility.version !== b.responsibility.version || c.draftScope.site.id !== b.responsibility.siteId ||
    !financialSame(p.scope, c.scope) || !financialSame(p.material.draftScope, c.draftScope) ||
    p.material.organizationEpoch !== c.scope.organizationEpoch || a.input.organizationEpoch !== c.scope.organizationEpoch ||
    !financialSame(s, { schemaVersion: 1, action: a.kind, targetId: a.id, previous: a.input.previous, purpose: a.input.purpose }) ||
    !financialSame(p.selection, s)) throw new FinancialPolicyClientError('input');

  // Only these two exact root observations vary. Nested business dates remain part of the complete material.
  const { observation: contextObservation, ...context } = c;
  const { observation: preparationObservation, ...preparation } = p;
  void contextObservation; void preparationObservation;
  const bytes = new TextEncoder().encode(canonicalJson({ namespace: 'pactwoven:financial-new-text-review-intent:v1', schemaVersion: 1,
    bootstrap: b, action: a, selection: s, context, preparation }));
  // WebCrypto copies its BufferSource during this call. No async frame retains the packet or its canonical text.
  try {
    return crypto.subtle.digest('SHA-256', bytes).then(digestHex);
  } finally { bytes.fill(0); }
}
