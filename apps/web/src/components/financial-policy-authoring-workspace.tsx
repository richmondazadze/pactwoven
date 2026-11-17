'use client';
import { useAuth } from '@clerk/nextjs';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { IdSchema, FinancialPolicyRefSchema, FinancialPolicyVersionSchema, financialPolicyHttpRoute,
  type FinancialPolicyHttpContext, type FinancialPolicyHttpRecordResponse, type FinancialPolicyHttpDraftIndexResponse, type FinancialPolicyHttpGovernanceIndexResponse, type FinancialPolicyRef } from '@pactwoven/contracts';
import { apiRequest } from '../lib/api';
import { browserRecoveryStorage } from '../lib/bootstrap-recovery';
import { getApiBase } from '../lib/config';
import { scopedResponsibilitySchema } from '../lib/responsibilities';
import { FinancialPolicyClientError, financialSame, freezeFinancial, type FinancialPolicyQualifiedReceipt, type FinancialPolicyReference } from '../lib/financial-policy-contract';
import { createFinancialPolicyBootstrap, createFinancialPolicyClock, createFinancialPolicyLifetime, financialPolicyBootstrapKey,
  financialPolicyLocalScope, type FinancialPolicyBootstrap } from '../lib/financial-policy-context';
import { createFinancialPolicyTransport, type FinancialPolicyTransportAdapters } from '../lib/financial-policy-transport';
import { createFinancialPolicyPreparationClient, type FinancialPolicyPreparationSnapshot } from '../lib/financial-policy-preparation-client';
import { createFinancialPolicyAttemptCoordinator, FinancialPolicyWriteAttemptError } from '../lib/financial-policy-attempt-coordinator';
import { parseFinancialPolicyWriteRequest, type FinancialPolicyWriteRequest } from '../lib/financial-policy-write-transport';
import { clearFinancialPolicyReminder, createFinancialPolicyMemory, listFinancialPolicyReferences, type FinancialPolicyStorage } from '../lib/financial-policy-recovery';
import { FinancialPolicyRecoveryPanel, type FinancialPolicyRecoveryRow } from './financial-policy-recovery-panel';
import { FinancialPolicyReview, FinancialPolicyReceiptReview, financialPolicyCollectionPath } from './financial-policy-review';
import { FinancialPolicyPreparationReview } from './financial-policy-preparation-review';
import { FinancialPolicyDocumentEditor, FinancialPolicyAuthoringInputError, reviewFinancialPolicyDocument } from './financial-policy-document-editor';
import { FinancialPolicyDraftEditor, emptyFinancialPolicyDraftDates, reviewFinancialPolicyDraft, type FinancialPolicyDraftDates } from './financial-policy-draft-editor';
import { ActionLabel, Alert, ButtonLink, LoadingState, PageHeading, Panel } from './ui';
import { useArrival, useMotion } from './motion';
import { useWorkspace } from './workspace-provider';
import { BrandLoader } from './brand-loader';

type Kind = 'document' | 'draft';
type Revision = Readonly<{ id: string; version: number; kind?: Kind }> | null;
type CapturedRevision = Readonly<{ id: string; version: number; kind: Kind }> | null;
function captureRevision(input: Revision | undefined): CapturedRevision {
  if (input == null) return null;
  const { id, version, kind = 'draft' } = input;
  const parsedId = IdSchema.safeParse(id), parsedVersion = FinancialPolicyVersionSchema.safeParse(version);
  if (!parsedId.success || !parsedVersion.success || kind !== 'document' && kind !== 'draft') throw new FinancialPolicyClientError('input');
  return freezeFinancial({ id: parsedId.data, version: parsedVersion.data, kind });
}
export type FinancialPolicyAuthoringAdapters = Omit<FinancialPolicyTransportAdapters, 'lifetime' | 'memory'> & {
  bootstrap: FinancialPolicyBootstrap; revision?: Revision; createKey?: () => string; createTargetId?: (kind: Kind) => string;
};
type DraftReview = ReturnType<typeof reviewFinancialPolicyDraft>;
type Review = { kind: 'save_document'; input: Extract<FinancialPolicyWriteRequest, { kind: 'save_document' }>['input'] }
  | { kind: 'save_draft'; input: Extract<FinancialPolicyWriteRequest, { kind: 'save_draft' }>['input']; dates: FinancialPolicyDraftDates };
type Buffer = Readonly<{ kind: Kind; documentId: string; draftId: string; text: string; dates: FinancialPolicyDraftDates;
  document: { id: string; version: string; recordHash: string } }>;
type View = Readonly<{ visible: boolean; phase: 'idle' | 'ready' | 'expired' | 'denied' | 'unavailable'; busy: boolean; editorOpened: boolean;
  context: FinancialPolicyHttpContext | null; exact: FinancialPolicyHttpRecordResponse | null; preparation: FinancialPolicyPreparationSnapshot;
  index: FinancialPolicyHttpDraftIndexResponse | FinancialPolicyHttpGovernanceIndexResponse | null; documentRead: FinancialPolicyHttpRecordResponse | null;
  buffer: Buffer; review: Review | null; receipt: FinancialPolicyQualifiedReceipt | null;
  unsent: FinancialPolicyReference | null;
  rows: readonly FinancialPolicyRecoveryRow[]; storageBlocked: boolean; message: string; focus: number; error: { field: string; message: string } | null }>;
const emptyBuffer = (revision: CapturedRevision): Buffer => ({ kind: revision?.kind ?? 'document', documentId: revision?.id ?? '', draftId: revision?.id ?? '', text: '',
  dates: emptyFinancialPolicyDraftDates(), document: { id: '', version: '', recordHash: '' } });
const idlePreparation = (): FinancialPolicyPreparationSnapshot => ({ state: 'idle', preparation: null });
const initial = (revision: CapturedRevision): View => ({ visible: false, phase: 'idle', busy: false, editorOpened: false, context: null, exact: null, index: null, documentRead: null, preparation: idlePreparation(),
  buffer: emptyBuffer(revision), review: null, receipt: null, unsent: null, rows: [], storageBlocked: false, message: 'Check current context explicitly to begin. Nothing has been saved.', focus: 0, error: null });
