import { z } from 'zod';
import { DomainError } from '../../../packages/domain/src/errors';
import { canonicalJson, commandDigest } from '../../../packages/contracts/src/canonical';
import { IdSchema, type Environment } from '../../../packages/contracts/src/core';
import { NativeAdvisoryHandoffSchema, NativeDelegationReferenceSchema } from '../../../packages/contracts/src/native-delegation';
import { DelegatedAdviceArtifactSchema, DelegatedAdviceOutputSchema, DelegatedAssignmentSchema, DelegatedModelUsageSchema,
  DelegatedPlanOutputSchema, DelegatedServiceRosterSchema, type DelegatedEvidence, type DelegatedServiceRoster } from '../../../packages/contracts/src/delegated-execution';
import { NATIVE_ROOT_BLOCKED_RESULT, NativeRootWorkSchema, NativeRootInputReceiptSchema, type NativeRootCheckpointCommand } from '../../../packages/db/src/native-root-lifecycle-schema';
import type { PostgresNativeRootCoordinatorRepository } from '../../../packages/db/src/native-root-lifecycle-repository';
import type { NativeDelegationTarget, PostgresNativeDelegationWorkerRepository } from '../../../packages/db/src/native-delegation-repository';
import { NativeGatewayError, type NativeModelGateway, type ModelUsage, type ModelResult } from './azure-gateway';
import { DelegatedLease, DelegatedInterrupted, DelegatedPersistenceUnknown, type DelegatedAuthorityObserver } from './delegated-lease';
import { reportDelegatedUsage, addDelegatedUsage, checkAdvice, delegatedCoordinatorInstructions, delegatedChildAdvice, delegatedAdviceInput, DelegatedOutputRejected, renderDelegatedAdvice } from './delegated-output';
import { runDelegatedModel } from './delegated-model';
import { reportDelegatedFailure, type DelegatedDiagnosticReporter, type DelegatedStage } from './delegated-diagnostics';
import type { DelegatedSliceResult } from './delegated-specialist';
import { NativeCoordinatorStateSchema } from '../../../packages/db/src/native-root-refresh-schema';
import type { DelegatedRefreshCoordinatorPort } from './delegated-refresh-port';
import { DelegatedRefreshSession } from './delegated-refresh-session';
import type { DelegatedInstructionCoordinatorPort } from './delegated-instruction-port';
import { DelegatedInstructionSession } from './delegated-instruction-session';
import { qualifyDelegatedAdvice } from './delegated-quality';
import { paidEquipmentRecordInstructions, type DelegatedPaidEquipmentCoordinator } from './delegated-paid-equipment';
import type { ModelRequest } from './azure-gateway';

