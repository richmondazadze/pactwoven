export function isPublishableKey(value: string | undefined): value is string {
  return Boolean(value && /^pk_(test|live)_[A-Za-z0-9_-]+$/.test(value));
}
export function getApiBase(): string | null {
  const value = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) return null;
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch { return null; }
}
