import { DomainError } from '@pactwoven/domain';
import { readBoundedStrictJson } from './strict-json-body';

/** Additive P3 routes. Existing work endpoints keep their existing dispatcher. */
export function isNativeAgentConversationRoute(path: string, method: string): boolean {
  if (/^\/v1\/agent-work\/[A-Za-z0-9_-]+\/conversation$/.test(path)) return method === 'GET' || method === 'OPTIONS';
  if (/^\/v1\/agent-work\/[A-Za-z0-9_-]+\/instructions$/.test(path)) return method === 'POST' || method === 'OPTIONS';
  return /^\/v1\/agent-work\/[A-Za-z0-9_-]+\/instructions\/[A-Za-z0-9_-]+$/.test(path) && (method === 'GET' || method === 'OPTIONS');
}

export async function readNativeAgentInstructionJson(request: Request): Promise<object> {
  try { return (await readBoundedStrictJson(request, 65536)).value; }
  catch (error) {
    if (error instanceof DomainError && error.code === 'CUSTODY_INPUT_INVALID') {
      throw new DomainError('VALIDATION_FAILED', 422, 'Use one unambiguous JSON object for this instruction update.');
    }
    throw error;
  }
}
