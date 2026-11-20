import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { googleCallbackDocument, googleCallbackResponse } from './google-callback';
import { GOOGLE_CALLBACK_KIND, GOOGLE_CALLBACK_PATH } from './google-access';

function run(search: string, options: { noOpener?: boolean; scrubFails?: boolean } = {}) {
  const steps: string[] = [], messages: { data: unknown; origin: string }[] = [], dom: Record<string, string> = {};
  const location = { search, origin: 'https://pactwoven.vercel.app', pathname: GOOGLE_CALLBACK_PATH, hash: '#private-fragment' };
  const context = { URLSearchParams, location, history: { replaceState(state: unknown, _title: string, path: string) { steps.push('scrub'); if (options.scrubFails) throw new Error('denied'); expect(state).toBeNull(); expect(path).toBe(GOOGLE_CALLBACK_PATH); location.search = ''; location.hash = ''; } },
    window: { opener: options.noOpener ? null : { closed: false, postMessage(data: unknown, origin: string) { steps.push('post'); messages.push({ data: structuredClone(data), origin }); } }, close() {} },
    document: { addEventListener(_name: string, callback: () => void) { steps.push('ready'); callback(); }, getElementById(id: string) { return { set textContent(value: string) { dom[id] = value; }, addEventListener() {} }; } },
  };
  const html = googleCallbackDocument('test_nonce'), script = html.match(/<script nonce="test_nonce">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Missing scrubber');
  runInNewContext(script, context);
  return { steps, messages, location, dom, html };
}
describe('standalone Google callback privacy', () => {
  it('scrubs all query/hash before dispatch or content and sends only to the exact origin', () => {
    const state = 's'.repeat(43), result = run(`?code=synthetic-code&state=${state}&unrecognized=private`);
    expect(result.steps).toEqual(['scrub', 'post', 'ready']); expect(result.location.search).toBe(''); expect(result.location.hash).toBe('');
    expect(result.messages).toEqual([{ data: { kind: GOOGLE_CALLBACK_KIND, result: 'code', state, code: 'synthetic-code' }, origin: result.location.origin }]);
    expect(JSON.stringify(result.dom)).not.toMatch(/synthetic-code|private-fragment|unrecognized/);
    expect(result.html).not.toMatch(/<script[^>]*src=|<link|<img|fetch\(|localStorage|sessionStorage|console\.|Clerk|analytics/);
    expect(result.html.indexOf('<script')).toBeLessThan(result.html.indexOf('<title>'));
  });
  it.each(['?code=one&code=two&state=', '?error=access_denied&code=synthetic-code&state=', '?code=&state=', '?code=%0A&state=', '?error=one&error=two&state='])('scrubs and rejects ambiguous callback %s', prefix => { const result = run(prefix + 's'.repeat(43)); expect(result.steps[0]).toBe('scrub'); expect(result.messages).toHaveLength(0); });
  it('does not reflect provider denial/error description', () => { const result = run(`?error=access_denied&error_description=synthetic-secret&state=${'s'.repeat(43)}`); expect(result.messages[0]?.data).toEqual({ kind: GOOGLE_CALLBACK_KIND, result: 'cancelled', state: 's'.repeat(43) }); expect(JSON.stringify(result.dom)).not.toContain('synthetic-secret'); });
  it('cleans the address even with missing state or opener and gives safe recovery', () => { const result = run('?code=synthetic-code', { noOpener: true }); expect(result.location.search).toBe(''); expect(result.messages).toEqual([]); expect(result.dom.result).toContain('start again'); });
  it('does not dispatch or initialize content when history cannot be scrubbed', () => { const result = run(`?code=synthetic-code&state=${'s'.repeat(43)}`, { scrubFails: true }); expect(result.steps).toEqual(['scrub']); expect(result.messages).toEqual([]); });
  it('serves nonce-isolated, non-cacheable, non-referring HTML without reflecting the request', async () => { const response = googleCallbackResponse(), html = await response.text(); expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(response.headers.get('Content-Security-Policy')).toMatch(/default-src 'none'; script-src 'nonce-[a-f0-9]+'; style-src 'nonce-[a-f0-9]+'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'/); expect(html).not.toContain('synthetic-code'); expect(response.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline'); });
});
