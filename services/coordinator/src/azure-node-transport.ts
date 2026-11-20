import { request as httpsRequest } from 'node:https';
import { NativeGatewayError, normalizeAzureResponsesEndpoint } from './azure-gateway.js';

class PreHandshakeReset extends NativeGatewayError {
  constructor() { super('NETWORK', true); }
}

// Some development networks reset Node's automatic address-family selection.
// Select IPv4 explicitly while preserving HTTPS hostname/certificate validation.
// This adapter is Azure-only; it never follows redirects or fetches source URLs.
export function createAzureNodeFetch(requester: typeof httpsRequest = httpsRequest): typeof fetch {
  return async (input, init) => {
    if (!(typeof input === 'string' || input instanceof URL) || init?.method !== 'POST' || init.redirect !== 'error' ||
      typeof init.body !== 'string' || !init.signal || init.signal.aborted) throw new NativeGatewayError(init?.signal?.aborted ? 'CANCELLED' : 'REJECTED');
    const endpoint = normalizeAzureResponsesEndpoint(String(input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    headers['content-length'] = String(Buffer.byteLength(init.body, 'utf8'));
    delete headers['transfer-encoding'];
    const signal = init.signal;
    const send = async (compatibility: boolean): Promise<Response> => {
      if (signal.aborted) throw new NativeGatewayError('CANCELLED');
      return await new Promise<Response>((resolve, reject) => {
        let connected = false;
        let secure = false;
        let receivedResponse = false;
        const request = requester(endpoint, { method: 'POST', family: 4, rejectUnauthorized: true, minVersion: 'TLSv1.2',
          ...(compatibility ? { agent: false as const, maxVersion: 'TLSv1.2' as const } : {}), headers, signal }, incoming => {
          receivedResponse = true;
          const status = incoming.statusCode ?? 502;
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          let closed = false;
          const body = [204, 205, 304].includes(status) ? null : new ReadableStream<Uint8Array>({
            start(controller) {
              incoming.on('data', (chunk: Buffer) => {
                if (closed) return;
                controller.enqueue(new Uint8Array(chunk));
                if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
              });
              incoming.once('end', () => { if (!closed) { closed = true; controller.close(); } });
              const failed = () => { if (!closed) { closed = true; controller.error(new NativeGatewayError('NETWORK', true)); } };
              incoming.on('error', failed);
              incoming.once('aborted', failed);
              incoming.once('close', failed);
            },
            pull() { if (!closed) incoming.resume(); },
            cancel() { closed = true; incoming.destroy(); },
          });
          if (body === null) incoming.resume();
          resolve(new Response(body, { status, headers: responseHeaders }));
        });
        request.on('socket', socket => {
          connected = !socket.connecting;
          secure = request.reusedSocket || ('authorized' in socket && socket.authorized === true);
          socket.once('connect', () => { connected = true; });
          socket.once('secureConnect', () => { secure = true; });
        });
        request.on('error', (error: NodeJS.ErrnoException) => {
          if (!compatibility && !signal.aborted && error.code === 'ECONNRESET' && connected && !secure && !receivedResponse) {
            reject(new PreHandshakeReset());
          } else reject(new NativeGatewayError(signal.aborted ? 'CANCELLED' : 'NETWORK', !signal.aborted));
        });
        request.end(init.body);
      });
    };
    try { return await send(false); } catch (error) {
      if (!(error instanceof PreHandshakeReset)) throw error;
      // A reset before TLS completes cannot have delivered the HTTP body. Retry
      // once with the existing TLS 1.2 protocol on a fresh verified connection.
      // Keep the same deadline/cancellation signal; never retry a certificate
      // failure, an established TLS connection or a received HTTP response here.
      return await send(true);
    }
  };
}
