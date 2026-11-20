import { createScanner, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { SOLANA_JSON_MAX_DEPTH, SOLANA_JSON_MAX_TOKENS, SOLANA_RPC_MAX_BYTES, rejectSolana } from './types.js';

export type SolanaJsonNumber = Readonly<{ lexeme: string }>;
export interface SolanaJsonObject { readonly [key: string]: SolanaJsonValue }
export type SolanaJsonValue = null | boolean | string | SolanaJsonNumber | SolanaJsonObject | readonly SolanaJsonValue[];
const numericLeaves = new WeakSet<object>();
// jsonc-parser 3.3.1 declares ambient const enums, incompatible with isolated/verbatim imports.
// These are its pinned scanner ABI values; no generated enum or runtime namespace is imported.
const ScanError = { None: 0 } as const;
const SyntaxKind = { OpenBraceToken: 1, CloseBraceToken: 2, OpenBracketToken: 3, CloseBracketToken: 4,
  CommaToken: 5, StringLiteral: 10, LineCommentTrivia: 12, BlockCommentTrivia: 13,
  LineBreakTrivia: 14, Trivia: 15, Unknown: 16, EOF: 17 } as const;
export const isSolanaJsonNumber = (value: unknown): value is SolanaJsonNumber =>
  typeof value === 'object' && value !== null && numericLeaves.has(value);

/** Original numeric source text is retained; AST numeric values are never consumed. */
export function parseSolanaJson(input: Uint8Array): SolanaJsonValue {
  if (!(input instanceof Uint8Array) || input.byteLength > SOLANA_RPC_MAX_BYTES) rejectSolana('SIZE_LIMIT');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
  catch { return rejectSolana('INVALID_UTF8'); }
  const scanner = createScanner(text, false);
  const containers: Array<{ object: boolean; expectingKey: boolean; keys: Set<string> }> = [];
  let depth = 0, tokens = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (scanner.getTokenError() !== ScanError.None || token === SyntaxKind.Unknown
      || token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) rejectSolana('INVALID_JSON');
    if (token === SyntaxKind.Trivia || token === SyntaxKind.LineBreakTrivia) continue;
    if (++tokens > SOLANA_JSON_MAX_TOKENS) rejectSolana('NODE_LIMIT');
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      if (++depth > SOLANA_JSON_MAX_DEPTH) rejectSolana('DEPTH_LIMIT');
      containers.push({ object: token === SyntaxKind.OpenBraceToken, expectingKey: token === SyntaxKind.OpenBraceToken, keys: new Set() });
    } else if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) {
      if (--depth < 0) rejectSolana('INVALID_JSON');
      containers.pop();
    } else {
      const container = containers.at(-1);
      if (container?.object && token === SyntaxKind.CommaToken) container.expectingKey = true;
      if (container?.object && container.expectingKey && token === SyntaxKind.StringLiteral) {
        const key = scanner.getTokenValue();
        if (container.keys.has(key)) rejectSolana('DUPLICATE_KEY');
        container.keys.add(key); container.expectingKey = false;
      }
    }
  }
  if (depth !== 0 || scanner.getTokenError() !== ScanError.None) rejectSolana('INVALID_JSON');
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (!tree || errors.length) rejectSolana('INVALID_JSON');
  function convert(node: Node): SolanaJsonValue {
    if (node.offset < 0 || node.length < 1 || node.offset + node.length > text.length) rejectSolana('INVALID_JSON');
    if (node.type === 'number') {
      const leaf = Object.freeze({ lexeme: text.slice(node.offset, node.offset + node.length) });
      numericLeaves.add(leaf); return leaf;
    }
    if (node.type === 'object') {
      const record: Record<string, SolanaJsonValue> = Object.create(null);
      for (const property of node.children ?? []) {
        if (property.type !== 'property' || property.children?.length !== 2) rejectSolana('INVALID_JSON');
        const key = property.children[0]!, value = property.children[1]!;
        if (key.type !== 'string' || typeof key.value !== 'string') rejectSolana('INVALID_JSON');
        if (Object.hasOwn(record, key.value)) rejectSolana('DUPLICATE_KEY');
        record[key.value] = convert(value);
      }
      return Object.freeze(record);
    }
    if (node.type === 'array') return Object.freeze((node.children ?? []).map(convert));
    if (node.type === 'null') return null;
    if (node.type === 'boolean' && typeof node.value === 'boolean') return node.value;
    if (node.type === 'string' && typeof node.value === 'string') return node.value;
    return rejectSolana('INVALID_JSON');
  }
  return convert(tree);
}

export function solanaJsonObject(value: SolanaJsonValue | undefined, allowed: readonly string[], required = allowed): SolanaJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isSolanaJsonNumber(value)) rejectSolana('INVALID_SCHEMA');
  const record = value as SolanaJsonObject;
  if (Object.keys(record).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(record, key))) rejectSolana('INVALID_SCHEMA');
  return record;
}
export function solanaJsonArray(value: SolanaJsonValue | undefined, maximum: number): readonly SolanaJsonValue[] {
  if (!Array.isArray(value) || value.length > maximum) rejectSolana('INVALID_SCHEMA');
  return value as readonly SolanaJsonValue[];
}
export function solanaJsonString(value: SolanaJsonValue | undefined, maximum = 512): string {
  if (typeof value !== 'string' || value.length > maximum) rejectSolana('INVALID_SCHEMA');
  return value;
}
export function solanaIntegerText(value: SolanaJsonValue | undefined, signed = false): string {
  if (!isSolanaJsonNumber(value) || !(signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value.lexeme)
    || value.lexeme.length > 20) rejectSolana('INVALID_INTEGER');
  const number = BigInt(value.lexeme);
  if (signed ? number < -9_223_372_036_854_775_808n || number > 9_223_372_036_854_775_807n : number > 18_446_744_073_709_551_615n) rejectSolana('INVALID_INTEGER');
  return value.lexeme;
}
export function solanaSmallInteger(value: SolanaJsonValue | undefined, maximum: number, minimum = 0): number {
  const number = BigInt(solanaIntegerText(value));
  if (number < BigInt(minimum) || number > BigInt(maximum)) rejectSolana('INVALID_INTEGER');
  return Number(number);
}
