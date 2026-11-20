import { z } from 'zod';
import { DomainError } from '../../../packages/domain/src/errors';
import { NativeDelegationTargetSchema, type NativeDelegationTarget, type NativeDelegationClaimSelector,
  type NativeDelegationStoredClaim } from '../../../packages/db/src/native-delegation-repository';
import { NativeAdvisoryHandoffSchema, NativeDelegationReferenceSchema, NativeServiceIdentitySchema } from '../../../packages/contracts/src/native-delegation';
import { InstantSchema } from '../../../packages/contracts/src/core';

export class DelegatedInterrupted extends Error {
  constructor() { super('Current delegated execution authority is unavailable.'); }
}
export class DelegatedPersistenceUnknown extends Error {
  constructor() { super('The saved operation outcome has not been confirmed.'); }
}
export type DelegatedAuthorityObservation = { result: { state: string }; usableUntil: number | null };
export type DelegatedAuthorityObserver = (target: NativeDelegationTarget, options: { deadlineAt: number; signal?: AbortSignal }) => Promise<DelegatedAuthorityObservation>;
type Options = {
  target: NativeDelegationTarget;
  claim: (target: NativeDelegationTarget, milliseconds: number) => Promise<NativeDelegationStoredClaim>;
  renew: (selector: NativeDelegationClaimSelector, milliseconds: number) => Promise<{ validUntil: string }>;
  observe: DelegatedAuthorityObserver;
  deadlineAt: number;
  signal?: AbortSignal;
  heartbeatMilliseconds?: number;
  leaseMilliseconds?: number;
  now?: () => number;
};
const ClaimSchema = z.strictObject({ selector: NativeDelegationTargetSchema.extend({ handoffId: z.string().min(1).nullable(), leaseToken: z.uuid() }),
  validUntil: InstantSchema, identity: NativeServiceIdentitySchema, authority: NativeDelegationReferenceSchema,
  attempt: z.number().int().min(1).max(4), handoff: NativeAdvisoryHandoffSchema.nullable() });

/** One leased generation. Timers abort model/tools independently of a hung
 * authority request or database renew. Database writes still enforce the lease. */
export class DelegatedLease {
  readonly signal: AbortSignal;
  readonly claim: NativeDelegationStoredClaim;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private authorityUntil: number;
  private leaseUntil: number;
  private closed = false;
  private authorityTail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly cancel = () => this.close();

