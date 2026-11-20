import { describe, expect, it, vi } from 'vitest';
import { RequestError } from './api';
import { copySupportDetails, readableRequestFailure, recordSaveState, supportDetailEntries, supportDetailText, workspaceTypeLabel } from './presentation';

describe('everyday error and support presentation', () => {
  it('preserves actionable access, missing-record, stale and validation distinctions', () => {
    expect(readableRequestFailure(new RequestError('AUTH_REQUIRED', 'internal', 401))).toContain('sign-in');
    expect(readableRequestFailure(new RequestError('FORBIDDEN', 'internal', 403))).toContain('workspace access');
    expect(readableRequestFailure(new RequestError('NOT_FOUND', 'internal', 404))).toContain('not available');
    expect(readableRequestFailure(new RequestError('VERSION_CONFLICT', 'internal', 409))).toContain('record changed');
    expect(readableRequestFailure(new RequestError('VALIDATION_FAILED', 'internal', 422))).toContain('highlighted details');
  });
  it('never repeats arbitrary backend messages, stacks or validation values', () => {
    const privateLocation = new URL('postgres://private-host');
    privateLocation.username = 'user'; privateLocation.password = 'credential';
    const error = new RequestError('UNKNOWN_SQL_ERROR', privateLocation.href, 503, 'safe_ref', { field: ['private_user_text'] });
    const copy = readableRequestFailure(error, 'save');
    const details = supportDetailText('record-create', error);
    for (const value of ['postgres', 'credential', 'private-host', 'private_user_text', 'UNKNOWN_SQL_ERROR']) {
      expect(copy).not.toContain(value); expect(details).not.toContain(value);
    }
    expect(copy).toContain('could not confirm');
    expect(details).toContain('safe_ref');
    expect(details).toContain('UNEXPECTED_RESPONSE');
  });
  it('does not describe unknown or accepted operations as saved', () => {
    for (const status of ['accepted', 'pending', 'unknown'] as const) {
      const copy = recordSaveState(status);
      expect(copy.title).not.toBe('Draft saved');
      expect(copy.message).toContain('Check the saved draft');
    }
    expect(recordSaveState('failed').title).toBe('The save was rejected');
    expect(recordSaveState('succeeded').title).toBe('Draft saved');
  });
  it('retains exact safe request, operation and record references only in explicit details', () => {
    const details = supportDetailText('record-create', new RequestError('NETWORK_UNAVAILABLE', 'private transport', 0, 'correlation_original_0001'), { requestId: 'request_original_0001', operationId: 'operation_original_0001', recordId: 'record_original_0001', revision: 7 });
    for (const value of ['correlation_original_0001', 'request_original_0001', 'operation_original_0001', 'record_original_0001', 'Revision: 7']) expect(details).toContain(value);
    expect(details).not.toContain('private transport');
  });
  it('rejects injected diagnostics and invalid references instead of copying them', () => {
    const entries = supportDetailEntries('record-list', new RequestError('AUTH_REQUIRED\nAuthorization: secret', 'hidden', 2000, 'bad\nref'), { requestId: 'Bearer token.value', recordId: '../private', revision: -1 });
    expect(entries).toEqual([['Area', 'Work records'], ['Issue', 'UNEXPECTED_RESPONSE']]);
  });
  it('does not conflate test workspaces with live workspaces', () => {
    expect(workspaceTypeLabel.production).toBe('Live workspace');
    expect(new Set(Object.values(workspaceTypeLabel)).size).toBe(4);
    expect(workspaceTypeLabel.development).toBe('Test workspace');
  });
  it('copies only prepared support text and reports a successful clipboard write', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    const text = supportDetailText('workspace-access', new RequestError('FORBIDDEN', 'not copied', 403, 'reference_001'));
    expect(await copySupportDetails(text, { writeText })).toBe('copied');
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
  });
  it('allows a manual-copy fallback when clipboard access is unavailable or denied', async () => {
    expect(await copySupportDetails('prepared text')).toBe('unavailable');
    expect(await copySupportDetails('prepared text', { writeText: async () => { throw new Error('private browser error'); } })).toBe('unavailable');
  });
});
