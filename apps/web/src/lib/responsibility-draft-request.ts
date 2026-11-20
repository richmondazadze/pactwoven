import { z } from 'zod';
import { CreateResponsibilityCommandSchema, IdempotencyKeySchema, OperationSchema, type Operation } from '@pactwoven/contracts';
import { apiRequest, RequestError, type TokenSource } from './api';

export const ResponsibilityDraftRequestSchema = z.strictObject({ key: IdempotencyKeySchema, body: CreateResponsibilityCommandSchema });
export type ResponsibilityDraftRequest = z.infer<typeof ResponsibilityDraftRequestSchema>;
export type DraftDispatchResult = { kind: 'observed'; operation: Operation } | { kind: 'error'; error: RequestError; retainOriginal: boolean };

// A denial of a later retry cannot prove the earlier attempt was never saved.
// Only a definitive rejection of a newly created request permits its removal.
export function rejectedInitialDraft(error: RequestError, recovering: boolean) {
  if (recovering) return false;
  return (['VALIDATION_FAILED'].includes(error.code) && [400, 422].includes(error.status)) ||
    (['AUTH_REQUIRED', 'SESSION_REQUIRED'].includes(error.code) && error.status === 401) ||
    (error.code === 'FORBIDDEN' && error.status === 403);
}
export async function dispatchResponsibilityDraft(request: { key: string; body: unknown }, getToken: TokenSource, recovering: boolean): Promise<DraftDispatchResult> {
  try {
    const original = ResponsibilityDraftRequestSchema.parse(request);
    const operation = await apiRequest('/v1/responsibilities', OperationSchema, getToken, { body: original.body, idempotencyKey: original.key });
    return { kind: 'observed', operation };
  } catch (failure) {
    const error = failure instanceof RequestError ? failure : new RequestError('UNCONFIRMED', 'The saved draft result could not be verified.');
    return { kind: 'error', error, retainOriginal: !rejectedInitialDraft(error, recovering) };
  }
}
