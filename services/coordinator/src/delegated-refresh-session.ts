import { canonicalJson, commandDigest } from '../../../packages/contracts/src/canonical';
import type { Environment } from '../../../packages/contracts/src/core';
import type { NativeDelegationTarget } from '../../../packages/db/src/native-delegation-repository';
import type { NativeRootCheckpointCommand, NativeRootYieldCommand, NativeRootInputsCommand, NativeRootCompleteCommand } from '../../../packages/db/src/native-root-lifecycle-schema';
import { NativeCoordinatorStateSchema, NativeRootWorkV2Schema, NativeRootCheckpointV2ReceiptSchema,
  NativeRootYieldV2ReceiptSchema, NativeRootInputsV2ReceiptSchema, NativeRootCompleteV2ReceiptSchema,
  NativeRootRefreshOperationReceiptSchema, type NativeRootWorkV2, type NativeRootRefreshOperationReceipt } from '../../../packages/db/src/native-root-refresh-schema';
import { DomainError } from '../../../packages/domain/src/errors';
import { DelegatedPersistenceUnknown, interruptible, type DelegatedLease } from './delegated-lease';
import { DelegatedOutputRejected } from './delegated-output';
import { refreshOperationCommand, refreshDispatchOperationCommand } from './delegated-refresh-identity';
import type { DelegatedRefreshCoordinatorPort } from './delegated-refresh-port';

/** A single claimed generation. Every mutation has one durable command; an
 * ambiguous response terminates the slice. The next claim reads committed
 * operation metadata/current lineage before doing any further model work. */
export class DelegatedRefreshSession {
  private frame: NativeRootWorkV2 | undefined;
  constructor(private readonly port: DelegatedRefreshCoordinatorPort,
    private readonly lease: DelegatedLease, private readonly environment: Environment,
    private readonly target: NativeDelegationTarget,
    private readonly slice: { deadlineAt: number; now: () => number }) {
    if (target.organizationId !== lease.claim.selector.organizationId || target.taskId !== lease.claim.selector.taskId ||
        target.generation !== lease.claim.selector.generation) throw new DelegatedOutputRejected();
    this.target = { ...target };
  }

