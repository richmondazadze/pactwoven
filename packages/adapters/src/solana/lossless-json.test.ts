import { describe, expect, it } from 'vitest';
import { isSolanaJsonNumber, parseSolanaJson, solanaIntegerText, solanaJsonObject, solanaSmallInteger } from './lossless-json.js';
import { SOLANA_RPC_MAX_BYTES, SolanaDecodeError } from './types.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (text: string) => parseSolanaJson(bytes(text));
function code(body: () => unknown, expected: string) {
  try { body(); throw new Error('Expected decoder rejection'); }
  catch (error) { expect(error).toBeInstanceOf(SolanaDecodeError); expect((error as SolanaDecodeError).code).toBe(expected); }
}
describe('strict lossless Solana JSON', () => {
  it('retains exact integer lexemes through u64 and i64 extremes', () => {
    for (const text of ['0', '9007199254740993', '18446744073709551615']) expect(solanaIntegerText(parse(text))).toBe(text);
    for (const text of ['-9223372036854775808', '9223372036854775807']) expect(solanaIntegerText(parse(text), true)).toBe(text);
    for (const text of ['-0', '-1', '1.0', '1e0', '18446744073709551616']) code(() => solanaIntegerText(parse(text)), 'INVALID_INTEGER');
    for (const text of ['-9223372036854775809', '9223372036854775808']) code(() => solanaIntegerText(parse(text), true), 'INVALID_INTEGER');
    expect(solanaSmallInteger(parse('255'), 255)).toBe(255);
    code(() => solanaSmallInteger(parse('256'), 255), 'INVALID_INTEGER');
  });
  it('rejects equal, differing, escaped and nested duplicate keys', () => {
    for (const text of ['{"a":1,"a":1}', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}',
      '{"x":[{"a":null,"a":null}]}', '{"a":{},"a":{}}', '{"a":{"x":1},"a":{"x":1}}']) code(() => parse(text), 'DUPLICATE_KEY');
    expect(() => parse('{"a":{"same":1},"b":{"same":2},"text":" [ \\" ["}')).not.toThrow();
  });
  it('rejects invalid syntax and non-JSON extensions', () => {
    for (const text of ['', 'NaN', 'Infinity', '01', '+1', '1.', '1e', '{"a":1,}', '/*comment*/{}', '{} //comment',
      '{"a":true} trailing', '[1,]', '[}', '\uFEFF{}', '"unterminated']) expect(() => parse(text)).toThrow(SolanaDecodeError);
  });
  it('enforces byte, depth and lexical-node ceilings before recursive parsing', () => {
    expect(parse('{}' + ' '.repeat(SOLANA_RPC_MAX_BYTES - 2))).toEqual({});
    code(() => parse('{}' + ' '.repeat(SOLANA_RPC_MAX_BYTES - 1)), 'SIZE_LIMIT');
    expect(() => parse('['.repeat(64) + '0' + ']'.repeat(64))).not.toThrow();
    code(() => parse('['.repeat(65) + '0' + ']'.repeat(65)), 'DEPTH_LIMIT');
    code(() => parse('[' + '0,'.repeat(9000) + '0]'), 'NODE_LIMIT');
    code(() => parseSolanaJson(Uint8Array.of(0xc0, 0xaf)), 'INVALID_UTF8');
    code(() => parseSolanaJson(Uint8Array.of(0xe2, 0x82)), 'INVALID_UTF8');
  });
  it('keeps wrappers unforgeable from JSON objects and structures prototype-safe and immutable', () => {
    const data = solanaJsonObject(parse('{"__proto__":{"polluted":true},"lexeme":"1","n":1}'), ['__proto__', 'lexeme', 'n']);
    expect(Object.getPrototypeOf(data)).toBe(null); expect(Object.hasOwn(data, '__proto__')).toBe(true);
    expect(Object.hasOwn({}, 'polluted')).toBe(false); expect(Object.isFrozen(data)).toBe(true);
    expect(isSolanaJsonNumber(data.n)).toBe(true); expect(isSolanaJsonNumber(parse('{"lexeme":"1"}'))).toBe(false);
    code(() => solanaIntegerText(parse('{"lexeme":"1"}')), 'INVALID_INTEGER');
    expect(() => Object.assign(data, { n: null })).toThrow();
  });
});
