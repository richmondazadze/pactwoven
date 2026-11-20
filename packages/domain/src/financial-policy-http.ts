import { z } from 'zod';
import { EnvironmentSchema, IdSchema, FinancialPolicyCommandSchema, FinancialPolicyHttpRequestSchema,
  financialPolicyHttpRoute, type FinancialPolicyHttpRequest } from '@pactwoven/contracts';
import { commandDigest } from './canonical.js';
import { immutable } from './financial-primitives.js';
import { financialBudgetAccountId, validateFinancialGovernanceBundle } from './financial-policies.js';
import { DomainError } from './errors.js';

export const FINANCIAL_POLICY_HTTP_REQUEST_NAMESPACE = 'pactwoven:financial-policy-http-request:v1';
// Hash binding supplied by a verified server scope, never accepted as a body.
const HashScopeSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema });
export type FinancialPolicyHttpHashScope = z.infer<typeof HashScopeSchema>;
const invalid = () => new DomainError('FINANCIAL_POLICY_INVALID', 422, 'The reviewed financial-policy material is inconsistent.');
const unavailable = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'The stored original financial-policy request could not be verified.');

export function snapshotFinancialPolicyHttpRequest(input: unknown): FinancialPolicyHttpRequest {
  return immutable(FinancialPolicyHttpRequestSchema.parse(input));
}
async function material(scope: FinancialPolicyHttpHashScope, request: FinancialPolicyHttpRequest): Promise<void> {
  if (request.kind === 'save_draft') {
    const draft = request.input.draft;
    const authority = { ...draft.scope.authority, environment: scope.environment, organizationId: scope.organizationId };
    if (draft.scope.authorityHash !== await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: authority })) throw invalid();
    if (draft.governance !== null && draft.asset !== null && draft.governance.budgetAccountId !==
      await financialBudgetAccountId(scope.environment, scope.organizationId, draft.asset.key)) throw invalid();
  } else if (request.kind === 'propose_governance') {
    await validateFinancialGovernanceBundle(scope.environment, scope.organizationId, request.input.bundle);
  }
}
/** Canonical public intent only; successful parsing/hashing never grants authority. */
export async function financialPolicyHttpRequestHash(scopeInput: unknown, input: unknown): Promise<string> {
  // Both parses clone and freeze before material validation reaches its first await.
  const scope = immutable(HashScopeSchema.parse(scopeInput)), request = snapshotFinancialPolicyHttpRequest(input);
  await material(scope, request);
  return commandDigest({ namespace: FINANCIAL_POLICY_HTTP_REQUEST_NAMESPACE, ...scope,
    kind: request.kind, route: request.route, key: request.key, input: request.input });
}

/**
 * One-way projection of an EXISTING stored command. The private reader must bind
 * its original actor to scope.actorId; the command itself has no actor field.
 * This never constructs a private command, nonce, evidence or successful receipt.
 */
export async function financialPolicyHttpRequestFromStoredCommand(scopeInput: unknown, commandInput: unknown): Promise<FinancialPolicyHttpRequest> {
  try {
    const scope = immutable(HashScopeSchema.parse(scopeInput)), command = immutable(FinancialPolicyCommandSchema.parse(commandInput));
    if (command.environment !== scope.environment || command.organizationId !== scope.organizationId) throw unavailable();
    const reviewed = { schemaVersion: command.schemaVersion, previous: command.previous, organizationEpoch: command.organizationEpoch };
    let input: unknown;
    switch (command.kind) {
      case 'save_document': input = { ...reviewed, purpose: command.purpose, text: command.text }; break;
      case 'save_draft': {
        const authority = command.draft.scope.authority;
        if (authority.environment !== command.environment || authority.organizationId !== command.organizationId ||
          authority.responsibility.id !== command.responsibilityId) throw unavailable();
        // Remove only the duplicate server envelope scope. Preserve every other
        // field, including trust, so unsupported non-null trust rejects visibly.
        const { environment: _environment, organizationId: _organizationId, ...basis } = authority;
        input = { ...reviewed, draft: { ...command.draft, scope: { ...command.draft.scope, authority: basis } } };
        break;
      }
      case 'withdraw_draft': input = reviewed; break;
      case 'propose_governance': input = { ...reviewed, bundle: command.bundle, expectedControl: command.expectedControl, expiresAt: command.expiresAt }; break;
      // These exact private evidence/nonce fields do not belong to visible intent.
      // They remain unchanged in storage and in the original private command hash.
      case 'accept_governance': input = { ...reviewed, expectedControl: command.expectedControl }; break;
      case 'reject_governance': input = { ...reviewed, expectedControl: command.expectedControl }; break;
    }
    const identity = { kind: command.kind, responsibilityId: command.responsibilityId, id: command.id };
    const request = snapshotFinancialPolicyHttpRequest({ ...identity, key: command.key, route: financialPolicyHttpRoute(identity), input });
    await material(scope, request);
    return request;
  } catch {
    // An unsupported/malformed historical command has no invented alternate
    // route or reconstructed outcome. The gateway must preserve uncertainty.
    throw unavailable();
  }
}
