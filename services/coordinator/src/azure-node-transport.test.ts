import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { request as httpsRequest } from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAzureNodeFetch } from './azure-node-transport.js';
import { createAzureGateway } from './azure-gateway.js';

const endpoint = 'https://test-resource.services.ai.azure.com/openai/v1/responses';
const value = { status:'completed', output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"ok":true}'}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2} };
const request = () => ({role:'coordinator' as const,instructions:'Return the result.',input:'Test',schema:z.strictObject({ok:z.boolean()}),schemaName:'transport_test',signal:new AbortController().signal});
function responder(status: number, body: unknown) {
  const captured: { url?: unknown; options?: RequestOptions; body?: unknown } = {};
  const requester = vi.fn((url: unknown, options: RequestOptions, callback: (incoming: IncomingMessage)=>void) => {
    captured.url=url;captured.options=options;
    const req=Object.assign(new EventEmitter(),{end(data: unknown) {
      captured.body=data;
      const incoming=Object.assign(new PassThrough(),{statusCode:status,headers:{'content-type':'application/json'}});
      queueMicrotask(()=>{callback(incoming as unknown as IncomingMessage);incoming.end(JSON.stringify(body));});
    }});
    return req;
  });
  return { captured, requester: requester as unknown as typeof httpsRequest, spy:requester };
}
type FailurePoint = 'before_connect' | 'handshake' | 'secure' | 'reused' | 'certificate' | 'response' | 'pending' | 'success';
function connectionSequence(points: FailurePoint[]) {
  const options: HttpsRequestOptions[] = [];
  const bodies: unknown[] = [];
  const requester = vi.fn((_url: unknown, settings: HttpsRequestOptions, callback: (incoming: IncomingMessage) => void) => {
    const point = points[options.length];
    options.push(settings);
    const req = Object.assign(new EventEmitter(), { reusedSocket: point === 'reused', end(body: unknown) {
      bodies.push(body);
      queueMicrotask(() => {
        const socket = Object.assign(new EventEmitter(), { connecting: true, authorized: false });
        req.emit('socket', socket);
        if (point !== 'before_connect') socket.emit('connect');
        if (point === 'secure') socket.emit('secureConnect');
        if (point === 'pending') {
          settings.signal?.addEventListener('abort', () => req.emit('error', Object.assign(new Error('private request data'), { code: 'ABORT_ERR' })), { once: true });
          return;
        }
        if (point === 'success' || point === 'response') {
          const incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'application/json' } });
          callback(incoming as unknown as IncomingMessage);
          if (point === 'success') incoming.end(JSON.stringify(value));
          else {
            req.emit('error', Object.assign(new Error('private request data'), { code: 'ECONNRESET' }));
            incoming.destroy(Object.assign(new Error('private response data'), { code: 'ECONNRESET' }));
          }
          return;
        }
        req.emit('error', Object.assign(new Error('private request data'), { code: point === 'certificate' ? 'ERR_TLS_CERT_ALTNAME_INVALID' : 'ECONNRESET' }));
      });
    } });
    return req;
  });
  return { options, bodies, spy: requester, requester: requester as unknown as typeof httpsRequest };
}
describe('Azure node HTTPS transport',()=>{
  it('retains verified TLS, selects IPv4 and sends an exact content length',async()=>{
    const fixture=responder(200,value);
    const gateway=createAzureGateway({endpoint,apiKey:'test-secret'},createAzureNodeFetch(fixture.requester));
    await expect(gateway.complete(request())).resolves.toMatchObject({value:{ok:true}});
    expect(fixture.captured.options).toMatchObject({method:'POST',family:4,rejectUnauthorized:true});
    expect(fixture.captured.options?.headers).toMatchObject({'api-key':'test-secret','content-length':String(Buffer.byteLength(String(fixture.captured.body)))});
    expect(fixture.spy).toHaveBeenCalledOnce();
  });
  it('never follows a provider redirect with credentials',async()=>{
    const fixture=responder(302,{});
    await expect(createAzureGateway({endpoint,apiKey:'test-secret'},createAzureNodeFetch(fixture.requester)).complete(request())).rejects.toMatchObject({code:'REJECTED'});
    expect(fixture.spy).toHaveBeenCalledOnce();
  });
  it('rejects unrelated URLs and unsupported request shapes before opening a socket',async()=>{
    const fixture=responder(200,value);const fetcher=createAzureNodeFetch(fixture.requester);
    await expect(fetcher('https://example.com/',{method:'POST',redirect:'error',body:'{}',signal:new AbortController().signal})).rejects.toMatchObject({code:'CONFIGURATION'});
    await expect(fetcher(endpoint,{method:'GET'})).rejects.toMatchObject({code:'REJECTED'});
    expect(fixture.spy).not.toHaveBeenCalled();
  });
  it('sanitizes socket failures',async()=>{
    const requester=vi.fn(()=>{const req=Object.assign(new EventEmitter(),{end(){queueMicrotask(()=>req.emit('error',new Error('credential must not leak')));}});return req;});
    const gateway=createAzureGateway({endpoint,apiKey:'test-secret'},createAzureNodeFetch(requester as unknown as typeof httpsRequest));
    await expect(gateway.complete(request())).rejects.toMatchObject({code:'NETWORK'});
  });
  it('recovers one pre-TLS reset on a fresh verified TLS 1.2 connection under the original signal', async () => {
    const fixture = connectionSequence(['handshake', 'success']);
    const gateway = createAzureGateway({ endpoint, apiKey: 'test-secret' }, createAzureNodeFetch(fixture.requester));
    await expect(gateway.complete(request())).resolves.toMatchObject({ value: { ok: true } });
    expect(fixture.spy).toHaveBeenCalledTimes(2);
    expect(fixture.options[0]).toMatchObject({ family: 4, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(fixture.options[0]).not.toHaveProperty('maxVersion');
    expect(fixture.options[1]).toMatchObject({ agent: false, family: 4, rejectUnauthorized: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
    expect(fixture.options[1]?.signal).toBe(fixture.options[0]?.signal);
    expect(fixture.bodies[1]).toBe(fixture.bodies[0]);
  });
  it.each(['before_connect', 'secure', 'reused', 'certificate', 'response'] as const)('does not perform a compatibility retry after %s failure', async point => {
    const fixture = connectionSequence([point, 'success']);
    const gateway = createAzureGateway({ endpoint, apiKey: 'test-secret' }, createAzureNodeFetch(fixture.requester));
    await expect(gateway.complete(request())).rejects.toMatchObject({ code: 'NETWORK' });
    expect(fixture.spy).toHaveBeenCalledOnce();
  });
  it('bounds the compatibility attempt to one and sanitizes both failures', async () => {
    const fixture = connectionSequence(['handshake', 'handshake', 'success']);
    const gateway = createAzureGateway({ endpoint, apiKey: 'test-secret' }, createAzureNodeFetch(fixture.requester));
    const error = await gateway.complete(request()).catch(error => error as Error);
    expect(error).toMatchObject({ code: 'NETWORK', retryable: true });
    expect(String(error)).not.toContain('private');
    expect(fixture.spy).toHaveBeenCalledTimes(2);
  });
  it('does not reset the gateway deadline for the compatibility connection', async () => {
    const fixture = connectionSequence(['handshake', 'pending']);
    const gateway = createAzureGateway({ endpoint, apiKey: 'test-secret', timeoutMs: 10 }, createAzureNodeFetch(fixture.requester));
    await expect(gateway.complete(request())).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(fixture.spy).toHaveBeenCalledTimes(2);
    expect(fixture.options[1]?.signal).toBe(fixture.options[0]?.signal);
    expect(fixture.options[1]?.signal?.aborted).toBe(true);
  });
  it('cancels an in-flight compatibility connection without another attempt', async () => {
    const fixture = connectionSequence(['handshake', 'pending']);
    const controller = new AbortController();
    const gateway = createAzureGateway({ endpoint, apiKey: 'test-secret' }, createAzureNodeFetch(fixture.requester));
    const result = gateway.complete({ ...request(), signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    expect(fixture.spy).toHaveBeenCalledTimes(2);
  });
});
