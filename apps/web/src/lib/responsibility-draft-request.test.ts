import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchResponsibilityDraft, rejectedInitialDraft, ResponsibilityDraftRequestSchema } from './responsibility-draft-request';
import { RequestError } from './api';
const original = () => ResponsibilityDraftRequestSchema.parse({ key: 'original_request_0000001', body: { expectedVersion: 0, mandateVersion: null, authorityEpoch: null, payload: {
  title: 'Office equipment', description: 'A controlled draft', siteId: 'site_one', window: { startsAt: '2026-11-18T12:00:00.000Z', endsAt: '2026-11-19T12:00:00.000Z', timeZone: 'America/Chicago' }, acceptancePolicy: 'Inspect the delivered quantity.', requirements: [{ id: 'original_requirement_001', description: 'Chairs', quantity: 4, unit: 'items', evidenceRule: 'Count the items.' }],
} } });
const operation = { id: 'operation_original', environment: 'development', status: 'succeeded', aggregateId: 'record_original', aggregateVersion: 1, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null };
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test'));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('responsibility draft original-request recovery', () => {
  it('preserves the exact original across an unknown result, authorization denial and successful reauthentication', async () => {
    const request = original();
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce(Response.json({ error: { code: 'FORBIDDEN', message: 'Permission observation unavailable', correlationId: 'reference' } }, { status: 403 })).mockResolvedValueOnce(Response.json(operation));
    vi.stubGlobal('fetch', fetcher);
    const first = await dispatchResponsibilityDraft(request, async () => 'first_token', false);
    expect(first).toMatchObject({ kind: 'error', retainOriginal: true });
    const second = await dispatchResponsibilityDraft(request, async () => 'expired_token', true);
    expect(second).toMatchObject({ kind: 'error', retainOriginal: true, error: { status: 403 } });
    const third = await dispatchResponsibilityDraft(request, async () => 'fresh_token', true);
    expect(third).toEqual({ kind: 'observed', operation });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, init] of fetcher.mock.calls) {
      expect(init.body).toBe(JSON.stringify(request.body));
      expect(init.headers).toMatchObject({ 'Idempotency-Key': request.key });
    }
    expect(fetcher.mock.calls[2]![1].headers.Authorization).toBe('Bearer fresh_token');
    expect(request.body.payload.requirements[0]!.id).toBe('original_requirement_001');
  });
  it('retains a prior unknown request through a later validation denial', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'VALIDATION_FAILED', message: 'Changed validation', correlationId: 'reference' } }, { status: 422 })));
    expect(await dispatchResponsibilityDraft(original(), async () => 'token', true)).toMatchObject({ kind: 'error', retainOriginal: true });
  });
  it('allows editing only after a definite initial rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid original', correlationId: 'reference' } }, { status: 422 })));
    expect(await dispatchResponsibilityDraft(original(), async () => 'token', false)).toMatchObject({ kind: 'error', retainOriginal: false });
    for (const error of [new RequestError('IDEMPOTENCY_CONFLICT', 'Conflicting request', 409), new RequestError('REQUEST_FAILED', 'Unknown result', 400), new RequestError('REQUEST_TIMEOUT', 'Timeout', 408)]) expect(rejectedInitialDraft(error, false)).toBe(false);
  });
  it('keeps the original on a missing sign-in without dispatching a retry', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await dispatchResponsibilityDraft(original(), async () => null, true)).toMatchObject({ kind: 'error', retainOriginal: true, error: { code: 'SESSION_REQUIRED' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not turn an unverified operation response into a recorded draft', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ success: true })));
    expect(await dispatchResponsibilityDraft(original(), async () => 'token', false)).toMatchObject({ kind: 'error', retainOriginal: true, error: { code: 'RESPONSE_UNVERIFIED' } });
  });
  it('returns pending observations without claiming success or changing the request', async () => {
    const request = original(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...operation, status: 'pending' })));
    expect(await dispatchResponsibilityDraft(request, async () => 'token', true)).toMatchObject({ kind: 'observed', operation: { status: 'pending' } });
    expect(request).toEqual(original());
  });
});
