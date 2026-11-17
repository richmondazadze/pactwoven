import { describe, expect, it, vi } from 'vitest';
import type { SupplierRelationshipHttpGateway } from '@pactwoven/contracts';
import { createApp } from './app.js';
import { readDevelopmentConfig } from './config.js';

const origin = 'https://pactwoven.vercel.app';
const path = '/v1/supplier-relationships/recover';
const query = {
  identity: {
    scope: { environment: 'development', buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier', supplierRelationshipId: 'relationship' },
    organizationId: 'buyer', actorId: 'actor', idempotencyKey: 'original_request_0001',
  },
  commandDigest: 'a'.repeat(64), action: 'create',
};
const headers = { Origin: origin, Authorization: 'Bearer supplier-test-token', 'Content-Type': 'application/json' };
function fixture(configured = true) {
  const submit = vi.fn<SupplierRelationshipHttpGateway['submit']>(async () => ({ kind: 'relationship-recover', original: null }));
  const verifyIdentity = vi.fn(async () => { throw new Error('Generic identity middleware must not consume private supplier requests.'); });
  const app = createApp({ allowedOrigins: [origin], verifyIdentity,
    ...(configured ? { supplierRelationshipGateway: { submit } } : {}) });
  return { app, submit, verifyIdentity };
}

describe('supplier routes within the complete API middleware stack', () => {
  it('keeps global security headers while routing bounded originals directly to the supplier gateway', async () => {
    const f = fixture();
    const response = await f.app.request(path, { method: 'POST', headers, body: JSON.stringify(query) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'relationship-recover', original: null });
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-correlation-id')).toBeTruthy();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('supplier-test-token', { kind: 'relationship-recover', query });
    expect(f.verifyIdentity).not.toHaveBeenCalled();
  });

  it('rejects foreign origins, unsigned calls and read-key injection before any gateway call', async () => {
    const f = fixture();
    for (const [patch, status] of [
      [{ Origin: 'https://unrelated.example' }, 403],
      [{ Authorization: '' }, 401],
      [{ 'Idempotency-Key': 'replacement_key_0001' }, 422],
    ] as const) {
      const response = await f.app.request(path, { method: 'POST', headers: { ...headers, ...patch }, body: JSON.stringify(query) });
      expect(response.status).toBe(status);
    }
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.verifyIdentity).not.toHaveBeenCalled();
  });

  it('handles allowed preflight and disabled setup without falling through to generic authorization', async () => {
    const f = fixture(false);
    const preflight = await f.app.request(path, { method: 'OPTIONS', headers: { Origin: origin,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
    expect(preflight.status).toBe(204);
    const response = await f.app.request(path, { method: 'POST', headers, body: JSON.stringify(query) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'SETUP_REQUIRED' } });
    expect(f.verifyIdentity).not.toHaveBeenCalled();
  });

  it('rejects supplier configuration without its required base identity/database bindings', () => {
    expect(() => readDevelopmentConfig({ SUPPLIER_RELATIONSHIP_LANES: '{}' })).toThrow('Invalid development API configuration');
  });
});