const SlotSchema = z.strictObject({ taskId: IdSchema, handoffId: IdSchema, requestKey: IdSchema, assignment: DelegatedAssignmentSchema });
const StateSchema = NativeCoordinatorStateSchema;
type State = z.infer<typeof StateSchema>;
type Work = z.infer<typeof NativeRootWorkSchema>;
type Options = {
  environment: Environment;
  services: DelegatedServiceRoster;
  repository: Pick<PostgresNativeRootCoordinatorRepository, 'claim' | 'work' | 'checkpoint' | 'yield' | 'handoff' | 'inputs' | 'complete'>;
  refresh?: DelegatedRefreshCoordinatorPort;
  instructions?: DelegatedInstructionCoordinatorPort;
  renewal: Pick<PostgresNativeDelegationWorkerRepository, 'renew'>;
  gateway: NativeModelGateway;
  paidEquipment?: Pick<DelegatedPaidEquipmentCoordinator, 'beforeSynthesis'>;
  observe: DelegatedAuthorityObserver;
  onUsage?: (event: { taskId: string; role: 'coordinator' | 'escalation'; usage: ModelUsage }) => void;
  onDiagnostic?: DelegatedDiagnosticReporter;
  now?: () => number;
};
const id = () => crypto.randomUUID();
function slot(assignment: z.infer<typeof DelegatedAssignmentSchema>): z.infer<typeof SlotSchema> {
  return { taskId: id(), handoffId: id(), requestKey: id(), assignment };
}
function checkpoint(state: State, work: Work): NativeRootCheckpointCommand['checkpoint'] {
  return { stage: work.children.some(child => child.state === 'ready' || child.state === 'running') ? 'working' : 'reviewing',
    summary: state.plan.objective, steps: state.slots.map(item => {
      const child = work.children.find(child => child.taskId === item.taskId);
      return { id: item.assignment.stepId, title: item.assignment.title,
        state: child?.outcome === 'advice_ready' ? 'done' : child?.outcome === 'failed' || child?.state === 'cancelled' || child?.state === 'paused' ? 'blocked'
          : child ? 'active' : 'planned' };
    }) };
}
function serialized(state: State): string {
  const data = JSON.stringify(StateSchema.parse(state));
  if (data.length > 65536) throw new DelegatedOutputRejected();
  return data;
}
async function waitForImminentEvidenceExpiry(lease: DelegatedLease, evidenceUntil: number, sliceUntil: number, grantUntil: number, now: () => number) {
  // The model helper reserves three seconds for settlement and refuses calls
  // with less than one further second. If it stopped at that boundary, preserve
  // this still-current claim until actual expiry instead of spending another
  // lifetime attempt on crash recovery. No model or source is retried here.
  const wait = evidenceUntil - now() + 1;
  if (wait <= 0 || wait > 4000 || Math.min(lease.usableUntil, sliceUntil, grantUntil) <= evidenceUntil + 1000) return;
  await lease.read(() => new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); lease.signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); lease.signal.removeEventListener('abort', abort); reject(new DelegatedInterrupted()); };
    const timer = setTimeout(done, wait);
    lease.signal.addEventListener('abort', abort, { once: true });
    if (lease.signal.aborted) abort();
  }));
}
/** Coordinates actual durable children. Planner state holds intent and stable
 * operation IDs only; accepted outcomes/authority always come from root_work. */
