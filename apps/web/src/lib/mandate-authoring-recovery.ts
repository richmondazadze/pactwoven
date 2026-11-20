import { z } from 'zod';
import { HashSchema, IdSchema, IdempotencyKeySchema, InstantSchema, MandateHeadReferenceSchema, MandateResponsibilityReferenceSchema, VersionReferenceSchema } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { RequestError } from './api';
import { MandateRecoveryScopeSchema, mandateRecoveryScope, type MandateRecoveryScope } from './mandate-recovery';
import type { RecoveryStorage } from './bootstrap-recovery';
import type { MandateAuthoringCapsule } from './mandate-authoring';
const version = z.number().int().positive().max(2_147_483_647), epoch = z.number().int().nonnegative().max(2_147_483_647);
const reference = VersionReferenceSchema.safeExtend({ version });
const basis = z.strictObject({ responsibility: MandateResponsibilityReferenceSchema.safeExtend({ version }), organizationEpoch: epoch });
export const AuthoringLocatorSchema = z.strictObject({ version: z.literal(1), scope: MandateRecoveryScopeSchema, preparationId: IdSchema, responsibilityId: IdSchema, key: IdempotencyKeySchema,
  kind: z.enum(['mandate.document.create', 'mandate.propose']), step: z.enum(['acceptance', 'policy', 'proposal']), target: z.strictObject({ id: IdSchema, version }), basis, commandHash: HashSchema,
}).refine(v => v.responsibilityId === v.basis.responsibility.id && (v.kind === 'mandate.propose') === (v.step === 'proposal'), 'Authoring kind, step and responsibility must agree');
export type AuthoringLocator = z.infer<typeof AuthoringLocatorSchema>;
export const AuthoringCheckpointSchema = z.strictObject({ locator: AuthoringLocatorSchema, reference, operationId: IdSchema, savedAt: InstantSchema })
  .refine(v => v.reference.id === v.locator.target.id && v.reference.version === v.locator.target.version, 'A checkpoint must preserve its original target');
