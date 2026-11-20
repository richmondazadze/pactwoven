import { z } from 'zod';

export const azureDeployments = Object.freeze({
  coordinator: 'gpt-6.1-sol', planning: 'gpt-6.1-sol', supplier: 'gpt-6.1-sol',
  research: 'gpt-6.1-terra', evidence: 'gpt-6.1-terra', escalation: 'gpt-6-astra',
});
export type ReasoningRole = keyof typeof azureDeployments;
export type ModelUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type ModelRequest<T> = {
  role: ReasoningRole;
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
  schemaName: string;
  signal: AbortSignal;
};
export type ModelResult<T> = { value: T; usage: ModelUsage; deployment: string };
export interface NativeModelGateway { complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> }

export type GatewayErrorCode = 'CONFIGURATION' | 'CANCELLED' | 'TIMEOUT' | 'NETWORK' | 'RATE_LIMITED' |
  'UNAVAILABLE' | 'ACCESS_DENIED' | 'REJECTED' | 'INVALID_RESPONSE' | 'REFUSED' | 'INCOMPLETE';
export type ModelMeasurement = { usage: ModelUsage; deployment: string };
export class NativeGatewayError extends Error {
  constructor(readonly code: GatewayErrorCode, readonly retryable = false, readonly measurement?: ModelMeasurement) {
    super(`Model request could not finish (${code}).`);
    this.name = 'NativeGatewayError';
  }
}

export function normalizeAzureResponsesEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new NativeGatewayError('CONFIGURATION'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
    !/^[a-z0-9-]+\.(?:services\.ai|openai)\.azure\.com$/i.test(url.hostname)) {
    throw new NativeGatewayError('CONFIGURATION');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '/openai/v1' && path !== '/openai/v1/responses') throw new NativeGatewayError('CONFIGURATION');
  url.pathname = '/openai/v1/responses';
  return url.href;
}

const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const EnvelopeSchema = z.object({
  status: z.string(),
  output: z.array(z.object({ type: z.string(), role: z.string().optional(), status: z.string().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  })).max(32),
  usage: UsageSchema,
  error: z.unknown().optional(),
});

async function boundedResponse(response: Response, maximumBytes: number, signal: AbortSignal): Promise<unknown> {
  const size = response.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > maximumBytes)) {
    void response.body?.cancel().catch(() => {});
    throw new NativeGatewayError('INVALID_RESPONSE');
  }
  if (!response.body) throw new NativeGatewayError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  let total = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new NativeGatewayError('INVALID_RESPONSE');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof NativeGatewayError || signal.aborted) throw error;
    throw new NativeGatewayError('INVALID_RESPONSE');
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export type AzureGatewayConfig = { endpoint: string; apiKey: string; timeoutMs?: number; maximumResponseBytes?: number };
export function createAzureGateway(config: AzureGatewayConfig, fetcher: typeof fetch = fetch): NativeModelGateway {
  const endpoint = normalizeAzureResponsesEndpoint(config.endpoint);
  if (!config.apiKey || /[\r\n]/.test(config.apiKey) || config.apiKey.length > 4096) throw new NativeGatewayError('CONFIGURATION');
  const timeoutMs = config.timeoutMs ?? 90_000;
  const maximumResponseBytes = config.maximumResponseBytes ?? 1_048_576;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 256 || maximumResponseBytes > 2_097_152) {
    throw new NativeGatewayError('CONFIGURATION');
  }
  return {
    async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      if (request.signal.aborted) throw new NativeGatewayError('CANCELLED');
      if (!Object.hasOwn(azureDeployments, request.role) || !/^[a-z][a-z0-9_]{0,63}$/.test(request.schemaName) ||
          request.instructions.length > 16_000 || request.input.length > 150_000) throw new NativeGatewayError('REJECTED');
      const controller = new AbortController();
      let timedOut = false;
      let measurement: ModelMeasurement | undefined;
      const abort = () => controller.abort();
      request.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const schema = z.toJSONSchema(request.schema, { target: 'draft-7' });
        const response = await fetcher(endpoint, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'api-key': config.apiKey },
          body: JSON.stringify({ model: azureDeployments[request.role], store: false, stream: false,
            reasoning: { effort: 'low' }, max_output_tokens: 8_192,
            instructions: request.instructions,
            input: [{ role: 'user', content: [{ type: 'input_text', text: request.input }] }],
            text: { format: { type: 'json_schema', name: request.schemaName, strict: true, schema } },
          }),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          if (response.status === 401 || response.status === 403) throw new NativeGatewayError('ACCESS_DENIED');
          if (response.status === 429) throw new NativeGatewayError('RATE_LIMITED', true);
          if (response.status >= 500) throw new NativeGatewayError('UNAVAILABLE', true);
          throw new NativeGatewayError('REJECTED');
        }
        const raw = await boundedResponse(response, maximumResponseBytes, controller.signal);
        // Retain only validated numeric usage from a complete bounded envelope.
        // Content/schema/refusal failures do not make those measured tokens unknown.
        const measured = z.object({ usage: UsageSchema }).safeParse(raw);
        if (measured.success && measured.data.usage.total_tokens === measured.data.usage.input_tokens + measured.data.usage.output_tokens) {
          measurement = { deployment: azureDeployments[request.role], usage: { inputTokens: measured.data.usage.input_tokens,
            outputTokens: measured.data.usage.output_tokens, totalTokens: measured.data.usage.total_tokens } };
        }
        const parsed = EnvelopeSchema.safeParse(raw);
        if (!parsed.success) throw new NativeGatewayError('INVALID_RESPONSE');
        const envelope = parsed.data;
        if (envelope.error || envelope.status !== 'completed') throw new NativeGatewayError('INCOMPLETE');
        const messages = envelope.output.filter(item => item.type !== 'reasoning');
        if (messages.some(item => item.content?.some(content => content.type === 'refusal'))) throw new NativeGatewayError('REFUSED');
        if (messages.length !== 1 || messages[0]?.type !== 'message' || messages[0].role !== 'assistant' ||
            messages[0].status !== 'completed' || messages[0].content?.length !== 1 ||
            messages[0].content[0]?.type !== 'output_text' || typeof messages[0].content[0].text !== 'string') {
          throw new NativeGatewayError('INVALID_RESPONSE');
        }
        let value: unknown;
        try { value = JSON.parse(messages[0].content[0].text); } catch { throw new NativeGatewayError('INVALID_RESPONSE'); }
        const result = request.schema.safeParse(value);
        if (!result.success) throw new NativeGatewayError('INVALID_RESPONSE');
        if (envelope.usage.total_tokens !== envelope.usage.input_tokens + envelope.usage.output_tokens) throw new NativeGatewayError('INVALID_RESPONSE');
        return { value: result.data, deployment: azureDeployments[request.role], usage: {
          inputTokens: envelope.usage.input_tokens, outputTokens: envelope.usage.output_tokens, totalTokens: envelope.usage.total_tokens,
        } };
      } catch (error) {
        if (timedOut) throw new NativeGatewayError('TIMEOUT', true, measurement);
        if (request.signal.aborted) throw new NativeGatewayError('CANCELLED', false, measurement);
        if (error instanceof NativeGatewayError) throw measurement ? new NativeGatewayError(error.code, error.retryable, measurement) : error;
        // Never attach provider exception/body text, request headers or the key.
        throw new NativeGatewayError('NETWORK', true);
      } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
    },
  };
}
