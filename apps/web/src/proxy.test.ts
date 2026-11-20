import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server';

const mocks = vi.hoisted(() => ({ configured: vi.fn(), clerk: vi.fn(), auth: vi.fn(), redirect: vi.fn() }));
vi.mock('./lib/server-config', () => ({ authConfigured: mocks.configured }));
vi.mock('@clerk/nextjs/server', async () => {
  const { NextResponse } = await import('next/server');
  return { clerkMiddleware: (handler: (auth: typeof mocks.auth, request: NextRequest) => Promise<unknown>) => {
    // Invoke the application's actual Clerk callback. A no-op middleware mock
    // cannot prove that ordinary app requests still require a signed-in user.
    mocks.clerk.mockImplementation(async (request: NextRequest) =>
      await handler(mocks.auth, request) ?? NextResponse.next());
    return mocks.clerk;
  } };
});
import proxy from './proxy';
import { googleCallbackResponse } from './lib/google-callback';

const event = {} as NextFetchEvent;
describe('Google callback privacy before authentication redirects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.configured.mockReturnValue(true);
    mocks.auth.mockResolvedValue({ userId: null, redirectToSignIn: mocks.redirect });
    mocks.redirect.mockImplementation(({ returnBackUrl }: { returnBackUrl: string }) => {
      const url = new URL('/sign-in', 'https://pactwoven.test');
      url.searchParams.set('redirect_url', returnBackUrl);
      return NextResponse.redirect(url);
    });
  });

  it('passes the exact callback directly to its scrubber without auth or redirects', async () => {
    const request = new NextRequest('https://pactwoven.test/app/settings/connections/google/callback?code=synthetic-code&state=synthetic-state');
    const response = await proxy(request, event);
    expect(mocks.configured).not.toHaveBeenCalled();
    expect(mocks.clerk).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(response?.headers.get('x-middleware-next')).toBe('1');
    expect(response?.headers.get('location')).toBeNull();
    expect(response?.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response?.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(JSON.stringify([...response!.headers])).not.toContain('synthetic-code');
    expect(JSON.stringify([...response!.headers])).not.toContain('synthetic-state');
    // The next layer is the standalone callback document, not a React layout.
    const document = googleCallbackResponse();
    expect(document.status).toBe(200);
    expect(document.headers.get('location')).toBeNull();
    expect(document.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(document.headers.get('Cache-Control')).toContain('no-store');
    expect(await document.text()).not.toMatch(/synthetic-code|synthetic-state/);
  });

  it.each(['/app', '/app/work', '/app/settings/connections/google', '/app/settings/connections/google/callback/', '/app/settings/connections/google/callback/extra', '/app/settings/connections/google/callback-other'])(
    'redirects a signed-out operator on protected path %s', async path => {
      const request = new NextRequest('https://pactwoven.test' + path);
      const response = await proxy(request, event);
      expect(mocks.configured).toHaveBeenCalledOnce();
      expect(mocks.clerk).toHaveBeenCalledWith(request, event);
      expect(mocks.auth).toHaveBeenCalledOnce();
      expect(mocks.redirect).toHaveBeenCalledWith({ returnBackUrl: path });
      expect(response?.status).toBe(307);
      expect(new URL(response!.headers.get('location')!).pathname).toBe('/sign-in');
    },
  );

  it('preserves the local workspace destination while dropping the RSC transport selector', async () => {
    const response = await proxy(new NextRequest('https://pactwoven.test/app/work?siteId=main&_rsc=transport'), event);
    expect(mocks.redirect).toHaveBeenCalledWith({ returnBackUrl: '/app/work?siteId=main' });
    expect(new URL(response!.headers.get('location')!).searchParams.get('redirect_url')).toBe('/app/work?siteId=main');
  });

  it('allows a signed-in operator through the actual protected-app callback', async () => {
    mocks.auth.mockResolvedValue({ userId: 'synthetic-operator', redirectToSignIn: mocks.redirect });
    const response = await proxy(new NextRequest('https://pactwoven.test/app/work'), event);
    expect(mocks.auth).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(response?.headers.get('x-middleware-next')).toBe('1');
  });

  it('keeps public marketing routes accessible without requiring an app session', async () => {
    const response = await proxy(new NextRequest('https://pactwoven.test/platform'), event);
    expect(mocks.clerk).toHaveBeenCalledOnce();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(response?.headers.get('x-middleware-next')).toBe('1');
  });

  it('keeps the callback bypass independent of auth configuration and OAuth error query values', async () => {
    mocks.configured.mockImplementation(() => { throw new Error('Auth configuration must not run on the callback'); });
    const response = await proxy(new NextRequest('https://pactwoven.test/app/settings/connections/google/callback?error=access_denied&state=synthetic-state'), event);
    expect(response?.headers.get('x-middleware-next')).toBe('1');
    expect(response?.headers.get('location')).toBeNull();
    expect(mocks.configured).not.toHaveBeenCalled();
    expect(mocks.clerk).not.toHaveBeenCalled();
  });
});