  get epoch() { if (!this.frame) throw new DelegatedOutputRejected(); return this.frame.refreshEpoch; }
  get refresh() { return this.frame?.refresh ?? null; }
  private assertEpoch(epoch: number) { if (epoch !== this.epoch) throw new DelegatedPersistenceUnknown(); }
  async work() {
    const frame = await this.lease.read(async () => NativeRootWorkV2Schema.parse(await this.port.workV2(this.lease.claim.selector)));
    if (this.frame && frame.refreshEpoch !== this.epoch) throw new DelegatedOutputRejected();
    if (frame.refresh) {
      for (const operation of frame.refresh.operations) {
        if (operation.rootTaskId !== this.target.taskId || operation.generation > this.target.generation ||
            operation.refreshEpoch > frame.refreshEpoch || operation.attempt > this.lease.claim.attempt) throw new DelegatedOutputRejected();
      }
      if (!frame.refresh.operations.some(operation => operation.kind === 'refresh' && operation.refreshEpoch === frame.refreshEpoch)) throw new DelegatedOutputRejected();
      for (const slot of frame.refresh.slots) {
        const child = frame.work.children.find(item => item.taskId === slot.taskId);
        if (slot.admission === 'pending' && child || slot.admission === 'admitted' && !child ||
            child && (child.handoffId !== slot.handoffId || canonicalJson(child.assignment) !== canonicalJson(slot.assignment))) throw new DelegatedOutputRejected();
      }
    }
    this.frame = frame;
    return frame.work;
  }
  async originalState(inputDigest: string) {
    const refresh = this.refresh;
    if (!refresh) throw new DelegatedOutputRejected();
    const original = NativeCoordinatorStateSchema.parse(JSON.parse(refresh.planBasis.plannerState));
    if (original.inputDigest !== inputDigest || await commandDigest(original) !== refresh.planBasis.plannerDigest ||
        original.slots.length !== refresh.slots.length || original.attempt > this.lease.claim.attempt) throw new DelegatedOutputRejected();
    for (const slot of refresh.slots) {
      const source = original.slots.find(item => item.taskId === slot.originalTaskId);
      if (!source || canonicalJson(source.assignment) !== canonicalJson(slot.assignment)) throw new DelegatedOutputRejected();
    }
    return NativeCoordinatorStateSchema.parse({ ...original, slots: refresh.slots.map(slot => ({
      taskId: slot.taskId, handoffId: slot.handoffId, requestKey: slot.requestKey, assignment: slot.assignment,
    })), usage: refresh.usage, bounded: original.bounded || refresh.slots.some(slot => slot.admission === 'abandoned'), attempt: this.lease.claim.attempt });
  }
  async checkpoint(command: NativeRootCheckpointCommand) {
    return this.lease.write(async () => {
      const response = NativeRootCheckpointV2ReceiptSchema.parse(await this.port.checkpointV2(this.lease.claim.selector,
        { schemaVersion: 2, expectedRefreshEpoch: this.epoch, command }));
      this.assertEpoch(response.refreshEpoch); return response.receipt;
    });
  }
  async yield(command: NativeRootYieldCommand) {
    return this.lease.write(async () => {
      const response = NativeRootYieldV2ReceiptSchema.parse(await this.port.yieldV2(this.lease.claim.selector,
        { schemaVersion: 2, expectedRefreshEpoch: this.epoch, command }));
      this.assertEpoch(response.refreshEpoch); return response.receipt;
    });
  }
  async inputs(command: NativeRootInputsCommand) {
    return this.lease.write(async () => {
      const response = NativeRootInputsV2ReceiptSchema.parse(await this.port.inputsV2(this.lease.claim.selector,
        { schemaVersion: 2, expectedRefreshEpoch: this.epoch, command }));
      this.assertEpoch(response.refreshEpoch); return response.receipt;
    });
  }
  async complete(command: NativeRootCompleteCommand) {
    return this.lease.write(async () => {
      const response = NativeRootCompleteV2ReceiptSchema.parse(await this.port.completeV2(this.lease.claim.selector,
        { schemaVersion: 2, expectedRefreshEpoch: this.epoch, command }));
      this.assertEpoch(response.refreshEpoch); return response.receipt;
    });
  }
  private async verifyOperation(receipt: NativeRootRefreshOperationReceipt, command: { requestKey: string }, kind: 'refresh' | 'dispatch') {
    if (receipt.kind !== kind || receipt.requestKey !== command.requestKey || receipt.intentDigest !== await commandDigest(command) ||
        receipt.rootTaskId !== this.target.taskId || receipt.previousGeneration !== this.target.generation || receipt.previousEpoch !== this.epoch) throw new DelegatedPersistenceUnknown();
  }
  private async lookupOperation(kind: 'refresh' | 'dispatch', command: { requestKey: string }) {
    // Acceptance may already have fenced the issuing lease. This RPC only
    // reads exact committed metadata under the original authenticated service;
    // it cannot authorize another model call, write or replay on this slice.
    this.lease.close();
    const remaining = Math.min(2000, this.slice.deadlineAt - this.slice.now());
    if (!Number.isSafeInteger(remaining) || remaining <= 0) return null;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
    try {
      const lookup = { kind, requestKey: command.requestKey, intentDigest: await commandDigest(command) };
      const response = NativeRootRefreshOperationReceiptSchema.nullable().parse(await interruptible(
        this.port.refreshOperation(this.target, lookup), controller.signal));
      if (response) await this.verifyOperation(response, command, kind);
      return response;
    } catch { return null; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async refreshExpired(): Promise<boolean> {
    const work = await this.work();
    const activeIds = this.refresh ? new Set(this.refresh.slots.filter(slot => slot.admission === 'admitted').map(slot => slot.taskId)) : null;
    const accepted = work.children.filter(child => (!activeIds || activeIds.has(child.taskId)) && child.state === 'settled' &&
      child.outcome === 'advice_ready' && child.publicationDigest !== null);
    if (!accepted.length) return false;
    const command = await refreshOperationCommand({ environment: this.environment, target: this.target }, {
      expectedRefreshEpoch: this.epoch, expectedCheckpointVersion: work.checkpointVersion,
      results: accepted.map(child => ({ handoffId: child.handoffId, publicationDigest: child.publicationDigest! })),
    });
    try {
      const receipt = await this.lease.write(async () => NativeRootRefreshOperationReceiptSchema.parse(await this.port.refresh(this.lease.claim.selector, command)));
      await this.verifyOperation(receipt, command, 'refresh');
      if (receipt.attempt !== this.lease.claim.attempt + 1 || receipt.checkpointVersion !== work.checkpointVersion + 1) throw new DelegatedPersistenceUnknown();
      this.lease.close();
      return true;
    } catch (error) {
      if (error instanceof DelegatedPersistenceUnknown) {
        const recovered = await this.lookupOperation('refresh', command);
        if (recovered && recovered.attempt === this.lease.claim.attempt + 1 && recovered.checkpointVersion === work.checkpointVersion + 1) return true;
        throw error;
      }
      // Only a confirmed unsupported evidence transition can preserve the old
      // fixed blocked path. Unknown acknowledgement never starts another write.
      if (error instanceof DomainError && ['EVIDENCE_STALE', 'MEMORY_UNAVAILABLE', 'MEMORY_INTEGRITY', 'MEMORY_LIMIT', 'NOT_FOUND'].includes(error.code)) return false;
      throw error;
    }
  }
  async dispatch(logicalTaskId: string, expectedCheckpointVersion: number) {
    const refresh = this.refresh;
    const slot = refresh?.slots.find(item => item.logicalTaskId === logicalTaskId && item.admission === 'pending');
    if (!refresh || !slot) throw new DelegatedOutputRejected();
    const pending = refresh.slots.filter(item => item.admission === 'pending').length;
    const command = await refreshDispatchOperationCommand({ environment: this.environment, target: this.target }, {
      expectedRefreshEpoch: this.epoch, expectedCheckpointVersion, lineageDigest: refresh.lineageDigest, logicalTaskId,
    });
    try {
      const receipt = await this.lease.write(async () => NativeRootRefreshOperationReceiptSchema.parse(await this.port.refreshDispatch(this.lease.claim.selector, command)));
      await this.verifyOperation(receipt, command, 'dispatch');
      if (receipt.attempt !== this.lease.claim.attempt || receipt.checkpointVersion !== expectedCheckpointVersion ||
          receipt.lineageDigest !== refresh.lineageDigest || receipt.admittedTaskIds[0] !== slot.taskId || receipt.pendingCount !== pending - 1) throw new DelegatedPersistenceUnknown();
    } catch (error) {
      if (error instanceof DelegatedPersistenceUnknown) await this.lookupOperation('dispatch', command);
      throw error;
    }
    return this.work();
  }
}