export type AuthoringCheckpoint = z.infer<typeof AuthoringCheckpointSchema>;
export const AuthoringDocumentSelectionSchema = z.strictObject({ reference, operationId: IdSchema, savedAt: InstantSchema, commandHash: HashSchema, purpose: z.enum(['ACCEPTANCE_POLICY', 'MANDATE_POLICY']), savedAgainst: basis });
export type AuthoringDocumentSelection = z.infer<typeof AuthoringDocumentSelectionSchema>;
export const AuthoringManifestSchema = z.strictObject({ version: z.literal(1), scope: MandateRecoveryScopeSchema, responsibilityId: IdSchema, preparationId: IdSchema,
  basis: basis.extend({ previousAcceptedVersion: reference.nullable(), expectedHead: MandateHeadReferenceSchema.safeExtend({ mandateVersion: version, mandateEpoch: epoch }).nullable() }),
  mode: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('new') }), z.strictObject({ kind: z.literal('revise'), proposal: reference })]),
  ids: z.strictObject({ acceptanceDocumentId: IdSchema, policyDocumentId: IdSchema, proposalId: IdSchema, mandateId: IdSchema }),
  documents: z.strictObject({ acceptance: AuthoringDocumentSelectionSchema.nullable(), policy: AuthoringDocumentSelectionSchema.nullable() }),
  completed: z.array(AuthoringCheckpointSchema).max(100), pending: AuthoringLocatorSchema.nullable(),
}).superRefine((v, c) => {
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  const all = [...v.completed.map(item => item.locator), ...(v.pending ? [v.pending] : [])];
  const valid = v.basis.responsibility.id === v.responsibilityId && v.ids.acceptanceDocumentId !== v.ids.policyDocumentId &&
    (v.mode.kind !== 'revise' || v.mode.proposal.id === v.ids.proposalId) &&
    ((v.basis.previousAcceptedVersion === null) === (v.basis.expectedHead === null)) &&
    (!v.basis.previousAcceptedVersion || (v.basis.previousAcceptedVersion.id === v.ids.mandateId && v.basis.expectedHead!.mandateId === v.ids.mandateId && v.basis.previousAcceptedVersion.version === v.basis.expectedHead!.mandateVersion)) &&
    (!v.documents.acceptance || (v.documents.acceptance.reference.id === v.ids.acceptanceDocumentId && v.documents.acceptance.purpose === 'ACCEPTANCE_POLICY' && v.documents.acceptance.savedAgainst.responsibility.id === v.responsibilityId)) &&
    (!v.documents.policy || (v.documents.policy.reference.id === v.ids.policyDocumentId && v.documents.policy.purpose === 'MANDATE_POLICY' && v.documents.policy.savedAgainst.responsibility.id === v.responsibilityId)) &&
    all.every(item => same(item.scope, v.scope) && item.responsibilityId === v.responsibilityId) &&
    new Set(v.completed.map(item => `${item.locator.kind}:${item.locator.key}`)).size === v.completed.length &&
    (!v.pending || (v.pending.preparationId === v.preparationId && same(v.pending.basis, { responsibility: v.basis.responsibility, organizationEpoch: v.basis.organizationEpoch }) && v.pending.target.id === (v.pending.step === 'acceptance' ? v.ids.acceptanceDocumentId : v.pending.step === 'policy' ? v.ids.policyDocumentId : v.ids.proposalId)));
  if (!valid) c.addIssue({ code: 'custom', message: 'Preparation references and original attempt scopes must agree' });
});
export type AuthoringManifest = z.infer<typeof AuthoringManifestSchema>;
export type AuthoringSlot = { state: 'empty' } | { state: 'blocked' } | { state: 'ready'; manifest: AuthoringManifest };
const PREFIX = 'pactwoven:mandate-authoring:v1:';
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function authoringStorageKey(scope: MandateRecoveryScope, responsibilityId: string) { return PREFIX + encodeURIComponent(canonicalJson({ scope: mandateRecoveryScope(scope), responsibilityId: IdSchema.parse(responsibilityId) })); }
export function readAuthoringManifest(storage: RecoveryStorage | null, scope: MandateRecoveryScope, responsibilityId: string): AuthoringSlot {
  try { if (!storage) return { state: 'blocked' }; const key = authoringStorageKey(scope, responsibilityId), raw = storage.getItem(key); if (raw === null) return { state: 'empty' }; const manifest = AuthoringManifestSchema.parse(JSON.parse(raw)); return authoringStorageKey(manifest.scope, manifest.responsibilityId) === key ? { state: 'ready', manifest } : { state: 'blocked' }; } catch { return { state: 'blocked' }; }
}
export function listAuthoringManifests(storage: RecoveryStorage | null, scope: MandateRecoveryScope): { blocked: boolean; manifests: AuthoringManifest[] } {
  try {
    if (!storage) return { blocked: true, manifests: [] }; const manifests: AuthoringManifest[] = []; let blocked = false;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i); if (!key?.startsWith(PREFIX)) continue;
      let owner: { scope?: unknown; responsibilityId?: unknown }; try { owner = JSON.parse(decodeURIComponent(key.slice(PREFIX.length))); } catch { blocked = true; continue; }
      if (!same(owner.scope, mandateRecoveryScope(scope))) continue;
      const slot = readAuthoringManifest(storage, scope, String(owner.responsibilityId)); if (slot.state === 'ready') manifests.push(slot.manifest); else blocked = true;
    }
    return { blocked, manifests };
  } catch { return { blocked: true, manifests: [] }; }
}
function conflict(): never { throw new RequestError('AUTHORING_RECOVERY_CHANGED', 'The saved preparation changed or cannot be checked. No replacement attempt is permitted.'); }
function write(storage: RecoveryStorage, value: AuthoringManifest) {
  try { const parsed = AuthoringManifestSchema.parse(value); storage.setItem(authoringStorageKey(parsed.scope, parsed.responsibilityId), canonicalJson(parsed)); const saved = readAuthoringManifest(storage, parsed.scope, parsed.responsibilityId); if (saved.state !== 'ready' || !same(saved.manifest, parsed)) conflict(); return parsed; } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError('AUTHORING_STORAGE_UNAVAILABLE', 'The preparation could not be saved and checked. Keep its original references.'); }
}
function current(storage: RecoveryStorage | null, expected: AuthoringManifest): RecoveryStorage {
  if (!storage) conflict(); const slot = readAuthoringManifest(storage, expected.scope, expected.responsibilityId); if (slot.state !== 'ready' || !same(slot.manifest, expected)) conflict(); return storage;
}
export function storeAuthoringManifest(storage: RecoveryStorage | null, input: AuthoringManifest) {
  const value = AuthoringManifestSchema.parse(input); if (!storage || readAuthoringManifest(storage, value.scope, value.responsibilityId).state !== 'empty' || value.pending !== null || value.completed.length || value.documents.acceptance || value.documents.policy) conflict(); return write(storage, value);
}
// Explicit new preparation only; retain all confirmed minimal refs, never an old pending command.
export function replaceAuthoringPreparation(storage: RecoveryStorage | null, expected: AuthoringManifest, input: AuthoringManifest) {
  const target = current(storage, expected), next = AuthoringManifestSchema.parse(input);
  if (expected.pending || next.pending || expected.preparationId === next.preparationId || !same(expected.scope, next.scope) || expected.responsibilityId !== next.responsibilityId || next.completed.length || next.documents.acceptance || next.documents.policy) conflict();
  return write(target, { ...next, completed: expected.completed });
}
export function locatorFromAuthoringCapsule(capsule: MandateAuthoringCapsule): AuthoringLocator {
  const proposal = capsule.kind === 'proposal';
  return AuthoringLocatorSchema.parse({ version: 1, scope: mandateRecoveryScope(capsule.scope), responsibilityId: capsule.scope.responsibilityId, preparationId: capsule.manifest.preparationId, key: capsule.key, kind: proposal ? 'mandate.propose' : 'mandate.document.create', step: proposal ? 'proposal' : capsule.command.command.purpose === 'ACCEPTANCE_POLICY' ? 'acceptance' : 'policy', target: { id: proposal ? capsule.command.proposalId : capsule.command.command.documentId, version: (proposal ? capsule.command.expectedProposalVersion : capsule.command.command.expectedVersion) + 1 }, basis: { responsibility: capsule.manifest.basis.responsibility, organizationEpoch: capsule.manifest.basis.organizationEpoch }, commandHash: capsule.commandHash });
}
export function beginAuthoringAttempt(storage: RecoveryStorage | null, expected: AuthoringManifest, locatorInput: AuthoringLocator) {
  const target = current(storage, expected), locator = AuthoringLocatorSchema.parse(locatorInput); if (expected.pending) conflict(); return write(target, { ...expected, pending: locator });
}
export function assertAuthoringAttempt(storage: RecoveryStorage | null, locator: AuthoringLocator) {
  const slot = readAuthoringManifest(storage, locator.scope, locator.responsibilityId); if (slot.state !== 'ready' || !same(slot.manifest.pending, locator)) conflict(); return slot.manifest;
}
// Storage primitive: caller must first qualify the exact connected document/proposal and receipt.
export function checkpointAuthoringAttempt(storage: RecoveryStorage | null, locator: AuthoringLocator, input: AuthoringCheckpoint, document?: AuthoringDocumentSelection) {
  let manifest = assertAuthoringAttempt(storage, locator); const checkpoint = AuthoringCheckpointSchema.parse(input);
  if (!same(checkpoint.locator, locator)) conflict(); const existing = manifest.completed.find(item => item.locator.kind === locator.kind && item.locator.key === locator.key);
  if (existing && !same(existing, checkpoint)) conflict();
  if (locator.step !== 'proposal' && (!document || !same(document.reference, checkpoint.reference) || document.operationId !== checkpoint.operationId || document.commandHash !== locator.commandHash || document.savedAt !== checkpoint.savedAt || !same(document.savedAgainst, locator.basis) || document.purpose !== (locator.step === 'acceptance' ? 'ACCEPTANCE_POLICY' : 'MANDATE_POLICY'))) conflict();
  const documents = locator.step === 'proposal' ? manifest.documents : { ...manifest.documents, [locator.step]: AuthoringDocumentSelectionSchema.parse(document) };
  if (!existing || !same(documents, manifest.documents)) manifest = write(current(storage, manifest), { ...manifest, documents, completed: existing ? manifest.completed : [...manifest.completed, checkpoint] });
  // Completed ref was persisted/read back before pending removal. Failure leaves a recheckable locator.
  return write(current(storage, manifest), { ...manifest, pending: null });
}
export function currentAuthoringCheckpoint(manifest: AuthoringManifest, step: AuthoringLocator['step']) {
  return manifest.completed.filter(item => item.locator.preparationId === manifest.preparationId && item.locator.step === step).sort((a, b) => b.reference.version - a.reference.version)[0] ?? null;
}

// Caller qualifies the connected read before choosing saved material for this preparation.
export function selectAuthoringDocument(storage: RecoveryStorage | null, expected: AuthoringManifest, input: AuthoringDocumentSelection) {
  const target = current(storage, expected), selection = AuthoringDocumentSelectionSchema.parse(input); if (expected.pending) conflict();
  const step = selection.purpose === 'ACCEPTANCE_POLICY' ? 'acceptance' : 'policy';
  return write(target, { ...expected, documents: { ...expected.documents, [step]: selection } });
}
