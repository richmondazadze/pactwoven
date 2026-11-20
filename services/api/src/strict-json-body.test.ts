import { describe, expect, it } from 'vitest';
import { readBoundedStrictJson } from './strict-json-body';
import { readCustodySetupJson } from './custody-setup-routes';

const request = (body: string) => new Request('https://api.example/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
});
describe('shared strict JSON transport', () => {
  it('accepts a full Unicode planning prompt while retaining actual byte length', async () => {
    const value = { prompt: '漢'.repeat(12_000) }, body = JSON.stringify(value);
    expect(await readBoundedStrictJson(request(body), 65_536)).toEqual({ value, bytes: Buffer.byteLength(body) });
  });
  it('enforces the larger ceiling on actual bytes and preserves custody limits', async () => {
    const body = JSON.stringify({ prompt: 'x'.repeat(65_522) });
    expect(Buffer.byteLength(body)).toBe(65_535);
    expect((await readBoundedStrictJson(request(body + ' '), 65_536)).bytes).toBe(65_536);
    await expect(readBoundedStrictJson(request(body + '  '), 65_536)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    await expect(readCustodySetupJson(request('{}'), 65_536)).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
    await expect(readCustodySetupJson(request(body), 8_192)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });
  it('still rejects escaped duplicate fields in a large otherwise-valid object', async () => {
    const body = '{"prompt":"' + 'x'.repeat(12_000) + '","scope":{"id":1,"i\\u0064":2}}';
    await expect(readBoundedStrictJson(request(body), 65_536)).rejects.toMatchObject({ code: 'CUSTODY_INPUT_INVALID' });
  });
});
