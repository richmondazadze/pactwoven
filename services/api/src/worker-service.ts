import type { ServiceBinding } from './worker-config.js';

export async function readPrivateJson(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  const reader = body?.getReader();
  if (!reader) throw new Error('Missing private response');
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('Private exchange timed out');
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('Oversized private payload');
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (signal.aborted) throw new Error('Private exchange timed out');
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    void reader.cancel().catch(() => {});
    throw new Error('Invalid private payload');
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

export async function privateDeadline<T>(milliseconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Private exchange was not confirmed')); }, milliseconds);
  });
  try { return await Promise.race([work(controller.signal), deadline]); }
  finally { clearTimeout(timer!); }
}

/** A timeout is unconfirmed; callers must not automatically replace or retry an effect. */
export async function serviceJsonRequest(binding: ServiceBinding, request: Request, maxBytes = 64 * 1024) {
  try {
    return await privateDeadline(20_000, async signal => {
      const response = await binding.fetch(new Request(request, { signal }));
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('Private exchange was not confirmed'); }
      const data = await readPrivateJson(response.body, signal, maxBytes);
      return { response, data };
    });
  } catch {
    // A service/stream exception is not a verified API error. Drop its type and private diagnostics.
    throw new Error('Private service exchange was not confirmed');
  }
}