const expiredMessage = 'The observation expired. Your unsent edits remain here; check current context, review and prepare again.';
const deniedMessage = 'Current access is unavailable. Private text and review material have been cleared. Original reminders remain in this tab.';
const saveFailureReasons = {
  storage: 'This tab could not verify its saved request reminder.',
  unavailable: 'The current save check is unavailable.',
  unconfirmed: 'The pre-send check did not complete.',
  input: 'The exact reviewed request could not be validated.',
} as const;

/** One explicit lane and one stable verifier/coordinator composition per route ownership. No constructor I/O. */
export function createFinancialPolicyAuthoringController(first: FinancialPolicyAuthoringAdapters, isCurrent: () => boolean = () => true) {
  let adapters = first, bootstrap = freezeFinancial(structuredClone(first.bootstrap)), revision = captureRevision(first.revision);
  if (bootstrap.responsibilityId === null) throw new FinancialPolicyClientError('scope');
  let view = initial(revision), visible = false, closed = false, denied = false, active: object | null = null, sequence = 0;
  let preserveBuffer = false, replacing = false, expiry: ReturnType<typeof setTimeout> | null = null;
  let displayNow: (() => number) | null = null, displayDeadline = 0;
  const serverView = initial(revision), listeners = new Set<() => void>();
  const lifetime = createFinancialPolicyLifetime(bootstrap, { wall: () => (adapters.wall ?? Date.now)(), monotonic: () => (adapters.monotonic ?? (() => performance.now()))() });
  let memory = createFinancialPolicyMemory(financialPolicyLocalScope(bootstrap));
  let transport = createFinancialPolicyTransport({ ...adapters, lifetime, memory });
  let preparation = createFinancialPolicyPreparationClient({ ...adapters, lifetime });
  let writer = createFinancialPolicyAttemptCoordinator({ ...adapters, lifetime, memory, preparation: preparation.verifier });
  function publish(next: View) { view = freezeFinancial(next); for (const listener of listeners) listener(); }
  function timerOff() { if (expiry !== null) clearTimeout(expiry); expiry = null; }
  function current() { try { return !closed && visible && isCurrent() && getApiBase() === bootstrap.apiBase && financialSame(adapters.currentBootstrap(), bootstrap); } catch { return false; } }
  function matches(next: FinancialPolicyAuthoringAdapters) {
    try { return financialPolicyBootstrapKey(next.bootstrap) === financialPolicyBootstrapKey(bootstrap) && financialSame(captureRevision(next.revision), revision) &&
      next.currentBootstrap === adapters.currentBootstrap && next.getToken === adapters.getToken && next.fetch === adapters.fetch && next.storage === adapters.storage &&
      next.wall === adapters.wall && next.monotonic === adapters.monotonic && next.createKey === adapters.createKey && next.createTargetId === adapters.createTargetId; } catch { return false; }
  }
  function preserving<T>(work: () => T): T { const previous = preserveBuffer; preserveBuffer = current(); try { return work(); } finally { preserveBuffer = previous; } }
  function clearProtected() {
    timerOff(); displayNow = null; displayDeadline = 0;
    const keepLocal = preserveBuffer && current(), buffer = keepLocal ? view.buffer : emptyBuffer(revision);
    publish({ ...initial(revision), visible, phase: denied ? 'denied' : 'idle', busy: active !== null, buffer,
      editorOpened: keepLocal && view.editorOpened, focus: view.focus });
  }
  lifetime.onInvalidate(clearProtected);
  function observePreparation() {
    return preparation.subscribe(() => {
      if (replacing || closed) return;
      // This freshness getter can synchronously expire the lifetime before the
      // display timer runs. Preserve only this current owner's local edits.
      const snapshot = denied ? preparation.getSnapshot() : preserving(() => preparation.getSnapshot()); writer.invalidateReview();
      const expired = snapshot.state === 'expired' && !denied && current();
      publish({ ...view, unsent: null, preparation: snapshot, ...(expired ? { review: null, phase: view.context ? view.phase : 'expired',
        message: view.context ? 'The preparation expired. Your local edits remain here; review and check preparation again.'
          : 'The observation expired. Your local edits remain here; check current context, review and prepare again.' } : {}) });
    });
  }
  let unlistenPreparation = observePreparation();
  function ready() {
    if (!current() || denied) throw new FinancialPolicyClientError('scope');
    if (displayNow && displayNow() >= displayDeadline) throw new FinancialPolicyClientError('expired');
    return preserving(() => lifetime.observation());
  }
  function fresh() { try { return !view.context || Boolean(displayNow && displayNow() < displayDeadline); } catch { return false; } }
  function invalidateReview(clear = true) {
    writer.invalidateReview(); preparation.invalidate();
    publish({ ...view, unsent: null, review: clear ? null : view.review, error: null });
  }
  function expireDisplay() {
    active = null; preserving(() => lifetime.invalidate());
    if (current()) publish({ ...view, phase: 'expired', busy: false, message: expiredMessage });
  }
  function arm(responseExpiry?: string) {
    timerOff(); const observation = ready();
    displayNow ??= createFinancialPolicyClock(observation.receivedAt, observation.receivedMonotonic, adapters.wall, adapters.monotonic);
    displayDeadline = Math.min(displayDeadline || observation.expiresAt, observation.expiresAt, responseExpiry ? Date.parse(responseExpiry) : Infinity);
    const remaining = displayDeadline - displayNow(); if (remaining <= 0) throw new FinancialPolicyClientError('expired');
    expiry = setTimeout(expireDisplay, remaining);
  }
  function rows() {
    ready(); const inventory = listFinancialPolicyReferences(adapters.storage(), financialPolicyLocalScope(bootstrap));
    const next: FinancialPolicyRecoveryRow[] = inventory.references.map(reference => view.rows.find(row => financialSame(row.reference, reference)) ??
      { reference, state: 'unchecked', receipt: null, message: 'Check this exact original. Reloaded or lost unsent input is lookup-only and cannot be resent from this reminder.' });
    for (const row of view.rows) if (row.state === 'cleared' && !next.some(other => financialSame(other.reference, row.reference))) next.push(row);
    publish({ ...view, rows: next, storageBlocked: inventory.blocked });
  }
  function hasVisibleOriginal() {
    if (!current() || denied || !view.context || !fresh() || view.storageBlocked) return false;
    const id = view.buffer.kind === 'document' ? view.buffer.documentId : view.buffer.draftId;
    const scope = financialPolicyLocalScope(bootstrap);
    // Presentation uses only current, already qualified rows. The writer retains its broader inventory barriers.
    return Boolean(id && view.rows.some(row => row.state !== 'cleared' && row.reference.locator.targetId === id && financialSame(row.reference.scope, scope)));
  }
  function updateRow(reference: FinancialPolicyReference, update: Partial<FinancialPolicyRecoveryRow>) {
    publish({ ...view, rows: view.rows.map(row => financialSame(row.reference, reference) ? { ...row, ...update } : row) });
  }
  function suspend() { visible = false; active = null; preserveBuffer = false; lifetime.hide(); }
  function report(error: unknown, expiredBuffer?: Buffer, expiredEditorOpened = false) {
    if (!current()) { suspend(); return; }
    if (error instanceof FinancialPolicyAuthoringInputError) {
      publish({ ...view, error: { field: error.field, message: error.message }, message: error.message, focus: ++sequence }); return;
    }
    const code = error instanceof FinancialPolicyClientError ? error.code : 'unconfirmed';
    const saveReason = error instanceof FinancialPolicyWriteAttemptError && error.reason === 'token-unavailable'
      ? 'Your sign-in could not be refreshed before sending.'
      : Object.hasOwn(saveFailureReasons, code) ? saveFailureReasons[code as keyof typeof saveFailureReasons] : 'The pre-send check did not complete.';
    if (code === 'scope') { denied = true; preserveBuffer = false; lifetime.deny(); }
    else if (code === 'expired') preserving(() => lifetime.invalidate());
    // A synchronous freshness failure inside an awaited transport may already have
    // cleared the view. Restore only local editing state for this still-current owner;
    // denied, hidden and replaced owners never reach this expiry restoration.
    publish({ ...view, ...(code === 'expired' && expiredBuffer && !denied && current() ? { buffer: expiredBuffer, editorOpened: expiredEditorOpened } : {}),
      phase: code === 'scope' ? 'denied' : code === 'expired' ? 'expired' : view.context ? 'ready' : 'unavailable',
      message: code === 'scope' ? deniedMessage : code === 'expired' ? error instanceof FinancialPolicyWriteAttemptError && error.outcome === 'unknown'
        ? 'The observation expired. The original save result is unknown. Check that exact original result explicitly. Do not create a replacement request.' : expiredMessage : error instanceof FinancialPolicyWriteAttemptError
        ? error.outcome === 'unknown' ? 'The save result is unknown. Check the original result explicitly. Do not create a replacement request.'
          : view.unsent ? `The original save was not sent. ${saveReason} You can explicitly continue this exact original while its context and preparation remain current.`
            : `No save was sent. ${saveReason} Any stored original reminder is preserved and remains lookup-only after its input is lost.`
        : error instanceof FinancialPolicyClientError ? error.message : 'This action could not be confirmed. Original reminders are preserved.', focus: ++sequence });
  }
  async function run(message: string, work: (check: () => void) => Promise<void>) {
    if (active || !current() || denied) return;
    const operation = {}, owner = transport, buffer = view.buffer, editorOpened = view.editorOpened; active = operation;
    publish({ ...view, busy: true, error: null, message });
    const check = () => { if (active !== operation || transport !== owner || !current()) throw new FinancialPolicyClientError('scope'); };
    try { await work(check); check(); publish({ ...view, focus: ++sequence }); }
    catch (error) { if (active === operation && transport === owner) report(error, buffer, editorOpened); }
    finally { if (active === operation) { active = null; publish({ ...view, busy: false }); } }
  }
  function previous(kind: Kind): FinancialPolicyRef | null {
    if (!revision) return null;
    if (!view.exact || view.exact.policy.record.kind !== kind || view.exact.policy.reference.id !== revision.id || view.exact.policy.reference.version !== revision.version)
      throw new FinancialPolicyAuthoringInputError('revision-kind', 'Read this exact selected version before reviewing a revision.');
    return view.exact.policy.reference;
  }
  function selectedDocument(): FinancialPolicyRef {
    const { id, version, recordHash } = view.buffer.document;
    const result = FinancialPolicyRefSchema.safeParse({ id, version: /^[1-9]\d*$/.test(version) ? Number(version) : NaN, recordHash });
    if (!result.success) throw new FinancialPolicyAuthoringInputError('draft-document-id', 'Select the exact policy document ID, version and record hash.');
    return result.data;
  }
  function targetId(kind: Kind) {
    const value = kind === 'document' ? view.buffer.documentId : view.buffer.draftId;
    if (!IdSchema.safeParse(value).success || kind === 'draft' && value === 'context' || revision && value !== revision.id)
      throw new FinancialPolicyAuthoringInputError('authoring-start', 'Start this policy text or draft first. Its chosen record will be retained if preparation finds a conflict.');
    return value;
  }
  function requestFor(review: Review, key: string): FinancialPolicyWriteRequest {
    if (review.kind !== (view.buffer.kind === 'document' ? 'save_document' : 'save_draft')) throw new FinancialPolicyClientError('input');
    const kind = review.kind, id = targetId(kind === 'save_document' ? 'document' : 'draft'), responsibilityId = bootstrap.responsibilityId;
    return parseFinancialPolicyWriteRequest({ kind, id, responsibilityId, key, route: financialPolicyHttpRoute({ kind, id, responsibilityId }), input: review.input });
  }
  function local(work: () => void) {
    if (active || !current() || denied) return;
    invalidateReview();
    try { ready(); work(); publish({ ...view, focus: ++sequence }); } catch (error) { report(error); }
  }
  async function sendReviewed(check: () => void, original: FinancialPolicyReference | null) {
    ready(); const review = view.review;
    if (!review || preparation.getSnapshot().state !== 'reviewable') throw new FinancialPolicyClientError('unavailable');
    let retainUnsent = false;
    try {
      const gesture = original ? writer.continueUnsent(original)
        : writer.review(requestFor(review, (adapters.createKey ?? (() => crypto.randomUUID()))()));
      const result = await writer.send(gesture); check(); ready(); rows();
      updateRow(result.reference, { state: 'recorded', receipt: result.receipt, message: 'The exact immutable original result was recorded. Clearing the local reminder is separate.' });
      publish({ ...view, receipt: result.receipt, unsent: null, review: null, message: review.kind === 'save_document'
        ? 'Policy text saved. Preparing and saving a draft are separate actions.' : 'Incomplete draft saved. No spending authority or available funds were created.' });
    } catch (error) {
      check(); try { rows(); } catch { /* Preserve the writer error and its original locator. */ }
      if (error instanceof FinancialPolicyWriteAttemptError && error.outcome === 'not-dispatched' &&
        error.code !== 'scope' && error.code !== 'expired' && view.review === review && !view.storageBlocked) {
        const status = preserving(() => writer.status());
        retainUnsent = status.state === 'unsent' && status.reference !== null &&
          view.rows.some(row => financialSame(row.reference, status.reference)) && preparation.getSnapshot().state === 'reviewable';
        if (retainUnsent) publish({ ...view, unsent: status.reference });
      }
      throw error;
    } finally {
      try {
        check();
        // A current live coordinator alone can prove that this exact original never
        // reached dispatch. Keep its existing review for a separate deliberate action.
        if (!retainUnsent) { publish({ ...view, unsent: null, review: null }); preparation.invalidate(); }
      } catch { /* A departed owner cannot change its replacement's review. */ }
    }
  }
  return {
    getSnapshot: () => view, getServerSnapshot: () => serverView,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    matches, current, fresh, expireDisplay, hasVisibleOriginal,
    preparationFresh() { try { return Boolean(current() && view.preparation.preparation && displayNow && displayNow() < view.preparation.preparation.expiresAt); } catch { return false; } },
    configure(next: FinancialPolicyAuthoringAdapters) {
      if (closed || matches(next)) return;
      const nextRevision = captureRevision(next.revision);
      active = null; replacing = true; unlistenPreparation(); writer.close(); preparation.close(); transport.dispose(); memory.close(); lifetime.invalidate();
      adapters = next; bootstrap = freezeFinancial(structuredClone(next.bootstrap)); revision = nextRevision; denied = false;
      try { lifetime.activate(bootstrap); } catch { denied = true; }
      memory = createFinancialPolicyMemory(financialPolicyLocalScope(bootstrap)); transport = createFinancialPolicyTransport({ ...adapters, lifetime, memory });
      preparation = createFinancialPolicyPreparationClient({ ...adapters, lifetime }); writer = createFinancialPolicyAttemptCoordinator({ ...adapters, lifetime, memory, preparation: preparation.verifier });
      replacing = false; unlistenPreparation = observePreparation(); clearProtected();
    },
    activate() {
      if (closed) return; visible = true; active = null;
      try { lifetime.activate(bootstrap); } catch { denied = true; }
      if (!current()) { suspend(); return; }
      publish({ ...initial(revision), visible: true, phase: denied ? 'denied' : 'idle', message: denied ? deniedMessage : initial(revision).message });
    },
    suspend,
    refresh() { return run('Checking current financial-policy context…', async check => {
      invalidateReview(); const query = { assetKey: null };
      const pending = preserving(() => transport.context(query, lifetime.authorize('context', query))), observation = await pending;
      check(); ready(); publish({ ...view, phase: 'ready', editorOpened: true, context: observation.context, message: 'Current context checked. Review your exact input and check preparation separately.' }); rows(); arm();
    }); },
    startNew(kind: Kind) { local(() => {
      if (revision || !['document', 'draft'].includes(kind)) throw new FinancialPolicyClientError('input');
      const field = kind === 'document' ? 'documentId' : 'draftId';
      const id = view.buffer[field] || (adapters.createTargetId ?? (() => crypto.randomUUID()))(kind);
      if (!IdSchema.safeParse(id).success || kind === 'draft' && id === 'context') throw new FinancialPolicyClientError('input');
      publish({ ...view, exact: null, buffer: { ...view.buffer, kind, [field]: id }, message: kind === 'document'
        ? 'Policy text started. This form keeps its chosen record through checks and retries.' : 'Draft started. Select a checked policy text or saved receipt, then review the exact terms and dates.' });
    }); },
    edit(update: Partial<Pick<Buffer, 'kind' | 'text' | 'dates'>>) {
      if (active || !current() || denied || !view.editorOpened) return;
      invalidateReview();
      const buffer = { ...view.buffer, ...(update.kind && ['document', 'draft'].includes(update.kind) ? { kind: update.kind } : {}),
        ...(typeof update.text === 'string' ? { text: update.text } : {}), ...(update.dates ? { dates: { ...update.dates } } : {}) };
      publish({ ...view, buffer, exact: update.kind ? null : view.exact, message: 'Unsent edits changed. Review and check preparation again before saving.' });
    },
    indexDocuments(afterId: string | null = null) { return run('Reading saved draft document references…', async check => {
      invalidateReview(); ready(); const query = { responsibilityId: bootstrap.responsibilityId, afterId, limit: 25 };
      publish({ ...view, index: null, documentRead: null });
      const response = await transport.index(query, lifetime.authorize('index', query)); check(); ready(); arm(response.observation.expiresAt);
      publish({ ...view, index: response, message: 'Saved draft references checked. Read an exact referenced policy text before selecting it.' });
    }); },
    readDocument(reference: FinancialPolicyRef) { return run('Reading the exact referenced policy text…', async check => {
      invalidateReview(); ready();
      const indexed = view.index?.items.some(item => item.policy.record.kind === 'draft' && item.policy.record.draft.documents.some(doc => financialSame({ id: doc.id, version: doc.version, recordHash: doc.recordHash }, reference)));
      const contextDocument = view.context?.documents.some(doc => financialSame(doc.reference, reference));
      if (!indexed && !contextDocument) throw new FinancialPolicyClientError('input');
      const target = { kind: 'document' as const, responsibilityId: bootstrap.responsibilityId, ...reference };
      publish({ ...view, documentRead: null });
      const response = await transport.read(target, lifetime.authorize('read', target)); check(); ready(); arm(response.observation.expiresAt);
      publish({ ...view, documentRead: response, message: 'Exact policy text checked. Select this version explicitly; no latest version is substituted.' });
    }); },
    selectReadDocument() { local(() => {
      const response = view.documentRead;
      if (!response || response.policy.record.kind !== 'document' || response.policy.record.purpose !== 'financial_mandate') throw new FinancialPolicyClientError('input');
      const { id, version, recordHash } = response.policy.reference;
      publish({ ...view, buffer: { ...view.buffer, document: { id, version: String(version), recordHash } }, message: 'Exact policy text selected. Review dates and check fresh draft preparation before saving.' });
    }); },
    readRevision() { return run('Reading the exact selected revision…', async check => {
      invalidateReview(); ready(); if (!revision) throw new FinancialPolicyClientError('input');
      const target = { ...revision, kind: view.buffer.kind, responsibilityId: bootstrap.responsibilityId, recordHash: null };
      publish({ ...view, exact: null });
      const response = await transport.read(target, lifetime.authorize('read', target)); check(); ready(); arm(response.observation.expiresAt);
      publish({ ...view, exact: response, message: 'Exact previous version checked. Its text and dates have not been merged into your edits.' });
    }); },
    reviewDocument() { local(() => {
      if (view.buffer.kind !== 'document') throw new FinancialPolicyClientError('input');
      targetId('document'); const observation = ready(), value = reviewFinancialPolicyDocument(view.buffer.text);
      const review: Review = { kind: 'save_document', input: { schemaVersion: 1, previous: previous('document'), organizationEpoch: observation.context.scope.organizationEpoch, purpose: 'financial_mandate', text: value.text } };
      requestFor(review, 'local_review_placeholder');
      publish({ ...view, buffer: { ...view.buffer, text: value.text }, review, message: value.changed ? 'Text normalized to NFC and LF. Review this exact text, then check preparation.' : 'Exact text reviewed locally. Check preparation before saving.' });
    }); },
    reviewDraft() { local(() => {
      if (view.buffer.kind !== 'draft') throw new FinancialPolicyClientError('input');
      targetId('draft'); const observation = ready(); if (!observation.context.draftScope) throw new FinancialPolicyClientError('unavailable');
      const value = reviewFinancialPolicyDraft(view.buffer.dates, observation.context.draftScope, selectedDocument(), displayNow!());
      const review: Review = { kind: 'save_draft', dates: value.dates, input: { schemaVersion: 1, previous: previous('draft'), organizationEpoch: observation.context.scope.organizationEpoch, draft: value.draft } };
      requestFor(review, 'local_review_placeholder');
      publish({ ...view, review, message: 'Exact draft boundaries reviewed locally. Check the selected current policy text and preparation before saving.' });
    }); },
    prepare() { return run('Checking exact action preparation…', async check => {
      writer.invalidateReview(); publish({ ...view, unsent: null }); ready(); const review = view.review;
      if (!review) throw new FinancialPolicyAuthoringInputError(view.buffer.kind === 'document' ? 'policy-text' : 'draft-start', 'Review the exact local input before checking preparation.');
      const request = requestFor(review, 'local_review_placeholder');
      const selection = request.kind === 'save_document' ? { schemaVersion: 1, action: request.kind, targetId: request.id, previous: request.input.previous, purpose: request.input.purpose }
        : { schemaVersion: 1, action: request.kind, targetId: request.id, previous: request.input.previous, document: selectedDocument() };
      const result = await preparation.prepare(preparation.issue(selection)); check(); ready();
      if (view.review !== review) throw new FinancialPolicyClientError('scope');
      publish({ ...view, preparation: preparation.getSnapshot(), message: result.response.decision.state === 'reviewable'
        ? 'Preparation checked. Read the exact text, terms and dates; saving remains a separate action.' : 'This action is not ready to save. Read its preparation reasons.' });
    }); },
    save() { return view.unsent ? Promise.resolve() : run('Saving the exact reviewed configuration…', check => sendReviewed(check, null)); },
    continueOriginalSave() {
      const original = view.unsent;
      return original ? run('Continuing the exact original save…', check => sendReviewed(check, original)) : Promise.resolve();
    },
    useDocumentReceipt(receipt: FinancialPolicyQualifiedReceipt) {
      local(() => {
        if (receipt.record.kind !== 'document' || receipt.record.purpose !== 'financial_mandate' || receipt.responsibilityId !== bootstrap.responsibilityId ||
          !(view.receipt === receipt || view.rows.some(row => row.receipt === receipt))) throw new FinancialPolicyClientError('input');
        const { id, version, recordHash } = receipt.target;
        publish({ ...view, buffer: { ...view.buffer, kind: 'draft', document: { id, version: String(version), recordHash } }, exact: null,
          message: 'The saved document reference is selected. A fresh preparation must hydrate its current full text before draft saving.' });
      });
    },
    refreshReferences() { local(() => { rows(); publish({ ...view, message: 'This tab’s original references were refreshed. No request was sent.' }); }); },
    lookup(reference: FinancialPolicyReference) { return run('Checking the original result…', async check => {
      invalidateReview(); ready();
      if (!view.rows.some(row => financialSame(row.reference, reference))) throw new FinancialPolicyClientError('input');
      updateRow(reference, { state: 'checking', message: 'Checking this original result…' });
      try {
        const response = await transport.lookup(reference, lifetime.authorize('lookup', reference)); check(); ready(); arm(response.observation.expiresAt);
        const receipt = memory.recorded(reference) ?? view.rows.find(row => financialSame(row.reference, reference))?.receipt ?? null;
        updateRow(reference, { state: receipt ? 'recorded' : 'not-recorded', receipt, message: receipt ? 'Matching immutable original receipt recorded.' : 'No result was returned. This does not cancel or fail the original request.' });
        publish({ ...view, message: receipt ? 'Original result recorded. The reminder can be cleared separately.' : 'The original result remains unconfirmed. No replacement was created.' });
      } catch (error) { check(); updateRow(reference, { state: 'unconfirmed', message: 'The original check could not be confirmed. Its reminder is preserved.' }); throw error; }
    }); },
    clear(reference: FinancialPolicyReference) { return run('Clearing this tab’s exact reminder…', async check => {
      invalidateReview(); ready(); const row = view.rows.find(value => financialSame(value.reference, reference));
      if (!row?.receipt || row.state === 'cleared') throw new FinancialPolicyClientError('input');
      updateRow(reference, { state: 'clearing' });
      try { await clearFinancialPolicyReminder(adapters.storage(), reference, row.receipt, () => { check(); ready(); return true; }); }
      catch (error) { check(); ready(); throw error; }
      check(); ready(); updateRow(reference, { state: 'cleared', message: 'Only this tab’s matching reminder was cleared. No server operation was cancelled.' });
      publish({ ...view, message: 'Exact local reminder cleared. Review and prepare again before any new save.' });
    }); },
    close() { suspend(); closed = true; replacing = true; unlistenPreparation(); writer.close(); preparation.close(); transport.dispose(); memory.close(); lifetime.close(); listeners.clear(); },
  };
}
export type FinancialPolicyAuthoringController = ReturnType<typeof createFinancialPolicyAuthoringController>;