export class DelegatedCoordinator {
  constructor(private readonly options: Options) {
    if (options.refresh && options.instructions) throw new DelegatedOutputRejected();
    if (options.paidEquipment && (!options.instructions || options.environment !== 'development')) throw new DelegatedOutputRejected();
    const services = DelegatedServiceRosterSchema.parse(options.services);
    if (['research', 'planning', 'escalation'].some(role => services[role as 'research'].serviceId === services.coordinator.serviceId)) throw new DelegatedOutputRejected();
  }
  async run(target: NativeDelegationTarget, slice: { deadlineAt: number; signal?: AbortSignal }): Promise<DelegatedSliceResult> {
    const now = this.options.now ?? Date.now;
    if (slice.deadlineAt - now() < 15000 || slice.signal?.aborted) return { state: 'interrupted', taskId: target.taskId };
    let lease: DelegatedLease | undefined;
    let stage: DelegatedStage = 'claim';
    try {
      lease = await DelegatedLease.acquire({ target, claim: (input, ms) => this.options.repository.claim(input, ms),
        renew: (selector, ms) => this.options.renewal.renew(selector, ms), observe: this.options.observe,
        deadlineAt: slice.deadlineAt - 5000, ...(slice.signal ? { signal: slice.signal } : {}), now });
      const active = lease, claim = active.claim;
      if (claim.handoff !== null || claim.selector.handoffId !== null || canonicalJson(claim.identity) !== canonicalJson(this.options.services.coordinator)) throw new DelegatedOutputRejected();
      stage = 'materials';
      const instructed = this.options.instructions ? new DelegatedInstructionSession(this.options.instructions, active, this.options.environment, target,
        { deadlineAt: slice.deadlineAt, now }) : undefined;
      const refreshed = instructed ?? (this.options.refresh ? new DelegatedRefreshSession(this.options.refresh, active, this.options.environment, target,
        { deadlineAt: slice.deadlineAt, now }) : undefined);
      const loadWork = () => refreshed ? refreshed.work() : active.read(async () => NativeRootWorkSchema.parse(await this.options.repository.work(claim.selector)));
      let work = await loadWork();
      const grant = work.grant, expectedAuthority = NativeDelegationReferenceSchema.parse({ kind: 'delegated', grantId: grant.id, grantVersion: grant.version,
        revocationEpoch: grant.revocationEpoch, grantDigest: await commandDigest(grant) });
      if (grant.scope.environment !== this.options.environment || grant.scope.organizationId !== target.organizationId ||
        claim.attempt > grant.scope.limits.maxAttempts ||
        !grant.scope.sites.some(site => site.siteId === work.siteId) || canonicalJson(expectedAuthority) !== canonicalJson(claim.authority) ||
        work.memoryReferences.some(ref => ref.environment !== this.options.environment || ref.organizationId !== target.organizationId || ref.siteId !== work.siteId)) throw new DelegatedOutputRejected();
      const inputDigest = instructed ? await instructed.inputDigest() : await commandDigest({ title: work.title, prompt: work.prompt, memoryReferences: work.memoryReferences });
      const executionUntil = Math.min(slice.deadlineAt, Date.parse(grant.expiresAt), instructed?.deadlineAt ?? Infinity);
      const instructionContext = instructed?.context ?? {};
      const usageFloor = instructed?.usageFloor ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const lifetimeChildCount = () => instructed?.lifetimeChildCount ?? work.children.length;
      if (lifetimeChildCount() > grant.scope.limits.maxChildren) throw new DelegatedOutputRejected();
      let state: State;
      const assertUsageFloor = () => {
        if (state.usage.inputTokens < usageFloor.inputTokens || state.usage.outputTokens < usageFloor.outputTokens ||
            state.usage.totalTokens < usageFloor.totalTokens) throw new DelegatedOutputRejected();
      };
      const save = async () => {
        assertUsageFloor();
        stage = 'checkpoint';
        const request = { requestKey: id(), expectedCheckpointVersion: work.checkpointVersion, checkpoint: checkpoint(state, work),
          plannerState: serialized(state), inputReceipts: work.inputReceipts };
        const receipt = refreshed ? await refreshed.checkpoint(request) : await active.write(() => this.options.repository.checkpoint(claim.selector, request));
        if (receipt.generation !== target.generation || receipt.checkpointVersion !== work.checkpointVersion + 1 || receipt.requestKey !== request.requestKey) throw new DelegatedPersistenceUnknown();
        work = { ...work, checkpointVersion: receipt.checkpointVersion, checkpoint: request.checkpoint, plannerState: request.plannerState };
      };
      if (refreshed?.refresh) {
        state = await refreshed.originalState(inputDigest);
      } else if (work.plannerState !== null) {
        state = StateSchema.parse(JSON.parse(work.plannerState));
        if (state.inputDigest !== inputDigest || state.attempt > claim.attempt || ['taskId', 'handoffId'].some(key =>
          new Set(state.slots.map(item => item[key as 'taskId'])).size !== state.slots.length) ||
          new Set(state.slots.map(item => item.assignment.stepId)).size !== state.slots.length) throw new DelegatedOutputRejected();
        // Persisted planner text does not authorize a different assignment or
        // memory selection. Compare every existing slot to immutable SQL work.
        for (const item of state.slots) {
          const child = work.children.find(child => child.taskId === item.taskId);
          if (item.assignment.memoryReferences.some(ref => !work.memoryReferences.some(bound => canonicalJson(bound) === canonicalJson(ref))) ||
              child && (child.handoffId !== item.handoffId || canonicalJson(child.assignment) !== canonicalJson(item.assignment))) throw new DelegatedOutputRejected();
        }
        // Accepted children survive a resume/crash. Only fenced unfinished work
        // receives replacement identities, within the original lifetime count.
        if (work.historical && (state.attempt < claim.attempt || state.slots.some(item => work.children.some(child => child.taskId === item.taskId && (child.state === 'cancelled' || child.state === 'paused'))))) {
          let remaining = grant.scope.limits.maxChildren - lifetimeChildCount();
          let bounded = state.bounded;
          const slots = state.slots.map(item => {
            const child = work.children.find(child => child.taskId === item.taskId);
            if (!child || child.state === 'settled') return item;
            if (child.state !== 'cancelled' && child.state !== 'paused') throw new DelegatedOutputRejected();
            if (remaining-- <= 0) { bounded = true; return item; }
            return slot(item.assignment);
          });
          state = { ...state, slots, bounded, attempt: claim.attempt };
          await save();
        }
      } else if (work.children.length) {
        if (refreshed && await refreshed.refreshExpired()) return { state: 'yielded', taskId: target.taskId };
        // An invalidated checkpoint cannot be reconstructed from old evidence.
        // Keep the actual children, then resolve a truthful blocked outcome.
        state = { schemaVersion: 1, inputDigest, attempt: claim.attempt,
          plan: { objective: 'Review of retained work is required.', steps: [], limitations: ['Earlier evidence or checkpoint could not be reused.'], question: null },
          slots: [], bounded: true, usage: { ...usageFloor } };
      } else {
        stage = 'plan';
        const maximum = grant.scope.limits.maxDepth > 0 ? Math.min(6, grant.scope.limits.maxChildren - lifetimeChildCount()) : 0;
        const memorySlots = work.memoryReferences.length ? 1 : 0;
        if (memorySlots > maximum) throw new DelegatedOutputRejected();
        const specialistLimit = Math.max(0, maximum - memorySlots);
        // Reserve deterministic memory work before model planning. The same
        // limit constrains provider output and local admission; never dispatch
        // a silently truncated plan that can only finish as bounded/blocked.
        const planSchema = DelegatedPlanOutputSchema.extend({ steps: DelegatedPlanOutputSchema.shape.steps.max(specialistLimit) });
        const model = await runDelegatedModel(active, this.options.gateway, { role: 'coordinator', instructions: delegatedCoordinatorInstructions +
          `\nPlan at most ${specialistLimit} independent specialist assignments. Cover the entire operator objective within this limit by combining related work, without omitting required work. Selected saved memory is handled separately. Research reviews provided URLs; planning compares options; escalation handles material ambiguity. Work without unsupported external actions. No scope, references or service identities may be created.`,
          input: delegatedAdviceInput({ title: work.title, prompt: work.prompt, ...instructionContext, selectedMemoryCount: work.memoryReferences.length,
            specialistLimit, savedMemoryHandledSeparately: true, capabilities: grant.scope.capabilities }),
          schema: planSchema, schemaName: 'delegated_operator_plan' }, executionUntil, now);
        reportDelegatedUsage(this.options.onUsage, { taskId: target.taskId, role: 'coordinator', usage: model.usage });
        const plan = planSchema.parse(model.value);
        if (model.deployment !== 'gpt-6.1-sol') throw new DelegatedOutputRejected();
        const suggestions = [...plan.steps];
        if (work.memoryReferences.length) suggestions.unshift({ title: 'Review the selected memory', brief: 'Review the selected saved statements for this objective and explain limitations.', role: 'research' });
        state = { schemaVersion: 1, inputDigest, plan, bounded: false, attempt: claim.attempt,
          usage: addDelegatedUsage(usageFloor, model.usage),
          slots: suggestions.map((step, index) => slot({ schemaVersion: 1, stepId: `step-${index + 1}`, ...step,
            memoryReferences: index === 0 ? work.memoryReferences : [] })) };
        await save();
      }
      assertUsageFloor();
      const yieldWork = async (waitFor: string[]): Promise<DelegatedSliceResult> => {
        stage = 'yield';
        const command = { requestKey: id(), expectedCheckpointVersion: work.checkpointVersion, checkpoint: checkpoint(state, work),
          plannerState: serialized(state), inputReceipts: work.inputReceipts,
          continuation: waitFor.length ? 'wait_children' as const : 'continue' as const, waitFor };
        const receipt = refreshed ? await refreshed.yield(command) : await active.write(() => this.options.repository.yield(claim.selector, command));
        if (receipt.generation !== target.generation + 1 || receipt.attempt !== claim.attempt || receipt.requestKey !== command.requestKey) throw new DelegatedPersistenceUnknown();
        return { state: 'yielded', taskId: target.taskId };
      };
      let running = work.children.filter(child => child.state === 'ready' || child.state === 'running');
      for (const item of state.slots) {
        if (work.children.some(child => child.taskId === item.taskId)) continue;
        if (running.length >= grant.scope.limits.maxConcurrentChildren || slice.deadlineAt - now() < 15000) break;
        if (refreshed?.refresh) {
          const reservation = refreshed.refresh.slots.find(slot => slot.taskId === item.taskId);
          if (!reservation || reservation.admission === 'abandoned') continue;
          if (reservation.admission !== 'pending') throw new DelegatedOutputRejected();
          stage = 'handoff';
          work = await refreshed.dispatch(reservation.logicalTaskId, work.checkpointVersion);
          running = work.children.filter(child => child.state === 'ready' || child.state === 'running');
          continue;
        }
        const issued = now(), deadline = Math.min(issued + grant.scope.limits.taskTimeoutMs, Date.parse(grant.expiresAt), instructed?.deadlineAt ?? Infinity);
        if (deadline - issued < 1000) throw new DelegatedOutputRejected();
        const handoff = NativeAdvisoryHandoffSchema.parse({ schemaVersion: 1, handoffId: item.handoffId, environment: this.options.environment,
          organizationId: target.organizationId, siteId: work.siteId, authority: claim.authority, rootTaskId: target.taskId, parentTaskId: target.taskId,
          childTaskId: item.taskId, assignmentVersion: 1, generation: 1, sender: claim.identity, recipient: this.options.services[item.assignment.role],
          capability: item.assignment.memoryReferences.length ? 'read_scoped_memory' : item.assignment.role === 'research' && grant.scope.capabilities.includes('research_public_sources') ? 'research_public_sources' : 'draft_advice',
          capabilityVersion: 1, depth: 1, attemptLimit: grant.scope.limits.maxAttempts, taskTimeoutMs: grant.scope.limits.taskTimeoutMs,
          issuedAt: new Date(issued).toISOString(), deadlineAt: new Date(deadline).toISOString(), inputArtifacts: [], outputContract: 'advisory_artifacts_v1', correlationId: id() });
        stage = 'handoff';
        const handoffCommand = { requestKey: item.requestKey, handoff, assignment: item.assignment };
        const handed = instructed ? await instructed.handoff(handoffCommand) : await active.write(() => this.options.repository.handoff(claim.selector, handoffCommand));
        if (handed.digest !== await commandDigest(handoff)) throw new DelegatedPersistenceUnknown();
        // Re-read actual state after the durable handoff; no optimistic activity
        // or checkpoint can stand in for an accepted child/outbox record.
        stage = 'materials';
        work = await loadWork();
        running = work.children.filter(child => child.state === 'ready' || child.state === 'running');
      }
      if (running.length) return await yieldWork(running.map(child => child.taskId));
      if (state.slots.some(item => !work.children.some(child => child.taskId === item.taskId) &&
          !refreshed?.refresh?.slots.some(slot => slot.taskId === item.taskId && slot.admission === 'abandoned'))) return await yieldWork([]);
      const coverage = work.children.map(child => ({ taskId: child.taskId, disposition: child.outcome === 'advice_ready' ? 'advice_ready' as const
        : child.outcome === 'failed' ? 'failed' as const : 'abandoned' as const }));
      const completeBlocked = async (): Promise<DelegatedSliceResult> => {
        stage = 'completion';
        const command = { requestKey: id(), expectedCheckpointVersion: work.checkpointVersion,
          inputReceipts: work.inputReceipts, coverage, result: structuredClone(NATIVE_ROOT_BLOCKED_RESULT) };
        const receipt = refreshed ? await refreshed.complete(command) : await active.write(() => this.options.repository.complete(claim.selector, command));
        if (receipt.rootTaskId !== target.taskId || receipt.domainCompletion !== false || receipt.execution !== 'none') throw new DelegatedPersistenceUnknown();
        return { state: 'settled', taskId: target.taskId };
      };
      if (state.bounded || state.slots.some(item => work.children.find(child => child.taskId === item.taskId)?.outcome !== 'advice_ready')) return await completeBlocked();
      const activeIds = refreshed?.refresh ? new Set(refreshed.refresh.slots.filter(slot => slot.admission === 'admitted').map(slot => slot.taskId)) : null;
      const accepted = work.children.filter(child => (!activeIds || activeIds.has(child.taskId)) && child.state === 'settled' && child.publicationDigest !== null && child.outcome === 'advice_ready');
      const recordReturned = (role: 'coordinator' | 'escalation', result: ModelResult<unknown>) => {
        state = { ...state, usage: addDelegatedUsage(state.usage, result.usage) };
        reportDelegatedUsage(this.options.onUsage, { taskId: target.taskId, role, usage: result.usage });
      };
      const paidContributions: unknown[] = [];
      let paidInputReceipt: {receiptId:string;digest:string}|null = null;
      const evidence: DelegatedEvidence[] = [], childAdvice: Array<ReturnType<typeof delegatedChildAdvice>> = [];
      let dataUntil = Math.min(Date.parse(grant.expiresAt), instructed?.deadlineAt ?? Infinity);
      if (accepted.length) {
        const request = { requestKey: id(), results: accepted.map(child => ({ handoffId: child.handoffId, publicationDigest: child.publicationDigest! })) };
        let consumed: z.infer<typeof NativeRootInputReceiptSchema>;
        stage = 'inputs';
        try { consumed = NativeRootInputReceiptSchema.parse(refreshed ? await refreshed.inputs(request) : await active.write(() => this.options.repository.inputs(claim.selector, request))); }
        catch (error) {
          if (error instanceof DomainError && ['EVIDENCE_STALE', 'FORBIDDEN'].includes(error.code)) {
            reportDelegatedFailure(this.options.onDiagnostic, 'coordinator', stage, error);
            if (error.code === 'EVIDENCE_STALE' && refreshed && await refreshed.refreshExpired()) return { state: 'yielded', taskId: target.taskId };
            return await completeBlocked();
          }
          throw error;
        }
        if (consumed.generation !== target.generation || canonicalJson(consumed.results.map(result => ({ handoffId: result.handoffId, publicationDigest: result.publicationDigest }))) !== canonicalJson(request.results)) throw new DelegatedOutputRejected();
        work = { ...work, inputReceipts: [...work.inputReceipts, consumed.receipt] };
        paidInputReceipt = consumed.receipt;
        if (consumed.dataValidUntil !== null) dataUntil = Math.min(dataUntil, Date.parse(consumed.dataValidUntil));
        for (const [resultIndex, result] of consumed.results.entries()) for (const [artifactIndex, artifact] of result.artifacts.entries()) {
          if (await commandDigest(artifact.body) !== artifact.reference.digest) throw new DelegatedOutputRejected();
          const body = DelegatedAdviceArtifactSchema.parse(artifact.body); checkAdvice(body.advice, body.evidence);
          const assignment = work.children.find(child => child.handoffId === result.handoffId)?.assignment;
          if (!assignment || assignment.stepId !== body.stepId || assignment.role !== body.role || artifact.reference.environment !== this.options.environment ||
            artifact.reference.organizationId !== target.organizationId || artifact.reference.siteId !== work.siteId) throw new DelegatedOutputRejected();
          childAdvice.push(delegatedChildAdvice(body));
          paidContributions.push({ scope: {organizationId:target.organizationId,siteId:work.siteId,rootTaskId:target.taskId,instructionRevision:instructed?.revision ?? 0}, artifactId:artifact.reference.artifactId,digest:artifact.reference.digest,body });
          evidence.push(...body.evidence.map((item, index) => ({ ...item, id: `child-${resultIndex + 1}-${artifactIndex + 1}-${index + 1}` })));
        }
      }
      if (slice.deadlineAt - now() < 15000) return await yieldWork([]);
      let purchasedEquipment: unknown = null;
      if (this.options.paidEquipment) {
        stage = 'paid_equipment';
        if (!instructed) throw new DelegatedOutputRejected();
        try {
          const paid = await this.options.paidEquipment.beforeSynthesis({ lease: active,
            scope: {organizationId:target.organizationId,siteId:work.siteId,rootTaskId:target.taskId,instructionRevision:instructed.revision},
            refreshEpoch:instructed.epoch,rootDeadlineAt:new Date(instructed.deadlineAt).toISOString(),
            operatorPrompt:JSON.stringify({original:work.prompt,...instructionContext}),inputReceipt:paidInputReceipt,accepted:paidContributions,
            checkpoint:()=>({requestKey:id(),expectedCheckpointVersion:work.checkpointVersion,checkpoint:checkpoint(state,work),plannerState:serialized(state),inputReceipts:work.inputReceipts}),
            persistSelectionUsage:save,
            gateway:{complete:async<T>(request:ModelRequest<T>)=>{const result=await runDelegatedModel(active,this.options.gateway,request,Math.min(executionUntil,dataUntil),now);recordReturned('coordinator',result);if(result.deployment!=='gpt-6.1-sol')throw new DelegatedOutputRejected();return result;}},now });
          if (paid.kind === 'waiting') return {state:'yielded',taskId:target.taskId};
          if (paid.kind === 'unavailable') return await completeBlocked();
          if (paid.kind === 'ready') { purchasedEquipment=paid.input;dataUntil=Math.min(dataUntil,Date.parse(paid.dataValidUntil)); }
        } catch(error) {
          reportDelegatedFailure(this.options.onDiagnostic, 'coordinator', 'paid_equipment', error);
          if (error instanceof DelegatedPersistenceUnknown || error instanceof DelegatedInterrupted) throw error;
          if (error instanceof NativeGatewayError && error.measurement) recordReturned('coordinator',{value:undefined,...error.measurement});
          if (error instanceof DomainError && ['EVIDENCE_STALE','FORBIDDEN'].includes(error.code)) {
            if (refreshed && await refreshed.refreshExpired()) return {state:'yielded',taskId:target.taskId};
          }
          active.assertCurrent();await save();return await completeBlocked();
        }
      }
      const input = delegatedAdviceInput({ title: work.title, prompt: work.prompt, ...instructionContext, plan: state.plan, childAdvice, evidenceExcerpts: evidence,
        ...(purchasedEquipment === null ? {} : {purchasedEquipment}),
        coverage: coverage.map(item => ({ disposition: item.disposition })), constraints: coverage.some(item => item.disposition !== 'advice_ready') ? ['Earlier attempts were stopped or failed. All current planned assignments completed; disclose that recovery occurred.'] : [] });
      stage = 'model';
      let model: ModelResult<z.infer<typeof DelegatedAdviceOutputSchema>>;
      try {
        model = await runDelegatedModel(active, this.options.gateway, { role: 'coordinator', instructions: delegatedCoordinatorInstructions + (purchasedEquipment === null ? '' : paidEquipmentRecordInstructions),
          input, schema: DelegatedAdviceOutputSchema, schemaName: 'delegated_root_advice' }, Math.min(slice.deadlineAt, dataUntil), now);
      } catch (error) {
        if (error instanceof NativeGatewayError && error.measurement) recordReturned('coordinator', { value: undefined, ...error.measurement });
        if (refreshed && error instanceof DelegatedInterrupted && !active.signal.aborted) {
          await waitForImminentEvidenceExpiry(active, dataUntil, slice.deadlineAt, Date.parse(grant.expiresAt), now);
        }
        if (refreshed && dataUntil <= now() && !active.signal.aborted) {
          if (await refreshed.refreshExpired()) return { state: 'yielded', taskId: target.taskId };
          return await completeBlocked();
        }
        if (error instanceof NativeGatewayError && error.measurement) {
          active.assertCurrent(); await save(); return await completeBlocked();
        }
        throw error;
      }
      recordReturned('coordinator', model);
      stage = 'output';
      if (refreshed && dataUntil <= now()) {
        if (await refreshed.refreshExpired()) return { state: 'yielded', taskId: target.taskId };
        return await completeBlocked();
      }
      let originalAdvice: z.infer<typeof DelegatedAdviceOutputSchema>;
      try {
        if (model.deployment !== 'gpt-6.1-sol') throw new DelegatedOutputRejected();
        originalAdvice = checkAdvice(model.value, evidence);
        if (renderDelegatedAdvice(originalAdvice).length > 16000 || dataUntil <= now()) throw new DelegatedOutputRejected();
      } catch {
        active.assertCurrent(); await save(); return await completeBlocked();
      }
      const qualityDeadline = Math.min(executionUntil, dataUntil);
      const quality = await qualifyDelegatedAdvice({ context: JSON.parse(input), advice: originalAdvice, evidence,
        deadlineAt: qualityDeadline, now, assertCurrent: () => active.assertCurrent(), recordReturned,
        run: request => runDelegatedModel(active, this.options.gateway, purchasedEquipment === null ? request : {...request,instructions:request.instructions+paidEquipmentRecordInstructions}, qualityDeadline, now) });
      active.assertCurrent();
      if (refreshed && dataUntil <= now()) {
        if (await refreshed.refreshExpired()) return { state: 'yielded', taskId: target.taskId };
        return await completeBlocked();
      }
      const advice = quality.state === 'accepted' ? quality.advice : originalAdvice;
      const rendered = renderDelegatedAdvice(advice);
      try {
        // Persist every returned draft/review/repair usage before either final
        // outcome. Revoked leases and unknown writes retain existing fences.
        await save();
        if (quality.state === 'blocked') {
          reportDelegatedFailure(this.options.onDiagnostic, 'coordinator', 'output', new DelegatedOutputRejected());
          return await completeBlocked();
        }
        stage = 'completion';
        const command = { requestKey: id(), expectedCheckpointVersion: work.checkpointVersion,
          inputReceipts: work.inputReceipts, coverage, result: { outcome: 'advice_ready' as const, title: advice.title,
            summary: advice.summary,
            artifacts: [{ id: id(), title: advice.title, text: rendered }], evidenceValidUntil: new Date(dataUntil).toISOString() } };
        const receipt = refreshed ? await refreshed.complete(command) : await active.write(() => this.options.repository.complete(claim.selector, command));
        if (receipt.rootTaskId !== target.taskId || receipt.domainCompletion !== false) throw new DelegatedPersistenceUnknown();
        return { state: 'settled', taskId: target.taskId };
      } catch (error) {
        // A confirmed evidence rejection may settle only the fixed generic
        // blocked result. Unknown writes never begin another operation.
        if (error instanceof DomainError && ['EVIDENCE_STALE', 'FORBIDDEN'].includes(error.code)) {
          reportDelegatedFailure(this.options.onDiagnostic, 'coordinator', stage, error);
          if (error.code === 'EVIDENCE_STALE' && refreshed && await refreshed.refreshExpired()) return { state: 'yielded', taskId: target.taskId };
          return await completeBlocked();
        }
        throw error;
      }
    } catch (error) {
      reportDelegatedFailure(this.options.onDiagnostic, 'coordinator', stage, error);
      return { state: error instanceof DelegatedPersistenceUnknown ? 'unconfirmed' : 'interrupted', taskId: target.taskId };
    } finally { lease?.close(); }
  }
}
