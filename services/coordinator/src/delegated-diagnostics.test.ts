import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DomainError } from '../../../packages/domain/src/errors';
import { NativeGatewayError } from './azure-gateway';
import { DelegatedInterrupted, DelegatedPersistenceUnknown } from './delegated-lease';
import { DelegatedOutputRejected } from './delegated-output';
import { reportDelegatedFailure } from './delegated-diagnostics';

describe('private delegated execution diagnostics', () => {
  it.each([
    [new DelegatedInterrupted(), 'interrupted'],
    [new DelegatedPersistenceUnknown(), 'persistence_unknown'],
    [new DelegatedOutputRejected(), 'output_rejected'],
    [z.string().safeParse({ privateNote: 'not for logs' }).error, 'invalid_shape'],
    [new DomainError('FORBIDDEN', 403, 'private authority details'), 'authority_rejected'],
    [new DomainError('EVIDENCE_STALE', 409, 'private note content'), 'evidence_rejected'],
    [new DomainError('VERSION_CONFLICT', 409, 'private version details'), 'conflict'],
    [new NativeGatewayError('NETWORK'), 'model_unavailable'],
    [new NativeGatewayError('INVALID_RESPONSE'), 'model_rejected'],
    [Object.assign(new Error('private SQL, provider credential and prompt'), { code: 'PRIVATE' }), 'unexpected'],
    [{ name: 'DomainError', code: 'FORBIDDEN', message: 'untrusted lookalike' }, 'unexpected'],
  ])('emits only fixed categories for %s', (error, failure) => {
    const report = vi.fn();
    reportDelegatedFailure(report, 'specialist', 'publication', error);
    expect(report.mock.calls).toEqual([[{ runner: 'specialist', stage: 'publication', failure }]]);
  });
  it('cannot interrupt execution when the diagnostic sink throws', () => {
    expect(() => reportDelegatedFailure(() => { throw new Error('sink unavailable'); },
      'coordinator', 'inputs', new DelegatedPersistenceUnknown())).not.toThrow();
    expect(() => reportDelegatedFailure(undefined, 'coordinator', 'claim', new Error())).not.toThrow();
  });
  it('observes asynchronous sink rejection without delaying the caller', async () => {
    const report = vi.fn(async () => { throw new Error('private async sink failure'); });
    expect(reportDelegatedFailure(report, 'coordinator', 'claim', new Error())).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(report).toHaveBeenCalledOnce();
  });
  it('returns immediately when a diagnostic sink never settles', () => {
    const report = vi.fn(() => new Promise<void>(() => {}));
    expect(reportDelegatedFailure(report, 'specialist', 'model', new Error())).toBeUndefined();
    expect(report).toHaveBeenCalledOnce();
  });
});
