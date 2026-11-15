import { describe, expect, it } from 'vitest';
import { canonicalJson, commandDigest } from './canonical.js';

describe('canonical command identity', () => {
  it('normalizes object order while preserving array semantics', async () => {
    expect(await commandDigest({ a: '1', b: ['x', 'y'] })).toBe(await commandDigest({ b: ['x', 'y'], a: '1' }));
    expect(await commandDigest({ a: '1', b: ['x', 'y'] })).not.toBe(await commandDigest({ a: '1', b: ['y', 'x'] }));
    expect(await commandDigest({ amount: '9007199254740993' })).not.toBe(await commandDigest({ amount: '9007199254740992' }));
  });
  it('rejects values that JSON would silently discard or coerce', () => {
    expect(() => canonicalJson({ value: undefined })).toThrow();
    expect(() => canonicalJson({ value: Number.NaN })).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
  });
});
