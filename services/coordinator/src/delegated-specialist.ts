import { DomainError } from '../../../packages/domain/src/errors';
import { canonicalJson, commandDigest } from '../../../packages/contracts/src/canonical';
import { DelegatedAdviceOutputSchema, DelegatedAssignmentSchema, type DelegatedEvidence } from '../../../packages/contracts/src/delegated-execution';
import { NativeAdvisoryResultSchema, type NativeServiceIdentity } from '../../../packages/contracts/src/native-delegation';
import type { Environment } from '../../../packages/contracts/src/core';
import type { PostgresNativeDelegationWorkerRepository, NativeDelegationPublication, NativeDelegationTarget } from '../../../packages/db/src/native-delegation-repository';
import type { PostgresNativeRootWorkerRepository } from '../../../packages/db/src/native-root-lifecycle-repository';
import { NativeRootMaterialsSchema } from '../../../packages/db/src/native-root-lifecycle-schema';
import type { PostgresNativeMemoryTaskRepository } from '../../../packages/db/src/native-memory-repository';
import { NativeGatewayError, type NativeModelGateway, type ModelUsage } from './azure-gateway';
import { DelegatedLease, DelegatedPersistenceUnknown, type DelegatedAuthorityObserver } from './delegated-lease';
import { reportDelegatedUsage, adviceArtifact, delegatedInstructions, DelegatedOutputRejected, memoryEvidence, publicEvidence } from './delegated-output';
import type { NativeEvidenceReader, ObservedEvidenceRead } from './native-evidence';
import { NativeRootMaterialsV2Schema, NativeDelegationPublicationV2ReceiptSchema, type NativePublicSourceObservation } from '../../../packages/db/src/native-root-refresh-schema';
import type { DelegatedRefreshSpecialistPort } from './delegated-refresh-port';
import { NativeRootMaterialsV3Schema, NativeDelegationPublicationV3ReceiptSchema, nativeInstructionDigest } from '../../../packages/db/src/native-root-instruction-schema';
import type { DelegatedInstructionSpecialistPort } from './delegated-instruction-port';
import { freshPublicObservations } from './delegated-source-observations';
import { runDelegatedModel } from './delegated-model';
import { reportDelegatedFailure, type DelegatedDiagnosticReporter, type DelegatedStage } from './delegated-diagnostics';

export type DelegatedSliceResult = { state: 'settled' | 'yielded' | 'interrupted' | 'unconfirmed'; taskId: string };
type Options = {
  environment: Environment;
  identity: NativeServiceIdentity;
  repository: Pick<PostgresNativeDelegationWorkerRepository, 'claim' | 'renew' | 'result'>;
  materials: Pick<PostgresNativeRootWorkerRepository, 'materials'>;
  refresh?: DelegatedRefreshSpecialistPort;
  instructions?: DelegatedInstructionSpecialistPort;
  memory: Pick<PostgresNativeMemoryTaskRepository, 'read'>;
  observe: DelegatedAuthorityObserver;
  gateway: NativeModelGateway;
  evidenceReader?: NativeEvidenceReader;
  onUsage?: (event: { taskId: string; role: 'research' | 'planning' | 'escalation'; usage: ModelUsage }) => void;
  onDiagnostic?: DelegatedDiagnosticReporter;
  now?: () => number;
};

/** One immutable specialist assignment, one model call, one exact publication.
 * Retry/fencing belongs to durable root recovery, never an in-process loop. */
