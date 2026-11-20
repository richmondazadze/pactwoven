'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { IdSchema, MandateReviewQuerySchema, type MandateDocumentRead, type MandatePage, type MandateReview } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { RequestError } from '../lib/api';
import { authoringAvailable, authoringBasisMatches, authoringRevisionAvailable, createAuthoringManifest, createDocumentAuthoringCapsule, createProposalAuthoringCapsule, normalizeAuthoringText, parseAuthoringUtc, selectionFromDocument, type MandateAuthoringCapsule } from '../lib/mandate-authoring';
import { currentAuthoringCheckpoint, locatorFromAuthoringCapsule, replaceAuthoringPreparation, selectAuthoringDocument, storeAuthoringManifest, type AuthoringManifest } from '../lib/mandate-authoring-recovery';
import { readAuthoringReceipt, sendAuthoringAttempt, type AuthoringCompletion, type AuthoringTransportContext } from '../lib/mandate-authoring-transport';
import { readMandateDocument } from '../lib/mandate-document-reads';
import { mandateOperationSucceeded } from '../lib/mandate-actions';
import { mandateRecoveryScope } from '../lib/mandate-recovery';
import { mandateCollectionHref, mandateObservationTime, mandateProposalHref, mandateScopeKey, readMandatePage, readMandateReview, type MandateObservation, type MandateReadScope } from '../lib/mandates';
import { MandateCurrentAuthority, MandateReadFailure, useMandateClock, useMandateReadPrivacy, useMandateRouteScope, useMandateScopeLifetime } from './mandate-read-shared';
import { useMandateAuthoringMemory } from './mandate-authoring-memory';
import { useMandateRecoveryMemory } from './mandate-recovery-memory';
import { MandateDocumentEditor } from './mandate-document-editor';
import { MandateProposalEditor } from './mandate-proposal-editor';
import { MandateAuthoringRecoveryPanel } from './mandate-authoring-recovery-panel';
import { ActionLabel, Alert, ButtonLink, LoadingState, PageHeading, Panel, StatusBadge } from './ui';
import { useArrival, useMotion } from './motion';
import { revealAccessTarget } from '../lib/access-viewport';

