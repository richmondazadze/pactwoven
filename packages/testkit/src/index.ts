export interface Clock { now(): Date }

export const systemClock: Clock = { now: () => new Date() };

export class VirtualClock implements Clock {
  private instant: number;
  constructor(initial: string | Date) {
    this.instant = new Date(initial).getTime();
    if (!Number.isFinite(this.instant)) throw new Error('Invalid virtual clock instant');
  }
  now(): Date { return new Date(this.instant); }
  advance(milliseconds: number): Date {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error('Clock advances must be nonnegative integer milliseconds');
    const next = this.instant + milliseconds;
    if (!Number.isFinite(new Date(next).getTime())) throw new Error('Virtual clock overflow');
    this.instant = next;
    return this.now();
  }
}

export class FaultInjector {
  private remaining = new Map<string, number>();
  arm(point: string, occurrences = 1): void {
    if (!point || !Number.isSafeInteger(occurrences) || occurrences < 1) throw new Error('Invalid fault configuration');
    this.remaining.set(point, occurrences);
  }
  hit(point: string): void {
    const remaining = this.remaining.get(point) ?? 0;
    if (remaining === 0) return;
    this.remaining.set(point, remaining - 1);
    throw new InjectedFault(point);
  }
}
export class InjectedFault extends Error {
  constructor(readonly point: string) { super(`Injected fault: ${point}`); this.name = 'InjectedFault'; }
}
