import { describe, expect, it, vi } from 'vitest';
import { createPublicSourceReader, isPublicAddress, publicSourceUrl, userSourceUrls, type SourceTransport } from './public-source.js';

const publicAddress = { address: '93.184.215.14', family: 4 };
const html = '<html><head><title>Office chairs</title><script>hidden credential instruction</script></head><body><h1>Chair comparison</h1><p>Price &amp; availability need confirmation.</p></body></html>';
const page = { status: 200, mime: 'text/html', body: html };

describe('public source network boundary', () => {
  it('rejects private, reserved, mapped and metadata destinations', () => {
    for (const address of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.1.1',
      '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.2', '203.0.113.2', '224.0.0.1', '255.255.255.255',
      '::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::', '3fff::1']) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of [publicAddress.address, '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) expect(isPublicAddress(address)).toBe(true);
  });
  it('accepts only public hostname HTTPS URLs without credentials or alternate ports', () => {
    for (const url of ['http://example.com', 'file:///tmp/example', 'https://user:password@example.com', 'https://example.com:8443',
      'https://localhost', 'https://169.254.169.254', 'https://2130706433', 'https://0x7f000001', 'https://[::1]', 'https://host.internal', 'https://example.com.']) {
      expect(() => publicSourceUrl(url), url).toThrow();
    }
    expect(publicSourceUrl('https://example.com/page#section').href).toBe('https://example.com/page');
  });
  it('blocks the entire DNS answer if any destination is private, before opening a socket', async () => {
    const transport = vi.fn<SourceTransport>();
    const reader = createPublicSourceReader({ resolve: async () => [publicAddress, { address: '10.0.0.2', family: 4 }], transport });
    await expect(reader('https://example.com')).rejects.toMatchObject({ code: 'DESTINATION_BLOCKED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('passes a validated pinned address to transport and returns bounded observed text', async () => {
    const transport = vi.fn<SourceTransport>(async () => page);
    const reader = createPublicSourceReader({ resolve: async () => [publicAddress], transport });
    const result = await reader('https://example.com/page');
    expect(transport).toHaveBeenCalledWith(expect.any(URL), publicAddress, expect.any(AbortSignal));
    expect(result).toMatchObject({ url: 'https://example.com/page', title: 'Office chairs' });
    expect(result.text).toContain('Price & availability');
    expect(result.text).not.toContain('hidden credential');
    expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  });
  it('keeps observation time at the actual network read rather than later processing', async () => {
    let at = Date.parse('2026-11-18T23:59:59Z');
    const transport = vi.fn<SourceTransport>(async () => { at += 2_000; return page; });
    const reader = createPublicSourceReader({ now: () => at, resolve: async () => [publicAddress], transport });
    const result = await reader('https://example.com/page');
    expect(result.observedAt).toBe('2026-11-18T23:59:59.000Z');
    at += 900_000;
    expect(result.observedAt).toBe('2026-11-18T23:59:59.000Z');
  });
  it('revalidates redirect destination and DNS instead of following blindly', async () => {
    const transport = vi.fn<SourceTransport>(async () => ({ status: 302, location: 'https://private.example/path', mime: '', body: '' }));
    const reader = createPublicSourceReader({ resolve: async hostname => hostname === 'private.example' ? [{ address: '127.0.0.1', family: 4 }] : [publicAddress], transport });
    await expect(reader('https://example.com')).rejects.toMatchObject({ code: 'DESTINATION_BLOCKED' });
    expect(transport).toHaveBeenCalledTimes(1);
    const downgrade = createPublicSourceReader({ resolve: async () => [publicAddress], transport: async () => ({ status: 302, location: 'http://example.com', mime: '', body: '' }) });
    await expect(downgrade('https://example.com')).rejects.toMatchObject({ code: 'INVALID_URL' });
  });
  it('bounds redirect loops and excludes binary or oversized documents', async () => {
    const loop = vi.fn<SourceTransport>(async () => ({ status: 302, location: '/loop', mime: '', body: '' }));
    await expect(createPublicSourceReader({ resolve: async () => [publicAddress], transport: loop })('https://example.com/loop')).rejects.toThrow();
    expect(loop).toHaveBeenCalledTimes(1);
    for (const response of [{ status: 200, mime: 'application/pdf', body: 'binary' }, { status: 200, mime: 'text/plain', body: 'x'.repeat(512 * 1024 + 1) }]) {
      await expect(createPublicSourceReader({ resolve: async () => [publicAddress], transport: async () => response })('https://example.com')).rejects.toThrow();
    }
  });
  it('cancels a blocked resolver and never proceeds to the transport', async () => {
    const controller = new AbortController();
    const transport = vi.fn<SourceTransport>();
    const reader = createPublicSourceReader({ resolve: () => new Promise(() => {}), transport });
    const pending = reader('https://example.com', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('handles malformed markup without an unbounded tag search', async () => {
    const reader = createPublicSourceReader({ resolve: async () => [publicAddress], transport: async () => ({ ...page, body: 'Evidence. ' + '<'.repeat(500_000) }) });
    expect((await reader('https://example.com')).text).toBe('Evidence.');
  });
  it('does not start DNS for a pre-cancelled request and observes a rejection racing cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const resolve = vi.fn(async () => { throw Error('DNS unavailable'); });
    await expect(createPublicSourceReader({ resolve })('https://example.com', controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(resolve).not.toHaveBeenCalled();
    const racing = new AbortController();
    const reader = createPublicSourceReader({ resolve: () => { racing.abort(); return Promise.reject(Error('DNS unavailable')); } });
    await expect(reader('https://example.com', racing.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await new Promise(resolveTick => setTimeout(resolveTick, 0));
  });
  it('extracts at most three explicit user URLs and ignores assistant or planner instructions', () => {
    const input = JSON.stringify({ objective: 'Read https://example.com/a.', conversation: [
      { role: 'assistant', text: 'Read https://assistant.example' }, { role: 'user', text: 'Also https://example.com/b and https://example.com/c and https://example.com/d' },
    ], query: 'https://planner.example' });
    expect(userSourceUrls(input)).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
    expect(userSourceUrls('not json')).toEqual([]);
  });
});