/** Opening local editing once never replaces fresh context or action preparation. */
export function FinancialPolicyAuthoringEditorGate({ controller, owner, view, children }: {
  controller: FinancialPolicyAuthoringController; owner: FinancialPolicyAuthoringAdapters; view: View; children: ReactNode;
}) {
  return controller.matches(owner) && controller.current() && view === controller.getSnapshot() && view.visible && view.editorOpened && view.phase !== 'denied'
    ? <>{children}</> : null;
}

/** A deliberate navigation gesture only; it never checks, clears or resends an original. */
export function focusFinancialPolicySavedRequests(controller: FinancialPolicyAuthoringController, owner: FinancialPolicyAuthoringAdapters,
  target: Pick<HTMLElement, 'focus' | 'scrollIntoView'> | null,
  motion: { mode: 'normal' | 'reduced' | 'off'; keyboard: boolean; prefersReducedMotion: boolean }) {
  if (!target || !controller.matches(owner) || controller.getSnapshot().busy || !controller.hasVisibleOriginal()) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start', behavior: motion.mode !== 'normal' || motion.keyboard || motion.prefersReducedMotion ? 'instant' : 'smooth' });
}

export function FinancialPolicyAuthoringWorkspaceView(props: FinancialPolicyAuthoringAdapters) {
  const revision = captureRevision(props.revision);
  const latest = useRef(props); latest.current = props;
  const controllerRef = useRef<FinancialPolicyAuthoringController | null>(null);
  const [controller] = useState(() => createFinancialPolicyAuthoringController(props, () => Boolean(controllerRef.current?.matches(latest.current)) && !document.hidden));
  controllerRef.current = controller;
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot), motion = useMotion();
  const feedback = useRef<HTMLDivElement>(null), lastFocus = useRef(0), arrival = useArrival(view.context !== null);
  const savedRequests = useRef<HTMLDivElement>(null);
  const [showPending, setShowPending] = useState(false), key = financialPolicyBootstrapKey(props.bootstrap), revisionKey = JSON.stringify(revision);
  const displayExpired = view.context !== null && !controller.fresh(), scopeLost = view.visible && !controller.current();
  useLayoutEffect(() => {
    controller.configure(props);
    const visibility = () => document.hidden ? controller.suspend() : controller.activate();
    visibility(); document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); controller.suspend(); };
  }, [controller, key, revisionKey, props.currentBootstrap, props.getToken, props.fetch, props.storage, props.wall, props.monotonic, props.createKey, props.createTargetId]);
  useLayoutEffect(() => {
    if (view.visible && view.focus > lastFocus.current && controller.current()) {
      lastFocus.current = view.focus;
      const field = view.error ? document.getElementById(view.error.field) : null;
      (field ?? feedback.current)?.focus({ preventScroll: true });
    }
  }, [controller, view.focus, view.visible, view.error]);
  useLayoutEffect(() => { if (displayExpired) controller.expireDisplay(); }, [controller, displayExpired]);
  useLayoutEffect(() => { if (scopeLost) controller.suspend(); }, [controller, scopeLost]);
  useEffect(() => { if (!view.busy) { setShowPending(false); return; } const timer = setTimeout(() => setShowPending(true), 200); return () => clearTimeout(timer); }, [view.busy]);
  if (typeof document !== 'undefined' && document.hidden) return null;
  const safe = controller.matches(props) && view.visible && controller.current(), context = safe && !displayExpired ? view.context : null;
  const buffer = safe ? view.buffer : emptyBuffer(revision), disabled = !safe || view.busy || view.phase === 'denied';
  const review = context ? view.review : null, prepared = context && controller.preparationFresh() ? view.preparation.preparation : null;
  const draftReview: DraftReview | null = review?.kind === 'save_draft' ? { draft: review.input.draft, dates: review.dates } : null;
  const visibleOriginal = Boolean(context && controller.hasVisibleOriginal());
  const saveReady = Boolean(context && review && prepared && view.preparation.state === 'reviewable' && !visibleOriginal);
  const continueReady = Boolean(context && review && prepared && view.preparation.state === 'reviewable' && view.unsent && visibleOriginal);
  const continuing = Boolean(safe && view.unsent);
  return <div className="financial-policy financial-authoring" data-financial-motion={motion.mode} data-financial-pending={safe && view.busy ? 'true' : 'false'}>
    <PageHeading title={props.revision ? 'Review a configuration revision' : 'Prepare financial configuration'} description="Save full policy text, then prepare and save an incomplete draft separately."
      action={<ButtonLink href={financialPolicyCollectionPath(props.bootstrap.responsibilityId)} secondary>Back to financial policies</ButtonLink>}/>
    <Panel title="Current access" action={<button type="button" className="button secondary" disabled={disabled} onClick={() => void controller.refresh()}>
      <ActionLabel label={view.busy && !context ? 'Checking context…' : 'Check current context'} reserve={['Checking context…', 'Check current context']}/></button>}>
      <div ref={feedback} tabIndex={-1} className="financial-policy-feedback"><span className="financial-policy-feedback-mark" aria-hidden="true">
        {safe && view.busy && showPending && motion.mode !== 'off' ? <BrandLoader/> : <span className="financial-policy-feedback-dot"/>}</span>
        <p id="financial-authoring-feedback" role="status" aria-live="polite">{displayExpired ? expiredMessage : safe ? view.message : 'Opening the current authoring scope. No request has been sent.'}</p></div>
      <p className="review-note">Configuration only. No spending authority or available funds are created.</p>
      {safe && !view.editorOpened && view.phase !== 'denied' && <p className="review-note">Check current financial access to open the editor.</p>}
    </Panel>
    <FinancialPolicyAuthoringEditorGate controller={controller} owner={props} view={view}>
      <Panel title="Choose the record">
        {props.revision ? <label htmlFor="revision-kind">Record type<select id="revision-kind" value={buffer.kind} disabled={disabled} aria-invalid={view.error?.field === 'revision-kind'} aria-describedby={view.error?.field === 'revision-kind' ? 'financial-authoring-feedback' : undefined} onChange={e => controller.edit({ kind: e.target.value as Kind })}>
          <option value="document">Policy text</option><option value="draft">Incomplete draft</option></select></label>
          : <div id="authoring-start" tabIndex={-1} className="actions"><button type="button" className="button secondary" disabled={disabled || !context} onClick={() => controller.startNew('document')}>
            {buffer.documentId ? 'Continue policy text' : 'Start new policy text'}</button>
            <button type="button" className="button secondary" disabled={disabled || !context} onClick={() => controller.startNew('draft')}>{buffer.draftId ? 'Continue draft' : 'Start new draft'}</button></div>}
        <p className="review-note">{buffer.kind === 'document' ? 'Policy text' : 'Draft'} record: <code>{(buffer.kind === 'document' ? buffer.documentId : buffer.draftId) || 'Not started'}</code></p>
        <p className="review-note">Starting chooses a record once. A conflict never silently replaces it or a selected previous version.</p>
        {props.revision && <><p>Requested version {props.revision.version}. The record type must match this exact version.</p>
          <button type="button" className="button secondary" disabled={disabled || !context} onClick={() => void controller.readRevision()}>Read exact previous version</button>
          {context && view.exact && <FinancialPolicyReview response={view.exact}/>}</>}
      </Panel>
      <Panel title={buffer.kind === 'document' ? '1. Review the full policy text' : '2. Review the incomplete draft'}>
        {buffer.kind === 'document' ? <FinancialPolicyDocumentEditor text={buffer.text} disabled={disabled} reviewed={review?.kind === 'save_document' ? review.input.text : null}
          error={view.error?.field === 'policy-text' ? view.error.message : null} onChange={text => controller.edit({ text })} onReview={() => controller.reviewDocument()}/>
          : <><section id="draft-document-id" tabIndex={-1} aria-label="Select existing policy text">
            <h3>Choose the policy text</h3><button type="button" className="button secondary" disabled={disabled || !context} onClick={() => void controller.indexDocuments()}>Find policy text in saved drafts</button>
            {context && view.index && <div className="financial-authoring-document-options">{view.index.items.flatMap(item => item.policy.record.kind === 'draft' ? item.policy.record.draft.documents.map(doc =>
              <article key={`${item.policy.reference.id}:${doc.id}:${doc.version}`}><p>Policy text in draft {item.policy.reference.id} · version {doc.version}</p>
                <button type="button" className="button secondary" disabled={disabled} onClick={() => void controller.readDocument({ id: doc.id, version: doc.version, recordHash: doc.recordHash })}>Read this exact policy text</button></article>) : [])}
              {view.index.items.length === 0 && <p>No saved drafts were returned. Save policy text first or check a saved original receipt below.</p>}
              {view.index.nextId && <button type="button" className="button secondary" disabled={disabled} onClick={() => void controller.indexDocuments(view.index!.nextId)}>Read next draft page</button>}
            </div>}
            {context && view.context?.documents.map(doc => <button key={`${doc.reference.id}:${doc.reference.version}`} type="button" className="button secondary" disabled={disabled}
              onClick={() => void controller.readDocument(doc.reference)}>Read checked context policy text · version {doc.reference.version}</button>)}
            {context && view.documentRead && <><FinancialPolicyReview response={view.documentRead}/><button type="button" className="button secondary" disabled={disabled} onClick={() => controller.selectReadDocument()}>Select this exact policy text</button></>}
            {context && view.rows.filter(row => row.receipt?.record.kind === 'document').map(row => <button key={row.reference.locator.key} type="button" className="button secondary" disabled={disabled}
              onClick={() => controller.useDocumentReceipt(row.receipt!)}>Select saved policy text · version {row.receipt!.target.version}</button>)}
            <dl className="financial-policy-facts"><div><dt>Selected policy text</dt><dd>{buffer.document.id ? <>{buffer.document.id} · version {buffer.document.version}<code>{buffer.document.recordHash}</code></> : 'No text selected'}</dd></div></dl>
          </section>
            <p className="review-note">A checked record or saved receipt selects an exact document. Fresh preparation still checks and displays its current full text before a draft save.</p>
            <FinancialPolicyDraftEditor dates={buffer.dates} disabled={disabled} reviewed={draftReview} error={view.error?.field.startsWith('draft-') ? view.error : null}
              onChange={dates => controller.edit({ dates })} onReview={() => controller.reviewDraft()}/></>}
      </Panel>
      <div ref={arrival} className="financial-authoring-preparation-shell"><h2>Review and save separately</h2></div>
      <Panel title="Check the selected action">
        <button type="button" className="button secondary" disabled={disabled || !context || !review} onClick={() => void controller.prepare()}>
          <ActionLabel label={view.preparation.state === 'checking' ? 'Checking preparation…' : 'Check preparation'} reserve={['Checking preparation…', 'Check preparation']}/></button>
        <p className="review-note">Preparation details appear below the save controls. These controls keep their position when the result arrives.</p>
      </Panel>
      <Panel title="Final save"><div className="financial-authoring-save-slot"><p>Save only after reviewing your exact input and the checked preparation below.</p>
        <button type="button" className="button" disabled={disabled || !(continuing ? continueReady : saveReady)} aria-describedby={visibleOriginal ? 'financial-authoring-original-notice' : undefined}
          onClick={() => void (continuing ? controller.continueOriginalSave() : controller.save())}>
          <ActionLabel label={continuing ? view.busy ? 'Continuing original…' : 'Continue original save'
            : view.busy && saveReady ? 'Saving configuration…' : buffer.kind === 'document' ? 'Save policy text' : 'Save draft'}
            reserve={['Saving configuration…', 'Save policy text', 'Save draft', 'Continuing original…', 'Continue original save']}/></button>
      </div>{visibleOriginal && <div>
        <p id="financial-authoring-original-notice" className="review-note" role="status">{view.unsent
          ? 'This tab retained the exact original and confirmed it was not sent. Continue original save reuses its record, request key and reviewed input. Editing, checking other material, expiry or leaving this context removes that continuation.'
          : 'An earlier request for this record needs review before another save. In Saved financial requests, check the original result and review its matching receipt. Then clear this tab’s reminder separately, review your edits and check fresh preparation before saving.'}</p>
        <button type="button" className="button secondary" disabled={disabled} aria-controls="financial-authoring-saved-requests"
          onClick={() => focusFinancialPolicySavedRequests(controller, props, savedRequests.current, { mode: motion.mode, keyboard: motion.keyboard.current,
            prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches })}>Go to saved financial requests</button>
      </div>}</Panel>
      {prepared ? <FinancialPolicyPreparationReview response={prepared.response}/> : <p className="review-note">No current preparation is available. Nothing can be saved until your exact action is checked.</p>}
      {context && view.receipt && <Panel title="Immutable original result"><FinancialPolicyReceiptReview receipt={view.receipt}/>
        {view.receipt.record.kind === 'document' && !props.revision && <button type="button" className="button secondary" disabled={disabled}
          onClick={() => { controller.startNew('draft'); controller.useDocumentReceipt(view.receipt!); }}>{buffer.draftId ? 'Continue draft with this policy text' : 'Start draft with this policy text'}</button>}
      </Panel>}
      {context && <div id="financial-authoring-saved-requests" ref={savedRequests} tabIndex={-1} role="region" aria-label="Saved financial requests">
        <FinancialPolicyRecoveryPanel rows={view.rows} blocked={view.storageBlocked} busy={view.busy} onRefresh={() => controller.refreshReferences()}
          onLookup={reference => void controller.lookup(reference)} onClear={reference => void controller.clear(reference)}/></div>}
    </FinancialPolicyAuthoringEditorGate>
  </div>;
}