type Stage = 'acceptance' | 'policy' | 'proposal';
type Revision = { proposalId: string; version: number };
type Loaded = { page: MandateObservation<MandatePage>; revision: MandateReview | null; matches: boolean };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function MandateAuthoringWorkspace({ responsibilityId, revision }: { responsibilityId: string; revision?: { proposalId: string; version: string } | undefined }) {
  const route = useMandateRouteScope(responsibilityId);
  if (!route.scope) return <MandateReadFailure error={route.error}/>;
  const version = revision ? MandateReviewQuerySchema.safeParse({ version: revision.version }) : null;
  if (revision && (!IdSchema.safeParse(revision.proposalId).success || !version?.success)) return <MandateReadFailure error={new RequestError('INVALID_REVIEW_ROUTE', 'Open an exact proposal version from the mandate collection.')} responsibilityId={responsibilityId}/>;
  const selected = revision && version?.success ? { proposalId: revision.proposalId, version: version.data.version } : null;
  return <ScopedAuthoringWorkspace key={`${mandateScopeKey(route.scope)}:${selected?.proposalId ?? 'new'}:${selected?.version ?? 0}`} scope={route.scope} routeRevision={selected}/>;
}
function ScopedAuthoringWorkspace({ scope, routeRevision }: { scope: MandateReadScope; routeRevision: Revision | null }) {
  const router = useRouter(), auth = useAuth(), client = useQueryClient(), memory = useMandateAuthoringMemory(), c1 = useMandateRecoveryMemory(), current = useMandateScopeLifetime(scope);
  const memoryRef = useRef(memory); memoryRef.current = memory;
  const [readError, setReadError] = useState<unknown>(null), denied = useMandateReadPrivacy(readError);
  const [stage, setStage] = useState<Stage>('acceptance'), [policyText, setPolicyText] = useState(''), [dates, setDates] = useState({ policy: '', review: '' }), [capsule, setCapsule] = useState<MandateAuthoringCapsule | null>(null), [documents, setDocuments] = useState<{ acceptance: MandateDocumentRead | null; policy: MandateDocumentRead | null }>({ acceptance: null, policy: null });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failure, setFailure] = useState(false), [completion, setCompletion] = useState<AuthoringCompletion | null>(null), [, tick] = useState(0);
  const [statusFocusRequest, setStatusFocusRequest] = useState(0), [stageFocusRequest, setStageFocusRequest] = useState(0), pendingStatusFocus = useRef(false), { mode, keyboard } = useMotion();
  const running = useRef(false), alive = useRef(false), controller = useRef<AbortController | null>(null), statusFocus = useRef<HTMLDivElement>(null), stageFocus = useRef<HTMLDivElement>(null), arrival = useArrival(stage, 120);
  const manifest = memory.inventory.manifests.find(item => item.responsibilityId === scope.responsibilityId) ?? null;
  const selectedRevision = routeRevision ?? (manifest?.mode.kind === 'revise' ? { proposalId: manifest.mode.proposal.id, version: manifest.mode.proposal.version } : null);
  const queryKey = ['mandates', mandateScopeKey(scope), 'authoring', manifest?.preparationId ?? 'none', selectedRevision?.proposalId ?? '', selectedRevision?.version ?? 0] as const;
  const getToken = () => auth.getToken({ skipCache: true, organizationId: scope.externalOrganizationId });
  function assertCurrent(signal: AbortSignal) { signal.throwIfAborted(); if (!alive.current || !same(current.current, scope)) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The current authoring scope changed.', 403); }
  async function load(signal: AbortSignal): Promise<Loaded> {
    const [page, review] = await Promise.all([readMandatePage(scope, () => current.current, signal, getToken), selectedRevision ? readMandateReview(scope, () => current.current, signal, getToken, selectedRevision.proposalId, selectedRevision.version) : Promise.resolve(null)]);
    const matches = !manifest || await authoringBasisMatches(manifest, page.data); signal.throwIfAborted(); if (!same(current.current, scope)) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The current preparation scope changed.', 403);
    return { page, revision: review?.data ?? null, matches };
  }
  const query = useQuery({ queryKey, queryFn: async ({ signal }) => { try { return await load(signal); } catch (error) { if (!signal.aborted) setReadError(error); throw error; } }, enabled: memory.ready && !denied && !memory.hidden, retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const now = useMandateClock(capsule?.observation ?? query.data?.page);
  const deadline = capsule?.kind === 'proposal' ? Math.min(Date.parse(capsule.command.expiresAt), Date.parse(capsule.command.policy.expiresAt)) : Infinity;
  useEffect(() => { if (!Number.isFinite(deadline) || deadline <= now) return; const timer = setTimeout(() => tick(n => n + 1), Math.min(2_147_483_647, Math.max(1, deadline - now))); return () => clearTimeout(timer); }, [deadline, now]);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); try { memoryRef.current.select(null); } catch { /* Scope cleanup already removed private selection. */ } }; }, []);
  const reveal = useEffectEvent((target: HTMLElement | null) => { if (!memory.hidden && !denied && !document.hidden) revealAccessTarget(target, { mode, keyboard: keyboard.current, prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches, hidden: document.hidden }); });
  useLayoutEffect(() => { if (stageFocusRequest) reveal(stageFocus.current); }, [stageFocusRequest]);
  useLayoutEffect(() => {
    if (!pendingStatusFocus.current || busy || !message) return;
    pendingStatusFocus.current = false; reveal(statusFocus.current);
  }, [statusFocusRequest, busy, message]);
  function requestStatusFocus() { if (!pendingStatusFocus.current) { pendingStatusFocus.current = true; setStatusFocusRequest(value => value + 1); } }
  function chooseStage(value: Stage) { setStage(value); setStageFocusRequest(request => request + 1); }
  useLayoutEffect(() => { if (memory.hidden || denied) { pendingStatusFocus.current = false; controller.current?.abort(); setCapsule(null); setPolicyText(''); setDates({ policy: '', review: '' }); setDocuments({ acceptance: null, policy: null }); setCompletion(null); } }, [memory.hidden, Boolean(denied)]);
  function context(signal: AbortSignal): AuthoringTransportContext { const m = memoryRef.current; return { current: () => current.current, getToken, signal, storage: m.storage, work: m.work, selected: m.selected, recorded: m.recorded, onRecorded: m.onRecorded, onPending: m.onPending, onQualified: m.onQualified }; }
  function fail(error: unknown) { if (!alive.current) return; if (error instanceof RequestError && [401, 403].includes(error.status)) setReadError(error); setFailure(true); setMessage(error instanceof RequestError ? error.message : 'Check the required values and the original saved reference before continuing. No outcome has been assumed.'); requestStatusFocus(); }
  async function run(action: (signal: AbortSignal) => Promise<void>, focusResult = true) {
    if (running.current || denied || memory.hidden) return; running.current = true; pendingStatusFocus.current = false; setBusy(true); setMessage(''); setFailure(false); const request = new AbortController(); controller.current = request;
    let failed = false;
    try { await action(request.signal); }
    catch (error) { failed = true; if (!request.signal.aborted) fail(error); }
    finally { running.current = false; try { memoryRef.current.reload(); } catch { /* A denied scope stays hidden. */ } if (alive.current) { setBusy(false); if (focusResult || failed) requestStatusFocus(); } }
  }
  async function fresh(signal: AbortSignal) { const loaded = await load(signal); if (!alive.current || !same(current.current, scope)) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The current authoring scope changed.', 403); client.setQueryData(queryKey, loaded); return loaded; }
  function unprepare() { pendingStatusFocus.current = false; setCapsule(null); memory.select(null); setMessage(''); }
  function start(forceNew = false) { void run(async signal => {
    const loaded = forceNew ? { page: await readMandatePage(scope, () => current.current, signal, getToken), revision: null, matches: false } : await fresh(signal), proposal = loaded.revision?.envelope.proposal, preparationId = crypto.randomUUID();
    assertCurrent(signal); const site = loaded.page.data.responsibility.siteId, reuseRevision = proposal?.responsibility.siteId === site, reusePreparation = !proposal && manifest?.basis.responsibility.siteId === site;
    // A distinct preparation can reuse an ID only when its retained checkpoints
    // still provide the exact predecessor after the old revision mode is cleared.
    const retainedDocumentId = (step: 'acceptance' | 'policy', id: string | undefined) => reusePreparation && manifest!.completed.some(item => item.locator.step === step && item.reference.id === id) ? id! : crypto.randomUUID();
    const ids = { acceptanceDocumentId: reuseRevision ? proposal!.policy.acceptancePolicy.id : retainedDocumentId('acceptance', manifest?.ids.acceptanceDocumentId), policyDocumentId: reuseRevision ? proposal!.policyDocument.id : retainedDocumentId('policy', manifest?.ids.policyDocumentId), proposalId: proposal?.id ?? crypto.randomUUID(), mandateId: loaded.page.data.acceptedVersion?.id ?? proposal?.mandateId ?? crypto.randomUUID() };
    const ticket = memory.work.acquire({ scope: mandateRecoveryScope(scope), responsibilityId: scope.responsibilityId, targetId: ids.proposalId, key: preparationId, kind: 'proposal', action: 'prepare' });
    try { const value = await createAuthoringManifest(scope, loaded.page, preparationId, ids, mandateObservationTime(loaded.page.data.observedAt, loaded.page), loaded.revision); assertCurrent(signal); memory.work.assert(ticket); if (manifest) replaceAuthoringPreparation(memory.storage(), manifest, value); else storeAuthoringManifest(memory.storage(), value); }
    finally { memory.work.release(ticket); }
    unprepare(); setDocuments({ acceptance: null, policy: null }); setPolicyText(''); setCompletion(null); setDates({ policy: proposal?.policy.expiresAt.slice(0, 19) ?? '', review: proposal?.expiresAt.slice(0, 19) ?? '' }); setStage('acceptance'); setMessage('Current context is pinned. Review each document before its separate save.'); if (forceNew && routeRevision) router.replace(`${mandateCollectionHref(scope.responsibilityId)}/prepare`);
  }); }
  function candidate(step: 'acceptance' | 'policy') {
    if (!manifest) return null; const selected = manifest.documents[step]; if (selected) return selected.reference;
    const id = step === 'acceptance' ? manifest.ids.acceptanceDocumentId : manifest.ids.policyDocumentId;
    const previous = manifest.completed.filter(item => item.locator.step === step && item.reference.id === id).sort((a, b) => b.reference.version - a.reference.version)[0];
    if (previous) return previous.reference;
    const proposal = query.data?.revision?.envelope.proposal, reference = step === 'acceptance' ? proposal?.policy.acceptancePolicy : proposal?.policyDocument;
    return reference?.id === id ? reference : null;
  }
  function readSaved(step: 'acceptance' | 'policy') { const reference = candidate(step); if (!manifest || !reference) return; void run(async signal => {
    const result = await readMandateDocument(scope, () => current.current, signal, getToken, reference, step === 'acceptance' ? 'ACCEPTANCE_POLICY' : 'MANDATE_POLICY'), selection = selectionFromDocument(result.data);
    assertCurrent(signal); const selected = manifest.documents[step]; if (selected && !same(selected, selection)) throw new RequestError('MANDATE_DOCUMENT_UNVERIFIED', 'The saved document differs from this preparation’s original reference.');
    if (!selected) selectAuthoringDocument(memory.storage(), manifest, selection);
    setDocuments(values => ({ ...values, [step]: result.data })); setMessage('The complete saved text and original save receipt are verified. Review its use against the current responsibility.');
  }); }
  function prepareDocument(step: 'acceptance' | 'policy') { if (!manifest) return; const text = step === 'acceptance' ? normalizeAuthoringText(query.data!.page.data.responsibility.acceptancePolicy) : policyText; void run(async signal => {
    const loaded = await fresh(signal), key = crypto.randomUUID(), ticket = memory.work.acquire({ scope: mandateRecoveryScope(scope), responsibilityId: scope.responsibilityId, targetId: step === 'acceptance' ? manifest.ids.acceptanceDocumentId : manifest.ids.policyDocumentId, key, kind: 'document', action: 'prepare' });
    try { const value = await createDocumentAuthoringCapsule(scope, manifest, loaded.page, step === 'acceptance' ? 'ACCEPTANCE_POLICY' : 'MANDATE_POLICY', text, key, mandateObservationTime(loaded.page.data.observedAt, loaded.page), documents[step], loaded.revision); assertCurrent(signal); memory.work.assert(ticket); memory.select(value); setCapsule(value); } finally { memory.work.release(ticket); }
  }, false); }
  function prepareProposal() { if (!manifest || !documents.acceptance || !documents.policy) return; const inputDates = { ...dates }, saved = [documents.acceptance, documents.policy] as [MandateDocumentRead, MandateDocumentRead]; void run(async signal => {
    const loaded = await fresh(signal), key = crypto.randomUUID(), ticket = memory.work.acquire({ scope: mandateRecoveryScope(scope), responsibilityId: scope.responsibilityId, targetId: manifest.ids.proposalId, key, kind: 'proposal', action: 'prepare' });
    try { const value = await createProposalAuthoringCapsule(scope, manifest, loaded.page, saved, { policyExpiresAt: parseAuthoringUtc(inputDates.policy), proposalExpiresAt: parseAuthoringUtc(inputDates.review) }, key, mandateObservationTime(loaded.page.data.observedAt, loaded.page), loaded.revision); assertCurrent(signal); memory.work.assert(ticket); memory.select(value); setCapsule(value); } finally { memory.work.release(ticket); }
  }, false); }
  function completed(value: AuthoringCompletion) {
    if (!alive.current) return; setCompletion(value); setCapsule(null); memory.select(null); memory.reload(); setFailure(false);
    if ('document' in value.record) { const step = value.record.document.purpose === 'ACCEPTANCE_POLICY' ? 'acceptance' : 'policy'; setDocuments(records => ({ ...records, [step]: value.record as MandateDocumentRead })); setMessage('Document saved and verified. Continue only when you are ready.'); }
    else setMessage(`Proposal version ${value.record.envelope.proposal!.version} is recorded. Its current decision is ${value.record.envelope.decision!.state.toLowerCase()}. Accepted authority remains a separate observation.`);
    requestStatusFocus();
  }
  function send() { if (!capsule) return; const original = capsule; void run(async signal => { const c = context(signal), result = await sendAuthoringAttempt(original, c, { kind: 'first', now: () => mandateObservationTime(original.observation.data.observedAt, original.observation) }); if (mandateOperationSucceeded(result)) completed(await readAuthoringReceipt(locatorFromAuthoringCapsule(original), result, scope, c, original)); else setMessage('The original request has no confirmed terminal result. Check it before continuing.'); }); }
  const pending = manifest?.pending, proposalCheckpoint = manifest ? currentAuthoringCheckpoint(manifest, 'proposal') : null;
  const c1Conflict = c1.slot.state === 'blocked' || (c1.slot.state === 'pending' && c1.slot.locator.responsibilityId === scope.responsibilityId);
  const routeMatches = !routeRevision || (manifest?.mode.kind === 'revise' && manifest.mode.proposal.id === routeRevision.proposalId && manifest.mode.proposal.version === routeRevision.version);
  const revisionAvailable = !selectedRevision || Boolean(query.data?.revision && authoringRevisionAvailable(query.data.revision, scope, now));
  const blocked = memory.inventory.blocked || c1Conflict || Boolean(pending) || !revisionAvailable || (manifest !== null && !routeMatches) || query.data?.matches === false;
  const earlierProposals = manifest?.completed.filter(item => item.locator.step === 'proposal' && item.locator.preparationId !== manifest.preparationId) ?? [];
  const freshReview = !capsule || (authoringAvailable(capsule.observation.data, scope, now) && now < deadline);
  function stepReady(step: 'acceptance' | 'policy') { const doc = documents[step], selection = manifest?.documents[step]; return Boolean(doc && selection && same(selectionFromDocument(doc), selection)); }
  function usable(step: 'acceptance' | 'policy') { const doc = documents[step], page = query.data?.page.data; return Boolean(stepReady(step) && doc && page && doc.savedAgainst.responsibility.siteId === page.responsibility.siteId && (step === 'acceptance' ? doc.document.text === normalizeAuthoringText(page.responsibility.acceptancePolicy) : doc.document.text === normalizeAuthoringText(policyText))); }
  if (denied || memory.hidden) return <MandateReadFailure error={denied ?? new RequestError('MANDATE_SCOPE_CHANGED', 'Current authoring access needs checking.', 403)} responsibilityId={scope.responsibilityId}/>;
  if (!memory.ready) return <LoadingState label="Reading local preparation references"/>;
  if (query.isPending || query.isError || !query.data) return <div className="mandate-connected mandate-authoring"><Link className="back-link" href={mandateCollectionHref(scope.responsibilityId)}>Back to mandate & limits</Link><PageHeading title="Mandate preparation" description="Current context must be read before a new action. Original recovery remains separate."/>{pending && <MandateAuthoringRecoveryPanel key={`${pending.kind}:${pending.key}`} locator={pending} scope={scope} context={context} externalBusy={busy} onComplete={completed} onError={fail}/>}<div ref={statusFocus} tabIndex={-1} className="access-heading-focus">{message && <Alert title={failure ? 'Preparation needs attention' : 'Preparation status'} tone={failure ? 'red' : 'blue'}><p>{message}</p>{failure && (manifest && routeMatches && !pending && !proposalCheckpoint && !query.isError && query.data ? <button className="button secondary" type="button" disabled={busy} onClick={() => setStageFocusRequest(request => request + 1)}>Review current step</button> : <ButtonLink href={mandateCollectionHref(scope.responsibilityId)} secondary>Open mandate context</ButtonLink>)}</Alert>}</div>{proposalCheckpoint && <ButtonLink href={mandateProposalHref(scope.responsibilityId, proposalCheckpoint.reference.id, proposalCheckpoint.reference.version)} secondary>Open recorded proposal version {proposalCheckpoint.reference.version}</ButtonLink>}{query.isPending ? <LoadingState label="Reading current mandate preparation context"/> : <MandateReadFailure error={query.error} responsibilityId={scope.responsibilityId} onRetry={() => void query.refetch()} busy={query.isFetching}/>}</div>;
  const page = query.data.page.data;
  return <div className="mandate-connected mandate-authoring" aria-busy={busy}><Link className="back-link" href={mandateCollectionHref(scope.responsibilityId)}>Back to mandate & limits</Link><PageHeading title={selectedRevision ? 'Revise mandate proposal' : 'Prepare mandate proposal'} description="Save the full documents, then submit exact advice-only terms for independent review." action={<button className="button secondary" type="button" disabled={busy || query.isFetching} onClick={() => { unprepare(); setReadError(null); void query.refetch(); }}><ActionLabel label={query.isFetching ? 'Refreshing context…' : 'Refresh current context'} reserve={['Refresh current context', 'Refreshing context…']}/></button>}/>
    <MandateCurrentAuthority authority={page.effectiveAuthority} head={page.head} observedAt={page.observedAt} now={now} organizationEpoch={scope.organizationEpoch} acceptedVersion={page.acceptedVersion?.version ?? null}/>
    <div ref={statusFocus} tabIndex={-1} className="access-heading-focus">{message && <Alert title={failure ? 'Preparation needs attention' : 'Preparation status'} tone={failure ? 'red' : 'blue'}><p>{message}</p>{failure && (manifest && routeMatches && !pending && !proposalCheckpoint && !query.isError && query.data ? <button className="button secondary" type="button" disabled={busy} onClick={() => setStageFocusRequest(request => request + 1)}>Review current step</button> : <ButtonLink href={mandateCollectionHref(scope.responsibilityId)} secondary>Open mandate context</ButtonLink>)}</Alert>}</div>
    {c1Conflict && <Alert title="An original mandate decision needs checking"><p>Resolve the related decision before preparing a conflicting proposal. Its original check and retry remain available.</p><ButtonLink href={mandateCollectionHref(scope.responsibilityId)} secondary>Open mandate context</ButtonLink></Alert>}
    {memory.inventory.blocked && <Alert title="Local preparation storage needs attention"><p>Existing preparation references cannot be checked. New saves and submissions are blocked.</p><button className="button secondary" type="button" onClick={memory.reload}>Check local references</button></Alert>}
    {pending ? <MandateAuthoringRecoveryPanel key={`${pending.kind}:${pending.key}`} locator={pending} scope={scope} context={context} externalBusy={busy} onComplete={completed} onError={fail}/> : <>{proposalCheckpoint && <Panel title="Proposal reference saved"><p>{completion && 'envelope' in completion.record ? `The exact proposal was verified with decision ${completion.record.envelope.decision!.state.toLowerCase()}.` : 'This preparation has a saved proposal reference. Open its exact record to read the current decision.'} Saving a proposal does not activate authority.</p><ButtonLink href={mandateProposalHref(scope.responsibilityId, proposalCheckpoint.reference.id, proposalCheckpoint.reference.version)}>Open recorded proposal version {proposalCheckpoint.reference.version}</ButtonLink>{manifest?.mode.kind === 'revise' && <p className="review-note"><Link href={mandateProposalHref(scope.responsibilityId, manifest.mode.proposal.id, manifest.mode.proposal.version)}>Read previous proposal version {manifest.mode.proposal.version}</Link></p>}<button className="button secondary" type="button" disabled={busy || c1Conflict || memory.inventory.blocked || !authoringAvailable(page, scope, now)} onClick={() => start(true)}>Start a distinct new proposal</button></Panel>}{(!proposalCheckpoint || !routeMatches) && <>
      {(!manifest || blocked) && <Panel title={manifest ? 'Review a fresh preparation' : 'Pin current responsibility'}><h3>{page.responsibility.title}</h3><p className="review-note">{page.site.name}; responsibility version {page.responsibility.version}. {manifest ? 'Existing saved documents and original references remain recorded. A fresh preparation deliberately pins today’s context.' : 'Starting records local preparation references. It does not save a document or submit a proposal.'}</p>{selectedRevision && <p className="review-note">Only the original requester can version this exact open, unexpired proposal. Stale original responsibility terms can be replaced only through this deliberate current-context review.</p>}{selectedRevision && !revisionAvailable && <p className="review-note">This proposal is not currently eligible for revision. Refresh its current context to check again, or deliberately start a distinct new proposal identity. Confirmed records remain available; no document is saved and no proposal is submitted by starting a preparation.</p>}<button className="button" type="button" disabled={busy || c1Conflict || memory.inventory.blocked || !authoringAvailable(page, scope, now) || !revisionAvailable} onClick={() => start()}><ActionLabel label={busy ? 'Pinning current context…' : manifest ? 'Start fresh preparation' : 'Start preparation'} reserve={['Start fresh preparation', 'Pinning current context…']}/></button>{selectedRevision && !revisionAvailable && !proposalCheckpoint && <button className="button secondary" type="button" disabled={busy || c1Conflict || memory.inventory.blocked || !authoringAvailable(page, scope, now)} onClick={() => start(true)}>Start a distinct new proposal</button>}</Panel>}
      {manifest && routeMatches && <><nav aria-label="Mandate preparation steps"><ol className="mandate-authoring-steps">{(['acceptance', 'policy', 'proposal'] as const).map((value, index) => <li key={value}><button type="button" aria-current={stage === value ? 'step' : undefined} disabled={busy || Boolean(capsule) || (value === 'policy' && !usable('acceptance')) || (value === 'proposal' && (!usable('acceptance') || !usable('policy')))} onClick={() => chooseStage(value)}><span>{index + 1}</span><span>{value === 'acceptance' ? 'Acceptance document' : value === 'policy' ? 'Mandate policy' : 'Proposal terms'}</span>{value !== 'proposal' && stepReady(value) && <StatusBadge tone="blue">Saved</StatusBadge>}</button></li>)}</ol></nav><div ref={arrival}><div ref={stageFocus} tabIndex={-1} className="access-heading-focus"><h2>{stage === 'acceptance' ? 'Review acceptance terms' : stage === 'policy' ? 'Write the mandate policy' : 'Prepare independent review'}</h2></div>{stage === 'proposal' ? <MandateProposalEditor policyExpiry={dates.policy} reviewDeadline={dates.review} onDates={(policy, review) => { unprepare(); setDates({ policy, review }); }} capsule={capsule?.kind === 'proposal' ? capsule : null} busy={busy} disabled={blocked || !usable('acceptance') || !usable('policy')} fresh={freshReview} site={page.site.name} onReview={prepareProposal} onSubmit={send} onEdit={unprepare}/> : <MandateDocumentEditor purpose={stage === 'acceptance' ? 'ACCEPTANCE_POLICY' : 'MANDATE_POLICY'} text={stage === 'acceptance' ? normalizeAuthoringText(page.responsibility.acceptancePolicy) : policyText} onText={text => { unprepare(); setPolicyText(text); }} capsule={capsule?.kind === 'document' ? capsule : null} saved={stepReady(stage) ? documents[stage] : null} current={page} busy={busy} disabled={blocked} fresh={freshReview} hasSavedReference={Boolean(candidate(stage))} onReadSaved={() => readSaved(stage)} onReview={() => prepareDocument(stage)} onSave={send} onEdit={unprepare} onContinue={() => chooseStage(stage === 'acceptance' ? 'policy' : 'proposal')}/>}</div></>}
    </>}</>}
    {earlierProposals.length > 0 && <Panel title="Earlier recorded proposals"><p>These saved versions remain part of the preparation history. Open each exact record to read its current decision.</p>{earlierProposals.map(item => <p key={`${item.locator.kind}:${item.locator.key}`}><Link href={mandateProposalHref(scope.responsibilityId, item.reference.id, item.reference.version)}>Open recorded proposal {item.reference.id}, version {item.reference.version}</Link></p>)}</Panel>}
    <p className="workspace-note">Unsaved text is held only in this page’s private memory. Leaving may discard it. Saved records and uncertain original requests remain recorded; navigation does not cancel them.</p>
  </div>;
}
