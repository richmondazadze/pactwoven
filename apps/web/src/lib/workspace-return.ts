// Clerk can supply an absolute return URL. Keep only a validated local workspace
// path, even when the supplied origin is external; never redirect to that origin.
export function workspaceReturnPath(value: unknown, fallback = '/app'): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) return fallback;
  if (!value.startsWith('/') && !/^https?:\/\//i.test(value)) return fallback;
  if (value.startsWith('//')) return fallback;
  try {
    const url = new URL(value, 'https://workspace.invalid');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      !(url.pathname === '/app' || url.pathname.startsWith('/app/')) || /%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname)) return fallback;
    url.searchParams.delete('_rsc');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}
export function workspaceAuthPath(path: '/sign-in' | '/sign-up', destination: unknown) {
  return `${path}?${new URLSearchParams({ redirect_url: workspaceReturnPath(destination) })}`;
}
export function workspaceOnboardingPath(destination: unknown) {
  const path = workspaceReturnPath(destination);
  return path === '/app' || path.split(/[?#]/)[0] === '/app/onboarding' ? '/app/onboarding' : `/app/onboarding?${new URLSearchParams({ returnTo: path })}`;
}
