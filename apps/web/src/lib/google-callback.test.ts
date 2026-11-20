import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { googleCallbackDocument, googleCallbackResponse } from './google-callback';
import { GOOGLE_CALLBACK_ACK_KIND, GOOGLE_CALLBACK_KIND, GOOGLE_CALLBACK_PATH } from './google-access';

function run(search: string, options: { noOpener?: boolean; scrubFails?: boolean; channel?: boolean; withholdAck?: boolean } = {}) {
  const steps: string[] = [], messages: { data: any; origin: string }[] = [], channelMessages: any[] = [], dom: Record<string, string> = {};
  const listeners = new Map<string, (event: any) => void>(), timers = new Map<number, () => void>(), channels: any[] = [];
  const location = { search, origin: 'https://pactwoven.vercel.app', pathname: GOOGLE_CALLBACK_PATH, hash: '#private-fragment' };
  const ack = (data: any) => ({ kind: GOOGLE_CALLBACK_ACK_KIND, state: data.state, result: data.result });
  const opener = { closed: false, postMessage(data: any, origin: string) { steps.push('post'); messages.push({ data: structuredClone(data), origin }); if (!options.withholdAck) listeners.get('message')?.({ origin, source: opener, data: ack(data) }); } };
  class Channel {
    onmessage: ((event: any) => void) | null = null; closed = false;
    constructor(readonly name: string) { steps.push('channel'); channels.push(this); }
    postMessage(data: any) { steps.push('channel-post'); channelMessages.push(structuredClone(data)); if (!options.withholdAck) this.onmessage?.({ origin: location.origin, data: ack(data) }); }
    close() { this.closed = true; }
  }
  const context = { URLSearchParams, location, ...(options.channel ? { BroadcastChannel: Channel } : {}),
    setTimeout(callback: () => void) { const id = timers.size + 1; timers.set(id, callback); return id; }, clearTimeout(id: number) { timers.delete(id); },
    history: { replaceState(state: unknown, _title: string, path: string) { steps.push('scrub'); if (options.scrubFails) throw new Error('denied'); expect(state).toBeNull(); expect(path).toBe(GOOGLE_CALLBACK_PATH); location.search = ''; location.hash = ''; } },
    window: { opener: options.noOpener ? null : opener, close() {}, addEventListener(name: string, callback: (event: any) => void) { listeners.set(name, callback); }, removeEventListener(name: string, callback: (event: any) => void) { if (listeners.get(name) === callback) listeners.delete(name); } },
    document: { addEventListener(_name: string, callback: () => void) { steps.push('ready'); callback(); }, getElementById(id: string) { return { set textContent(value: string) { dom[id] = value; }, addEventListener() {} }; } },
  };
  const html = googleCallbackDocument('test_nonce'), script = html.match(/<script nonce="test_nonce">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Missing scrubber');
  runInNewContext(script, context);
  return { steps, messages, channelMessages, channels, location, dom, html, listeners, timers, opener, ack };
}
describe('standalone Google callback privacy', () => {
  it('scrubs all query/hash before dispatch or content and sends only to the exact origin', () => {
    const state = 's'.repeat(43), result = run(`?code=synthetic-code&state=${state}&unrecognized=private`);
    expect(result.steps).toEqual(['scrub', 'ready', 'post']); expect(result.location.search).toBe(''); expect(result.location.hash).toBe('');
    expect(result.messages).toEqual([{ data: { kind: GOOGLE_CALLBACK_KIND, result: 'code', state, code: 'synthetic-code' }, origin: result.location.origin }]);
    expect(JSON.stringify(result.dom)).not.toMatch(/synthetic-code|private-fragment|unrecognized/);
    expect(result.html).not.toMatch(/<script[^>]*src=|<link|<img|fetch\(|localStorage|sessionStorage|console\.|Clerk|analytics/);
    expect(result.html.indexOf('<script')).toBeLessThan(result.html.indexOf('<title>'));
  });
  it.each(['?code=one&code=two&state=', '?error=access_denied&code=synthetic-code&state=', '?code=&state=', '?code=%0A&state=', '?error=one&error=two&state='])('scrubs and rejects ambiguous callback %s', prefix => { const result = run(prefix + 's'.repeat(43)); expect(result.steps[0]).toBe('scrub'); expect(result.messages).toHaveLength(0); });
  it('does not reflect provider denial/error description', () => { const result = run(`?error=access_denied&error_description=synthetic-secret&state=${'s'.repeat(43)}`); expect(result.messages[0]?.data).toEqual({ kind: GOOGLE_CALLBACK_KIND, result: 'cancelled', state: 's'.repeat(43) }); expect(JSON.stringify(result.dom)).not.toContain('synthetic-secret'); });
  it('cleans the address even with missing state or opener and gives safe recovery', () => { const result = run('?code=synthetic-code', { noOpener: true }); expect(result.location.search).toBe(''); expect(result.messages).toEqual([]); expect(result.dom.result).toContain('start again'); });
  it('does not dispatch or initialize content when history cannot be scrubbed', () => { const result = run(`?code=synthetic-code&state=${'s'.repeat(43)}`, { scrubFails: true }); expect(result.steps).toEqual(['scrub']); expect(result.messages).toEqual([]); });
  it('scrubs before opening the state channel and requires acknowledgment with no opener', () => {
    const result = run(`?code=synthetic-code&state=${'s'.repeat(43)}`, { noOpener: true, channel: true });
    expect(result.steps.indexOf('scrub')).toBeLessThan(result.steps.indexOf('channel'));
    expect(result.channelMessages).toEqual([{ kind: GOOGLE_CALLBACK_KIND, result: 'code', state: 's'.repeat(43), code: 'synthetic-code' }]);
    expect(result.dom.result).toContain('received the response'); expect(result.dom.result).toContain('check whether');
    expect(result.channels[0].closed).toBe(true); expect(result.timers.size).toBe(0); expect(result.listeners.size).toBe(0);
  });
  it('does not claim receipt when a channel has no receiver or acknowledgment is withheld', () => {
    const result = run(`?code=synthetic-code&state=${'s'.repeat(43)}`, { noOpener: true, channel: true, withholdAck: true });
    expect(result.dom.result).not.toContain('received the response');
    for (const timer of [...result.timers.values()]) timer();
    expect(result.dom.result).toContain('could not return'); expect(result.channels[0].closed).toBe(true); expect(result.listeners.size).toBe(0);
  });
  it('rejects wrong origin, state, result and extra fields in acknowledgments', () => {
    const result = run(`?code=synthetic-code&state=${'s'.repeat(43)}`, { noOpener: true, channel: true, withholdAck: true }), receive = result.channels[0].onmessage;
    const good = result.ack(result.channelMessages[0]);
    for (const event of [{ origin: 'https://wrong.test', data: good }, { origin: result.location.origin, data: { ...good, state: 'z'.repeat(43) } }, { origin: result.location.origin, data: { ...good, result: 'cancelled' } }, { origin: result.location.origin, data: { ...good, connected: true } }]) receive(event);
    expect(result.dom.result).not.toContain('received the response');
    receive({ origin: result.location.origin, data: good }); expect(result.dom.result).toContain('received the response');
  });
  it('direct acknowledgment requires the exact opener, and page exit closes remaining channels', () => {
    const result = run(`?code=synthetic-code&state=${'s'.repeat(43)}`, { channel: true, withholdAck: true });
    result.listeners.get('message')?.({ origin: result.location.origin, source: {}, data: result.ack(result.messages[0]!.data) });
    expect(result.dom.result).not.toContain('received the response');
    result.listeners.get('pagehide')?.({}); expect(result.channels[0].closed).toBe(true); expect(result.timers.size).toBe(0); expect(result.listeners.size).toBe(0);
  });
  it('missing opener without BroadcastChannel fails clearly without a retry', () => {
    const result = run(`?code=synthetic-code&state=${'s'.repeat(43)}`, { noOpener: true });
    expect(result.messages).toHaveLength(0); expect(result.channelMessages).toHaveLength(0); expect(result.dom.result).toContain('could not return'); expect(result.timers.size).toBe(0);
  });
  it('serves nonce-isolated, non-cacheable, non-referring HTML without reflecting the request', async () => { const response = googleCallbackResponse(), html = await response.text(); expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(response.headers.get('Content-Security-Policy')).toMatch(/default-src 'none'; script-src 'nonce-[a-f0-9]+'; style-src 'nonce-[a-f0-9]+'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'/); expect(html).not.toContain('synthetic-code'); expect(response.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline'); });
});
