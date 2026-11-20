import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

type Address = { address: string; family: number };
export type PublicSource = { url: string; title: string; text: string; observedAt: string };
export class PublicSourceError extends Error {
  constructor(readonly code: 'INVALID_URL' | 'DESTINATION_BLOCKED' | 'UNAVAILABLE' | 'TOO_LARGE' | 'UNSUPPORTED_CONTENT' | 'CANCELLED') {
    super('This source could not be verified.');
  }
}

const deniedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) deniedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const deniedV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]] as const) {
  deniedV6.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !deniedV4.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
}

export function publicSourceUrl(value: string): URL {
  try {
    if (value.length > 2048) throw new Error();
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        isIP(host) || !host.includes('.') || host.endsWith('.') || /\.(?:localhost|local|internal|test|invalid)$/.test(host)) throw new Error();
    url.hash = '';
    return url;
  } catch { throw new PublicSourceError('INVALID_URL'); }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PublicSourceError('CANCELLED'));
    // The operation may already have started; always observe its rejection,
    // even if cancellation happened before this wrapper was entered.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

type Page = { status: number; location?: string; mime: string; body: string };
export type SourceTransport = (url: URL, address: Address, signal: AbortSignal) => Promise<Page>;
const maximumBytes = 512 * 1024;

// Native HTTPS ignores proxy environment variables. No ambient cookies, auth or
// referrer is forwarded. The DNS-checked address is pinned for the TLS socket;
// SNI/certificate verification continues to use the original hostname.
const fetchPinned: SourceTransport = (url, address, signal) => new Promise((resolve, reject) => {
  const fail = (error: unknown) => reject(error instanceof PublicSourceError ? error : new PublicSourceError('UNAVAILABLE'));
  const req = request(url, {
    method: 'GET', agent: false, signal, family: address.family, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    },
    headers: { Accept: 'text/html, text/plain, application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Pactwoven-SourceReader/1.0',
      'Cache-Control': 'no-cache, no-store' },
    maxHeaderSize: 16 * 1024,
  }, response => {
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      resolve({ status, ...(location ? { location } : {}), mime: '', body: '' });
      return;
    }
    const mime = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const encoding = response.headers['content-encoding'];
    const declared = response.headers['content-length'];
    if (status !== 200 || (encoding && encoding !== 'identity')) {
      response.destroy(); fail(new PublicSourceError('UNAVAILABLE')); return;
    }
    if (!['text/html', 'text/plain', 'application/json'].includes(mime)) {
      response.destroy(); fail(new PublicSourceError('UNSUPPORTED_CONTENT')); return;
    }
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
      response.destroy(); fail(new PublicSourceError('TOO_LARGE')); return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) { response.destroy(); fail(new PublicSourceError('TOO_LARGE')); return; }
      chunks.push(chunk);
    });
    response.on('error', fail);
    response.on('end', () => {
      if (!response.complete || bytes > maximumBytes) { fail(new PublicSourceError('UNAVAILABLE')); return; }
      resolve({ status, mime, body: Buffer.concat(chunks).toString('utf8') });
    });
  });
  req.setTimeout(8_000, () => req.destroy(new PublicSourceError('UNAVAILABLE')));
  req.on('error', fail);
  req.end();
});

function extractText(body: string, mime: string): string {
  if (mime !== 'text/html') return body.trim().slice(0, 16_000);
  const lower = body.toLowerCase();
  const pieces: string[] = [];
  let offset = 0;
  // Each delimiter is visited once, including malformed/truncated markup. Avoid
  // unbounded tag regex searches on hostile documents full of unmatched '<'.
  while (offset < body.length) {
    const open = body.indexOf('<', offset);
    if (open < 0) { pieces.push(body.slice(offset)); break; }
    pieces.push(body.slice(offset, open), ' ');
    if (body.startsWith('<!--', open)) {
      const end = body.indexOf('-->', open + 4);
      if (end < 0) break;
      offset = end + 3;
      continue;
    }
    const end = body.indexOf('>', open + 1);
    if (end < 0) break;
    const name = /^([a-z][a-z0-9]*)\b/.exec(lower.slice(open + 1, Math.min(end, open + 32)))?.[1];
    if (name && ['script', 'style', 'noscript', 'svg'].includes(name)) {
      const closing = lower.indexOf(`</${name}`, end + 1);
      if (closing < 0) break;
      const closeEnd = body.indexOf('>', closing + 2);
      if (closeEnd < 0) break;
      offset = closeEnd + 1;
    } else offset = end + 1;
  }
  return pieces.join('')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" }[entity]!))
    .replace(/\s+/g, ' ').trim().slice(0, 16_000);
}

