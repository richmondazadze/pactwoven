import { describe, expect, it } from 'vitest';
import { isNativeAgentConversationRoute, readNativeAgentInstructionJson } from './native-agent-conversation-http';

const origin = 'https://pactwoven.vercel.app';
const request = (body: string, headers: Record<string, string> = {}) => new Request(origin + '/v1/agent-work/root/instructions', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
});
describe('additive conversation transport', () => {
  it.each([
    ['/v1/agent-work/root/conversation', 'GET'], ['/v1/agent-work/root/instructions', 'POST'],
    ['/v1/agent-work/root/instructions/original_key', 'GET'], ['/v1/agent-work/root/instructions', 'OPTIONS'],
  ])('admits the intended method/path %s %s', (path, method) => expect(isNativeAgentConversationRoute(path, method)).toBe(true));
  it.each([
    ['/v1/agent-work/root/conversation', 'POST'], ['/v1/agent-work/root/instructions', 'GET'],
    ['/v1/agent-work/root/instructions/key', 'POST'], ['/v1/agent-work/root/instructions/key/extra', 'GET'],
    ['/v1/agent-work/root/conversation/', 'GET'], ['/v1/agent-work/root%2Fother/instructions', 'POST'],
    ['/v1/agent-work/root/control', 'POST'], ['/v1/agent-work/prepare', 'POST'],
  ])('does not admit another method/path %s %s', (path, method) => expect(isNativeAgentConversationRoute(path, method)).toBe(false));
  it('preserves full Unicode text for later contract validation', async () => {
    const text = 'Plan a remote workshop. '.repeat(100) + '参加者';
    expect(await readNativeAgentInstructionJson(request(JSON.stringify({ text, expectedInstructionVersion: 0, expectedControlVersion: 2 })))).toEqual({ text, expectedInstructionVersion: 0, expectedControlVersion: 2 });
  });
  it.each([
    '{"text":"first","text":"second"}', '{"text":"first","te\\u0078t":"second"}',
    '{"expectedControlVersion":1,"expectedControlVersion":2}', '[]', 'null', '{"value":1e999}',
  ])('rejects ambiguous or malformed JSON before identity observation', async body => {
    await expect(readNativeAgentInstructionJson(request(body))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('rejects oversized and compressed bodies', async () => {
    await expect(readNativeAgentInstructionJson(request(JSON.stringify({ text: 'a'.repeat(65536) })))).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    await expect(readNativeAgentInstructionJson(request('{}', { 'Content-Encoding': 'gzip' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });
});
