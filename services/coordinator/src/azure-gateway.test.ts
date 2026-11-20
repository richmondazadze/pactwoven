import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { azureDeployments, createAzureGateway, NativeGatewayError, normalizeAzureResponsesEndpoint, type ReasoningRole } from './azure-gateway.js';

const endpoint = 'https://test-resource.services.ai.azure.com/openai/v1/responses';
const apiKey = 'private-test-key-never-in-errors';
const output = z.strictObject({ answer: z.string() });
function envelope(value: unknown = { answer: 'Ready' }) {
  return { status: 'completed', output: [{ type: 'reasoning', summary: [{ text: 'must not be surfaced' }] },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } };
}
const request = (role: ReasoningRole = 'coordinator', signal = new AbortController().signal) => ({
  role, instructions: 'Return the answer.', input: 'Ready?', schema: output, schemaName: 'test_answer', signal,
});

describe('Azure Responses gateway', () => {
  it.each(['/openai/v1', '/openai/v1/', '/openai/v1/responses', '/openai/v1/responses/'])('normalizes %s without duplicating responses', path => {
    expect(normalizeAzureResponsesEndpoint(`https://test-resource.services.ai.azure.com${path}`)).toBe(endpoint);
  });
  it.each(['http://test-resource.services.ai.azure.com/openai/v1', 'https://evil.example/openai/v1',
    'https://user:secret@test-resource.services.ai.azure.com/openai/v1', `${endpoint}?key=secret`, `${endpoint}#secret`,
    'https://test-resource.services.ai.azure.com:444/openai/v1', 'https://test-resource.services.ai.azure.com/other',
    'https://services.ai.azure.com.evil.example/openai/v1'])('rejects unsafe configuration %s', value => {
    expect(() => normalizeAzureResponsesEndpoint(value)).toThrow(NativeGatewayError);
  });
  it.each(Object.keys(azureDeployments) as ReasoningRole[])('uses the selected deployment for %s and isolates credentials', async role => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(envelope()));
    const result = await createAzureGateway({ endpoint, apiKey }, fetcher).complete(request(role));
    expect(result).toEqual({ value: { answer: 'Ready' }, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }, deployment: azureDeployments[role] });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({ 'content-type': 'application/json', 'api-key': apiKey });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: azureDeployments[role], store: false, stream: false, reasoning: { effort: 'low' }, text: { format: { strict: true, name: 'test_answer' } } });
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain('must not be surfaced');
  });
  it.each([[401, 'ACCESS_DENIED', false], [403, 'ACCESS_DENIED', false], [429, 'RATE_LIMITED', true], [503, 'UNAVAILABLE', true], [400, 'REJECTED', false]] as const)(
    'sanitizes HTTP %s and classifies retry behavior', async (status, code, retryable) => {
      const gateway = createAzureGateway({ endpoint, apiKey }, vi.fn<typeof fetch>().mockResolvedValue(new Response(apiKey, { status })));
      await expect(gateway.complete(request())).rejects.toMatchObject({ code, retryable });
      try { await gateway.complete(request()); } catch (error) { expect(String(error)).not.toContain(apiKey); }
    });
  it('sanitizes transport exceptions containing secrets', async () => {
    const gateway = createAzureGateway({ endpoint, apiKey }, vi.fn<typeof fetch>().mockRejectedValue(new Error(apiKey)));
    await expect(gateway.complete(request())).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
  });
  it.each([
    { ...envelope(), status: 'incomplete' },
    { ...envelope(), error: { message: apiKey } },
    envelope({ answer: 12 }), envelope({ answer: 'Ready', extra: apiKey }),
    { ...envelope(), usage: { input_tokens: 11, output_tokens: 7, total_tokens: 99 } },
    { ...envelope(), output: [{ type: 'function_call', name: 'send_money' }] },
    { ...envelope(), output: [] },
  ])('rejects incomplete, malformed or unexpected output', async value => {
    const gateway = createAzureGateway({ endpoint, apiKey }, vi.fn<typeof fetch>().mockResolvedValue(Response.json(value)));
    await expect(gateway.complete(request())).rejects.toBeInstanceOf(NativeGatewayError);
  });
  it('distinguishes refusal without publishing provider text', async () => {
    const value = { ...envelope(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: apiKey }] }] };
    const gateway = createAzureGateway({ endpoint, apiKey }, vi.fn<typeof fetch>().mockResolvedValue(Response.json(value)));
    await expect(gateway.complete(request())).rejects.toMatchObject({ code: 'REFUSED', retryable: false });
  });
  it.each(['schema', 'refusal', 'incomplete'] as const)('preserves safe measured usage on a %s response without provider text', async mode => {
    const value = mode === 'schema' ? envelope({ answer: 12, secret: apiKey }) : mode === 'incomplete' ? { ...envelope(), status: 'incomplete', error: { message: apiKey } }
      : { ...envelope(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: apiKey }] }] };
    const gateway = createAzureGateway({ endpoint, apiKey }, vi.fn<typeof fetch>().mockResolvedValue(Response.json(value)));
    try { await gateway.complete(request('escalation')); throw Error('Expected rejection'); } catch (error) {
      expect(error).toBeInstanceOf(NativeGatewayError); expect((error as NativeGatewayError).measurement).toEqual({ deployment: 'gpt-6-astra', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } });
      expect(JSON.stringify(error)).not.toContain(apiKey); expect(String(error)).not.toContain(apiKey);
    }
  });
  it.each([undefined, { input_tokens: 11, output_tokens: 7, total_tokens: 99 }, { input_tokens: -1, output_tokens: 7, total_tokens: 6 }])('does not invent a measurement when usage is absent or inconsistent', async usage => {
    const gateway = createAzureGateway({ endpoint, apiKey }, vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...envelope(), usage })));
    try { await gateway.complete(request()); throw Error('Expected rejection'); } catch (error) { expect(error).toBeInstanceOf(NativeGatewayError); expect((error as NativeGatewayError).measurement).toBeUndefined(); }
  });
  it('bounds the response body even without content-length', async () => {
    const gateway = createAzureGateway({ endpoint, apiKey, maximumResponseBytes: 256 }, vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(257))));
    await expect(gateway.complete(request())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('bounds body streaming time and cancels the reader', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const gateway = createAzureGateway({ endpoint, apiKey, timeoutMs: 10 }, vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
    await expect(gateway.complete(request())).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not start a cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(createAzureGateway({ endpoint, apiKey }, fetcher).complete(request('coordinator', controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('propagates cancellation to an in-flight HTTP request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      controller.abort();
    }));
    await expect(createAzureGateway({ endpoint, apiKey }, fetcher).complete(request('coordinator', controller.signal))).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
  });
});