/** Explicit native responsibility acquisition. No automatic policy preparation, context read or save. */
export function FinancialPolicyAuthoringWorkspace({ id, policyId, version, revisionKind }: { id: string; policyId?: string; version?: string; revisionKind?: Kind }) {
  const { session, getToken: workspaceToken } = useWorkspace(), auth = useAuth();
  const allowed = IdSchema.safeParse(id).success && auth.isLoaded && auth.isSignedIn && Boolean(auth.userId && auth.orgId && auth.sessionId) &&
    session.actor.sessionId === auth.sessionId && session.actor.principalKind === 'human' && session.actor.environment === 'development' &&
    session.actor.roles.some(role => ['owner', 'finance', 'operations'].includes(role));
  const query = useQuery({ queryKey: ['responsibility', id], enabled: false, queryFn: ({ signal }) => apiRequest(`/v1/responsibilities/${encodeURIComponent(id)}`,
    scopedResponsibilitySchema(session).refine(record => record.id === id), workspaceToken, { signal }), retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const latest = useRef({ session, auth, record: query.data, error: query.isError }); latest.current = { session, auth, record: query.data, error: query.isError };
  const currentBootstrap = useCallback(() => { const value = latest.current; try {
    if (!value.record || value.error) return null; return createFinancialPolicyBootstrap(value.session, value.auth, getApiBase(), value.record, id);
  } catch { return null; } }, [id]);
  const getToken = useCallback((options: { organizationId: string; skipCache: true }) => auth.getToken(options), [auth.getToken]);
  const fetcher = useCallback((url: string, init: RequestInit) => fetch(url, init), []), storage = useCallback((): FinancialPolicyStorage | null => browserRecoveryStorage(), []);
  const parsedVersion = version !== undefined && /^[1-9]\d*$/.test(version) ? FinancialPolicyVersionSchema.safeParse(Number(version)) : null;
  const kindValid = revisionKind === undefined || (revisionKind === 'document' || revisionKind === 'draft') && policyId !== undefined && version !== undefined;
  if (!allowed || !kindValid || (policyId !== undefined || version !== undefined) && (!policyId || !IdSchema.safeParse(policyId).success || !parsedVersion?.success))
    return <Alert title="Configuration preparation unavailable"><p>A valid development route and current scoped owner, finance or Operations access are required.</p></Alert>;
  const bootstrap = currentBootstrap();
  if (!bootstrap) return <><PageHeading title="Prepare financial configuration"/><Panel title="Responsibility access">
    <p className="review-note">Check this responsibility before opening its financial-policy authoring context.</p>
    {query.isFetching ? <LoadingState label="Checking responsibility access"/> : <button type="button" className="button secondary" onClick={() => void query.refetch()}>Check responsibility access</button>}
    {query.isError && <p role="status">Current responsibility access could not be verified. No preparation or save was sent.</p>}
  </Panel></>;
  return <FinancialPolicyAuthoringWorkspaceView bootstrap={bootstrap} currentBootstrap={currentBootstrap} getToken={getToken} fetch={fetcher} storage={storage}
    revision={policyId && parsedVersion?.success ? { id: policyId, version: parsedVersion.data, kind: revisionKind ?? 'draft' } : null}/>;
}
