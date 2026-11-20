'use client';
import type { Operation } from '@pactwoven/contracts';
import type { RequestError } from '../lib/api';
import { readableRequestFailure, recordSaveState } from '../lib/presentation';
import { Icon } from './icon';
import { SupportDetails } from './support-details';
import { Alert } from './ui';

export function ResponsibilitySaveFeedback({ error, requestKey, operation, busy, onCheck }: {
  error: RequestError | null; requestKey: string | null; operation: Operation | null; busy: boolean; onCheck: () => void;
}) {
  const observed = operation && operation.status !== 'succeeded' ? recordSaveState(operation.status) : null;
  const references = { ...(requestKey ? { requestId: requestKey } : {}), ...(operation ? { operationId: operation.id } : {}) };
  return <>{error && <Alert title={requestKey ? 'Saving needs confirmation' : 'The draft was not saved'} tone="red"><p>{readableRequestFailure(error, 'save')}</p>{requestKey && <><button type="button" className="button secondary" disabled={busy} onClick={onCheck}>Check saved draft</button><p className="fine">Uses your original saved details to check the result.</p></>}<SupportDetails context="record-create" error={error} references={references} label="Draft recovery details" /></Alert>}
    {observed && <Alert title={observed.title} tone="blue"><p>{observed.message}</p>{!error && requestKey && <button type="button" className="button secondary" disabled={busy} onClick={onCheck}>Check saved draft</button>}<SupportDetails context="record-create" references={references} label="Draft recovery details" /></Alert>}</>;
}

export function ResponsibilitySaveFooter({ operation, requestKey, busy, locked, dirty }: {
  operation: Operation | null; requestKey: string | null; busy: boolean; locked: boolean; dirty: boolean;
}) {
  const observed = operation ? recordSaveState(operation.status) : null;
  const state = observed?.title ?? (requestKey ? 'Saving needs confirmation' : dirty ? 'Unsaved changes' : 'Ready when you are');
  const action = busy ? 'Saving draft…' : operation?.status === 'succeeded' ? 'Opening record…' : observed?.title ?? (requestKey ? 'Check saved draft above' : 'Save draft');
  return <div className="form-footer"><p>{state}<span>Creating a draft does not authorize execution.</span></p><button type="submit" className="button" disabled={locked} aria-busy={busy}>{action}{!busy && <Icon name="arrow-right" />}</button></div>;
}