export function createPublicSourceReader(dependencies: {
  resolve?: (hostname: string) => Promise<Address[]>;
  transport?: SourceTransport;
  now?: () => number;
} = {}) {
  const resolve = dependencies.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  const transport = dependencies.transport ?? fetchPinned;
  const now = dependencies.now ?? Date.now;
  return async (value: string, parentSignal?: AbortSignal): Promise<PublicSource> => {
    const deadline = AbortSignal.timeout(25_000);
    const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
    let url = publicSourceUrl(value);
    const visited = new Set<string>();
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (visited.has(url.href)) throw new PublicSourceError('UNAVAILABLE');
        visited.add(url.href);
        signal.throwIfAborted();
        const addresses = await abortable(resolve(url.hostname), signal);
        if (!addresses.length || addresses.length > 32 || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) {
          throw new PublicSourceError('DESTINATION_BLOCKED');
        }
        const address = addresses.find(item => item.family === 4) ?? addresses[0]!;
        signal.throwIfAborted();
        // Anchor freshness to this network observation, conservatively at the
        // request start. Parsing, queueing or reading the returned object later
        // must never renew its observation time.
        const observedAt = new Date(now()).toISOString();
        const page = await abortable(transport(url, address, signal), signal);
        if ([301, 302, 303, 307, 308].includes(page.status)) {
          if (!page.location || redirects === 3) throw new PublicSourceError('UNAVAILABLE');
          url = publicSourceUrl(new URL(page.location, url).href);
          continue;
        }
        if (page.status !== 200) throw new PublicSourceError('UNAVAILABLE');
        if (!['text/html', 'text/plain', 'application/json'].includes(page.mime)) throw new PublicSourceError('UNSUPPORTED_CONTENT');
        if (Buffer.byteLength(page.body, 'utf8') > maximumBytes) throw new PublicSourceError('TOO_LARGE');
        const text = extractText(page.body, page.mime);
        if (!text) throw new PublicSourceError('UNSUPPORTED_CONTENT');
        const lower = page.body.toLowerCase();
        const titleStart = page.mime === 'text/html' ? lower.indexOf('<title>') : -1;
        const titleEnd = titleStart >= 0 ? lower.indexOf('</title>', titleStart + 7) : -1;
        const title = titleStart >= 0 && titleEnd > titleStart ? extractText(page.body.slice(titleStart + 7, titleEnd), 'text/html') : '';
        return { url: url.href, title: (title || url.hostname).slice(0, 300), text, observedAt };
      }
      throw new PublicSourceError('UNAVAILABLE');
    } catch (error) {
      if (error instanceof PublicSourceError) throw error;
      throw new PublicSourceError(signal.aborted ? 'CANCELLED' : 'UNAVAILABLE');
    }
  };
}

/** Only explicit operator text grants the first reader permission to open a URL. */
export function userSourceUrls(userInput: string): string[] {
  try {
    if (userInput.length > 100_000) return [];
    const input: unknown = JSON.parse(userInput);
    if (!input || typeof input !== 'object') return [];
    const object = input as { objective?: unknown; conversation?: unknown };
    const texts = typeof object.objective === 'string' ? [object.objective] : [];
    if (Array.isArray(object.conversation)) for (const item of object.conversation.slice(-100)) {
      if (item && item.role === 'user' && typeof item.text === 'string') texts.push(item.text);
    }
    const urls = new Set<string>();
    for (const text of texts) for (const match of text.matchAll(/https:\/\/[^\s<>"'`]+/g)) {
      try { urls.add(publicSourceUrl(match[0].replace(/[).,;!?\]}]+$/, '')).href); } catch { /* Unusable sources are not tool authority. */ }
      if (urls.size === 3) return [...urls];
    }
    return [...urls];
  } catch { return []; }
}