  private constructor(private readonly options: Options, claim: NativeDelegationStoredClaim, until: number) {
    this.claim = structuredClone(claim); this.authorityUntil = until; this.leaseUntil = Date.parse(claim.validUntil);
    this.now = options.now ?? Date.now; this.signal = this.controller.signal;
    options.signal?.addEventListener('abort', this.cancel, { once: true });
    if (options.signal?.aborted) this.close();
    this.armExpiry(); this.scheduleHeartbeat();
  }
  static async acquire(input: Options): Promise<DelegatedLease> {
    const target = NativeDelegationTargetSchema.parse(input.target), now = input.now ?? Date.now;
    const heartbeatMilliseconds = input.heartbeatMilliseconds ?? 3000, leaseMilliseconds = input.leaseMilliseconds ?? 15000;
    if (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= now() || input.signal?.aborted ||
      !Number.isInteger(heartbeatMilliseconds) || heartbeatMilliseconds < 1 || heartbeatMilliseconds > 5000 ||
      !Number.isInteger(leaseMilliseconds) || leaseMilliseconds < 1000 || leaseMilliseconds > 30000 || heartbeatMilliseconds >= leaseMilliseconds / 2) throw new DelegatedInterrupted();
    const options = { ...input, target, heartbeatMilliseconds, leaseMilliseconds };
    const controller = new AbortController(); const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    let timer = setTimeout(abort, Math.max(0, input.deadlineAt - now()));
    try {
      const observation = await interruptible(options.observe(target, { deadlineAt: input.deadlineAt, signal: controller.signal }), controller.signal);
      const until = observation.usableUntil;
      if (observation.result.state !== 'allowed' || until === null || !Number.isSafeInteger(until) || until <= now() || controller.signal.aborted) throw new DelegatedInterrupted();
      clearTimeout(timer); timer = setTimeout(abort, Math.max(0, Math.min(until, input.deadlineAt) - now()));
      // A lost claim acknowledgement is unknown; never perform model work or
      // another claim based on the same unconfirmed response.
      let claimed: NativeDelegationStoredClaim;
      try { claimed = ClaimSchema.parse(await interruptible(options.claim(target, leaseMilliseconds), controller.signal)); }
      catch { throw new DelegatedPersistenceUnknown(); }
      if (claimed.selector.organizationId !== target.organizationId || claimed.selector.taskId !== target.taskId || claimed.selector.generation !== target.generation ||
        Date.parse(claimed.validUntil) <= now() || controller.signal.aborted) throw new DelegatedInterrupted();
      const lease = new DelegatedLease(options, claimed, until); lease.assertCurrent(); return lease;
    } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  get usableUntil(): number { return Math.min(this.options.deadlineAt, this.authorityUntil, this.leaseUntil); }
  assertCurrent(): void {
    if (this.closed || this.signal.aborted || this.now() >= this.usableUntil) { this.close(); throw new DelegatedInterrupted(); }
  }
  async read<T>(operation: () => Promise<T>): Promise<T> {
    this.assertCurrent(); const value = await interruptible(operation(), this.signal); this.assertCurrent(); return value;
  }
  async write<T>(operation: () => Promise<T>): Promise<T> {
    return this.exclusiveAuthority(async () => {
      try { const value = await interruptible(operation(), this.signal); this.assertCurrent(); return value; }
      catch (error) {
        // These SQLSTATE-backed errors confirm transaction rollback. Network,
        // malformed response and deadline failures remain unknown acceptance.
        if (error instanceof DomainError && ['EVIDENCE_STALE', 'FORBIDDEN', 'ROOT_CONFLICT', 'DELEGATION_CONFLICT', 'VALIDATION_FAILED', 'VERSION_CONFLICT', 'MEMORY_UNAVAILABLE', 'MEMORY_LIMIT', 'MEMORY_INTEGRITY', 'NOT_FOUND'].includes(error.code)) {
          this.assertCurrent(); throw error;
        }
        this.close(); throw new DelegatedPersistenceUnknown();
      }
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); clearTimeout(this.heartbeat);
    this.options.signal?.removeEventListener('abort', this.cancel); this.controller.abort();
  }
  private armExpiry() {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => this.close(), Math.max(0, this.usableUntil - this.now()));
  }
  private scheduleHeartbeat() {
    if (this.closed) return;
    this.heartbeat = setTimeout(() => { void this.refresh(); }, this.options.heartbeatMilliseconds!);
  }
  /** Refresh temporarily withdraws the database proof. Keep its entire
   * observation/renewal interval separate from writes in either direction.
   * Model reads remain concurrent; expiry and cancellation still abort waits. */
  private async exclusiveAuthority<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.authorityTail;
    let release!: () => void;
    this.authorityTail = new Promise<void>(resolve => { release = resolve; });
    try {
      await interruptible(previous, this.signal);
      this.assertCurrent();
      return await operation();
    } finally { release(); }
  }
  private async refresh() {
    try {
      await this.exclusiveAuthority(async () => {
        const observation = await interruptible(this.options.observe(this.options.target, { deadlineAt: this.usableUntil, signal: this.signal }), this.signal);
        this.assertCurrent();
        if (observation.result.state !== 'allowed' || observation.usableUntil === null || !Number.isSafeInteger(observation.usableUntil) || observation.usableUntil <= this.now()) throw new DelegatedInterrupted();
        const renewed = await interruptible(this.options.renew(this.claim.selector, this.options.leaseMilliseconds!), this.signal);
        this.assertCurrent();
        const until = Date.parse(InstantSchema.parse(renewed.validUntil));
        if (until <= this.now()) throw new DelegatedInterrupted();
        this.authorityUntil = observation.usableUntil; this.leaseUntil = until;
        this.armExpiry();
      });
      this.scheduleHeartbeat();
    } catch { this.close(); }
  }
}

/** Observe rejection handlers even after cancellation, without waiting for a
 * non-cooperating dependency to finish before stopping model/tool execution. */
export function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DelegatedInterrupted());
    operation.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
