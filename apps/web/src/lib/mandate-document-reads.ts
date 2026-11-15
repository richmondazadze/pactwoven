import { IdSchema, MandateDocumentQuerySchema, MandateDocumentReadSchema, type MandateDocumentRead, type PolicyDocumentVersion } from '@pactwoven/contracts';
import { commandDigest, canonicalJson } from '@pactwoven/contracts/canonical';
import { apiRequest, RequestError, type TokenSource } from './api';
import { getApiBase } from './config';
import { immutableMandate } from './mandate-capsule';
import type { MandateObservation, MandateReadScope } from './mandates';

type VersionReference = Pick<PolicyDocumentVersion, 'id' | 'version' | 'hash'>;
export type DocumentSavePin = { operationId: string; commandHash: string; savedAgainst: MandateDocumentRead['savedAgainst']; actorId: string; text?: string };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function invalid(): never { throw new RequestError('MANDATE_DOCUMENT_UNVERIFIED', 'The exact saved text, historical basis or original save receipt could not be verified.'); }
export function mandateDocumentPath(responsibilityId: string, documentId: string, version: number) {
  const query = MandateDocumentQuerySchema.parse({ version });
  return `/v1/responsibilities/${IdSchema.parse(responsibilityId)}/mandate-policy-documents/${IdSchema.parse(documentId)}?version=${query.version}`;
}
export async function qualifyMandateDocument(input: unknown, scope: MandateReadScope, reference: VersionReference, purpose?: PolicyDocumentVersion['purpose'], pin?: DocumentSavePin): Promise<MandateDocumentRead> {
  scope = structuredClone(scope); reference = structuredClone(reference); pin = pin ? structuredClone(pin) : undefined;
  const value = MandateDocumentReadSchema.parse(input), d = value.document, saved = value.savedAgainst;
  if (value.organizationId !== scope.organizationId || value.environment !== scope.environment || value.responsibilityId !== scope.responsibilityId || !scope.siteIds.includes(saved.responsibility.siteId) ||
      !same({ id: d.id, version: d.version, hash: d.hash }, reference) || (purpose && d.purpose !== purpose)) invalid();
  const { hash, ...body } = d;
  if (await commandDigest(body) !== hash || await commandDigest(d.text) !== d.contentHash || await commandDigest(value.savedResponsibility) !== saved.responsibility.hash) invalid();
  // Validate provenance only. This derived digest input is never an original retry capsule.
  const command = { responsibility: saved.responsibility, expectedOrganizationEpoch: saved.organizationEpoch, command: { documentId: d.id, expectedVersion: d.version - 1, previousVersion: d.previousVersion, purpose: d.purpose, text: d.text } };
  const expectedHash = await commandDigest({ schemaVersion: 1, environment: value.environment, organizationId: value.organizationId, actorId: d.createdBy, kind: 'mandate.document.create', route: { responsibilityId: value.responsibilityId, targetId: d.id }, command });
  if (value.saveOperation.commandHash !== expectedHash || (pin && (value.saveOperation.operation.id !== pin.operationId || value.saveOperation.commandHash !== pin.commandHash || !same(saved, pin.savedAgainst) || d.createdBy !== pin.actorId || (pin.text !== undefined && d.text !== pin.text)))) invalid();
  return immutableMandate(value);
}
export async function readMandateDocument(scope: MandateReadScope, current: () => MandateReadScope | null, signal: AbortSignal, getToken: TokenSource, reference: VersionReference, purpose?: PolicyDocumentVersion['purpose'], pin?: DocumentSavePin): Promise<MandateObservation<MandateDocumentRead>> {
  const frozenScope = immutableMandate(structuredClone(scope)), frozenReference = immutableMandate(structuredClone(reference)), frozenPin = pin ? immutableMandate(structuredClone(pin)) : undefined;
  function guard(): undefined { signal.throwIfAborted(); if (getApiBase() !== frozenScope.apiBase || !same(current(), frozenScope)) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The authenticated document-read scope changed.', 403); return undefined; }
  guard(); const guardedToken = async () => { guard(); const token = await getToken(); guard(); return token; };
  const raw = await apiRequest(mandateDocumentPath(frozenScope.responsibilityId, frozenReference.id, frozenReference.version), MandateDocumentReadSchema, guardedToken, { signal, beforeDispatch: guard });
  guard(); const value = await qualifyMandateDocument(raw, frozenScope, frozenReference, purpose, frozenPin); guard();
  return immutableMandate({ data: value, receivedAt: Date.now(), receivedMonotonic: performance.now() });
}
