import { ZodError } from 'zod';
import { DomainError } from '../../../packages/domain/src/errors';
import { NativeGatewayError } from './azure-gateway';
import { DelegatedInterrupted, DelegatedPersistenceUnknown } from './delegated-lease';
import { DelegatedOutputRejected } from './delegated-output';

export type DelegatedStage = 'claim' | 'materials' | 'memory' | 'source' | 'plan' | 'checkpoint' |
  'handoff' | 'yield' | 'inputs' | 'paid_equipment' | 'model' | 'output' | 'publication' | 'completion' | 'failure_publication';
export type DelegatedDiagnostic = {
  runner: 'coordinator' | 'specialist';
  stage: DelegatedStage;
  failure: 'interrupted' | 'persistence_unknown' | 'output_rejected' | 'invalid_shape' |
    'authority_rejected' | 'evidence_rejected' | 'conflict' | 'model_unavailable' | 'model_rejected' | 'unexpected';
};
export type DelegatedDiagnosticReporter = (event: DelegatedDiagnostic) => void | Promise<void>;

/** Only fixed categories cross this boundary. Never retain an exception's text,
 * stack, provider payload, SQL details, task identity or operator content. */
export function reportDelegatedFailure(report: DelegatedDiagnosticReporter | undefined,
  runner: DelegatedDiagnostic['runner'], stage: DelegatedStage, error: unknown): void {
  try {
    let failure: DelegatedDiagnostic['failure'] = 'unexpected';
    if (error instanceof DelegatedPersistenceUnknown) failure = 'persistence_unknown';
    else if (error instanceof DelegatedInterrupted) failure = 'interrupted';
    else if (error instanceof DelegatedOutputRejected) failure = 'output_rejected';
    else if (error instanceof ZodError) failure = 'invalid_shape';
    else if (error instanceof NativeGatewayError) failure = ['INVALID_RESPONSE', 'REFUSED', 'INCOMPLETE', 'REJECTED'].includes(error.code)
      ? 'model_rejected' : 'model_unavailable';
    else if (error instanceof DomainError) {
      if (error.code === 'FORBIDDEN') failure = 'authority_rejected';
      else if (['EVIDENCE_STALE', 'MEMORY_UNAVAILABLE', 'MEMORY_LIMIT', 'MEMORY_INTEGRITY', 'NOT_FOUND'].includes(error.code)) failure = 'evidence_rejected';
      else if (['ROOT_CONFLICT', 'DELEGATION_CONFLICT', 'VERSION_CONFLICT'].includes(error.code)) failure = 'conflict';
    }
    // A callback typed as void can still return a promise. Observe rejection
    // without awaiting a slow sink or tying execution to its lifetime.
    void Promise.resolve(report?.({ runner, stage, failure })).catch(() => {});
  } catch { /* Diagnostics must not change execution, recovery or settlement. */ }
}