export class DelegatedSpecialist {
  constructor(private readonly options: Options) {
    if (options.refresh && options.instructions) throw new DelegatedOutputRejected();
  }
  async run(target: NativeDelegationTarget, slice: { deadlineAt: number; signal?: AbortSignal }): Promise<DelegatedSliceResult> {
    const now = this.options.now ?? Date.now;
    if (slice.deadlineAt - now() < 15000 || slice.signal?.aborted) return { state: 'interrupted', taskId: target.taskId };
    let lease: DelegatedLease | undefined;
    let stage: DelegatedStage = 'claim';
    const memoryUsage: NativeDelegationPublication['memoryUsage'] = [];
    let publishFailure = false, materialsVerified = false;
    let refreshEpoch = 0, requiresPublicObservation = false, instructionRevision = 0;
    let instructionContext: { operatorInstructions?: Array<{ sequence: number; text: string; recordedAt: string }> } = {};
    let sourceRead: ObservedEvidenceRead | undefined;
    const publish = (active: DelegatedLease, publication: NativeDelegationPublication, observations: NativePublicSourceObservation[] = []) => active.write(async () => {
      if (this.options.instructions) {
        const receipt = NativeDelegationPublicationV3ReceiptSchema.parse(await this.options.instructions.resultV3(active.claim.selector,
          { schemaVersion: 3, expectedInstructionRevision: instructionRevision, expectedRefreshEpoch: refreshEpoch, publication, observations }));
        if (receipt.instructionRevision !== instructionRevision || receipt.refreshEpoch !== refreshEpoch ||
            receipt.provenanceDigest !== (observations.length ? await commandDigest(observations) : null)) throw new DelegatedPersistenceUnknown();
        return receipt;
      }
      if (!this.options.refresh) return this.options.repository.result(active.claim.selector, publication);
      const receipt = NativeDelegationPublicationV2ReceiptSchema.parse(await this.options.refresh.resultV2(active.claim.selector,
        { schemaVersion: 2, expectedRefreshEpoch: refreshEpoch, publication, observations }));
      if (receipt.refreshEpoch !== refreshEpoch || receipt.provenanceDigest !== (observations.length ? await commandDigest(observations) : null)) throw new DelegatedPersistenceUnknown();
      return receipt;
    });
    try {
      lease = await DelegatedLease.acquire({ target, claim: (input, ms) => this.options.repository.claim(input, ms),
        renew: (selector, ms) => this.options.repository.renew(selector, ms), observe: this.options.observe,
        deadlineAt: slice.deadlineAt - 5000, ...(slice.signal ? { signal: slice.signal } : {}), now });
      const active = lease, claim = active.claim, handoff = claim.handoff;
      if (!handoff || handoff.environment !== this.options.environment || handoff.organizationId !== target.organizationId ||
        claim.attempt > handoff.attemptLimit ||
        handoff.childTaskId !== target.taskId || handoff.generation !== target.generation || claim.selector.handoffId !== handoff.handoffId ||
        canonicalJson(claim.identity) !== canonicalJson(this.options.identity) || canonicalJson(handoff.recipient) !== canonicalJson(claim.identity) ||
        canonicalJson(handoff.authority) !== canonicalJson(claim.authority)) throw new DelegatedOutputRejected();
      stage = 'materials';
      const material = this.options.instructions ? await active.read(async () => {
        const result = NativeRootMaterialsV3Schema.parse(await this.options.instructions!.materialsV3(claim.selector));
        if (result.instructionDigest !== await nativeInstructionDigest(result.instructionRevision, result.instructions)) throw new DelegatedOutputRejected();
        instructionRevision = result.instructionRevision;
        instructionContext = instructionRevision ? { operatorInstructions: structuredClone(result.instructions) } : {};
        refreshEpoch = result.refreshEpoch; requiresPublicObservation = result.refresh?.requiresPublicObservation ?? false;
        if (result.refresh && (handoff.capability === 'research_public_sources') !== requiresPublicObservation) throw new DelegatedOutputRejected();
        return result.material;
      }) : this.options.refresh ? await active.read(async () => {
        const result = NativeRootMaterialsV2Schema.parse(await this.options.refresh!.materialsV2(claim.selector));
        refreshEpoch = result.refreshEpoch; requiresPublicObservation = result.refresh?.requiresPublicObservation ?? false;
        if (result.refresh && (handoff.capability === 'research_public_sources') !== requiresPublicObservation) throw new DelegatedOutputRejected();
        return result.material;
      }) : NativeRootMaterialsSchema.parse(await active.read(() => this.options.materials.materials(claim.selector)));
      const assignment = DelegatedAssignmentSchema.parse(material.assignment);
      if (new Set(assignment.memoryReferences.map(ref => ref.memoryId)).size !== assignment.memoryReferences.length ||
        assignment.memoryReferences.some(ref => ref.environment !== handoff.environment || ref.organizationId !== handoff.organizationId || ref.siteId !== handoff.siteId) ||
        canonicalJson(material.inputArtifacts.map(item => item.reference)) !== canonicalJson(handoff.inputArtifacts)) throw new DelegatedOutputRejected();
      for (const input of material.inputArtifacts) if (await commandDigest(input.body) !== input.reference.digest) throw new DelegatedOutputRejected();
      materialsVerified = true;
      if (requiresPublicObservation && !this.options.evidenceReader?.readWithObservations) {
        publishFailure = true; throw new DelegatedOutputRejected();
      }
      const evidence: DelegatedEvidence[] = [];
      for (const [index, reference] of assignment.memoryReferences.entries()) {
        // Selection writes an original usage receipt. A missing response cannot
        // be treated as a read-only failure or followed by another selection.
        stage = 'memory';
        const result = await active.write(() => this.options.memory.read({ ...claim.selector, handoffId: handoff.handoffId }, reference));
        const loaded = await memoryEvidence(result, reference, claim, index, now());
        memoryUsage.push(loaded.usage); evidence.push(loaded.evidence);
      }
      if (handoff.capability === 'research_public_sources' && this.options.evidenceReader) {
        // actorId is supplied by the protected materials loader; a model never
        // supplies URLs or the scope passed to this existing source reader.
        const actorId = 'actorId' in material && typeof material.actorId === 'string' ? material.actorId : null;
        if (actorId === null) throw new DelegatedOutputRejected();
        stage = 'source';
        const sourceRequest = { environment: handoff.environment,
          organizationId: handoff.organizationId, actorId, siteId: handoff.siteId, taskId: handoff.childTaskId,
          query: assignment.brief, userInput: JSON.stringify({ objective: material.rootPrompt, conversation: [] }), signal: active.signal };
        if (requiresPublicObservation) {
          publishFailure = true;
          sourceRead = await active.read(() => this.options.evidenceReader!.readWithObservations!(sourceRequest));
          if (!sourceRead.documents.length) throw new DelegatedOutputRejected();
        }
        const documents = sourceRead?.documents ?? await active.read(() => this.options.evidenceReader!.read(sourceRequest));
        evidence.push(...publicEvidence(documents, now()));
      }
      if (Math.min(slice.deadlineAt, Date.parse(handoff.deadlineAt)) - now() < 5000) return { state: 'interrupted', taskId: target.taskId };
      const input = JSON.stringify({ operator: { title: material.rootTitle, prompt: material.rootPrompt }, ...instructionContext, assignment: { title: assignment.title, brief: assignment.brief },
        evidenceExcerpts: evidence, originalInputs: material.inputArtifacts.map(item => item.body), limitations: [
          'Only supplied excerpts were reviewed. This is advisory work; no external action was performed.',
          ...(sourceRead?.unavailableUrls.map(url => `The original source could not be read: ${url}`) ?? []),
        ] });
      if (input.length > 150000) throw new DelegatedOutputRejected();
      publishFailure = true;
      stage = 'model';
      const missingSources = sourceRead?.unavailableUrls.length ?? 0;
      const adviceSchema = missingSources ? DelegatedAdviceOutputSchema.extend({
        limitations: DelegatedAdviceOutputSchema.shape.limitations.max(7),
      }) : DelegatedAdviceOutputSchema;
      const model = await runDelegatedModel(active, this.options.gateway, { role: assignment.role, instructions: delegatedInstructions,
        input, schema: adviceSchema, schemaName: 'delegated_specialist_advice' }, Math.min(slice.deadlineAt, Date.parse(handoff.deadlineAt)), now);
      reportDelegatedUsage(this.options.onUsage, { taskId: target.taskId, role: assignment.role, usage: model.usage });
      stage = 'output';
      // The model cannot omit an actual retrieval failure from the publication.
      // Reserve one limitation slot rather than discarding other model caveats.
      const checkedModel = missingSources ? { ...model, value: { ...model.value, limitations: [...model.value.limitations,
        `${missingSources} of the ${missingSources + sourceRead!.observations.length} originally provided sources could not be read. Advice uses only sources read in this attempt.`] } } : model;
      const artifact = adviceArtifact(assignment, checkedModel, evidence), body = artifact as unknown as Record<string, unknown>;
      const observations = requiresPublicObservation ? await freshPublicObservations({ originalPrompt: material.rootPrompt,
        handoff, read: sourceRead!, artifact, now: now() }) : [];
      const reference = { environment: handoff.environment, organizationId: handoff.organizationId, siteId: handoff.siteId,
        artifactId: crypto.randomUUID(), revision: 1, digest: await commandDigest(body) };
      const finishedAt = new Date(now()).toISOString(), evidenceUntil = Math.min(Date.parse(handoff.deadlineAt), ...evidence.map(item => Date.parse(item.validUntil)));
      if (evidenceUntil <= now()) throw new DelegatedOutputRejected();
      const result = NativeAdvisoryResultSchema.parse({ schemaVersion: 1, resultId: crypto.randomUUID(), handoffId: handoff.handoffId,
        handoffDigest: await commandDigest(handoff), environment: handoff.environment, organizationId: handoff.organizationId, siteId: handoff.siteId,
        childTaskId: handoff.childTaskId, assignmentVersion: handoff.assignmentVersion, generation: claim.selector.generation, authority: claim.authority,
        sender: claim.identity, recipient: handoff.sender, attempt: claim.attempt, outcome: 'advice_ready', artifacts: [reference], finishedAt,
        evidenceValidUntil: new Date(evidenceUntil).toISOString() });
      const publication = { result, artifacts: [{ reference, body }], inputArtifacts: handoff.inputArtifacts, memoryUsage };
      stage = 'publication';
      const receipt = await publish(active, publication, observations);
      if (receipt.publicationDigest !== await commandDigest(publication)) throw new DelegatedPersistenceUnknown();
      return { state: 'settled', taskId: target.taskId };
    } catch (error) {
      reportDelegatedFailure(this.options.onDiagnostic, 'specialist', stage, error);
      if (error instanceof DelegatedPersistenceUnknown) return { state: 'unconfirmed', taskId: target.taskId };
      const admissionRejected = materialsVerified && error instanceof DomainError && ['EVIDENCE_STALE', 'VERSION_CONFLICT', 'MEMORY_UNAVAILABLE', 'MEMORY_LIMIT', 'MEMORY_INTEGRITY', 'NOT_FOUND'].includes(error.code);
      if (lease && !lease.signal.aborted && (admissionRejected || publishFailure && (error instanceof NativeGatewayError || error instanceof DelegatedOutputRejected))) {
        const claim = lease.claim, handoff = claim.handoff!;
        try {
          const result = NativeAdvisoryResultSchema.parse({ schemaVersion: 1, resultId: crypto.randomUUID(), handoffId: handoff.handoffId,
            handoffDigest: await commandDigest(handoff), environment: handoff.environment, organizationId: handoff.organizationId, siteId: handoff.siteId,
            childTaskId: handoff.childTaskId, assignmentVersion: handoff.assignmentVersion, generation: claim.selector.generation, authority: claim.authority,
            sender: claim.identity, recipient: handoff.sender, attempt: claim.attempt, outcome: 'failed', artifacts: [], finishedAt: new Date(now()).toISOString(), evidenceValidUntil: null });
          const publication = { result, artifacts: [], inputArtifacts: handoff.inputArtifacts, memoryUsage };
          const receipt = await publish(lease, publication);
          if (receipt.publicationDigest !== await commandDigest(publication)) throw new DelegatedPersistenceUnknown();
          return { state: 'settled', taskId: target.taskId };
        } catch (publicationError) {
          reportDelegatedFailure(this.options.onDiagnostic, 'specialist', 'failure_publication', publicationError);
          return { state: 'unconfirmed', taskId: target.taskId };
        }
      }
      return { state: 'interrupted', taskId: target.taskId };
    } finally { lease?.close(); }
  }
}
