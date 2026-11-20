import { describe, expect, it, vi } from 'vitest';
import SignInPage from '../app/sign-in/[[...sign-in]]/page';
import SignUpPage from '../app/sign-up/[[...sign-up]]/page';
const state = vi.hoisted(() => ({ configured: true }));
vi.mock('@clerk/nextjs', () => ({ SignIn: 'RealClerkSignIn', SignUp: 'RealClerkSignUp' }));
vi.mock('@/components/auth-shell', () => ({ AuthShell: 'AuthShell', authAppearance: { variables: { borderRadius: '6px' } } }));
vi.mock('@/components/ui', () => ({ LoadingState: 'LoadingState' }));
vi.mock('@/components/setup-state', () => ({ SetupState: 'SetupState' }));
vi.mock('@/lib/server-config', () => ({ authConfigured: () => state.configured }));
vi.mock('@/lib/workspace-return', async () => await import('../lib/workspace-return'));

describe('authentication route preservation', () => {
  it('keeps the sign-in provider, routing and destination in both navigation paths', async () => {
    const page = await SignInPage({ searchParams: Promise.resolve({ redirect_url: '/app/work?site=site_one' }) });
    expect(page.props.alternateHref).toBe('/sign-up?redirect_url=%2Fapp%2Fwork%3Fsite%3Dsite_one');
    expect(page.props.children.type).toBe('RealClerkSignIn');
    expect(page.props.children.props.fallback.props).toMatchObject({ label: 'Loading sign-in', variant: 'compact' });
    expect(page.props.children.props).toMatchObject({ routing: 'path', path: '/sign-in', forceRedirectUrl: '/app/work?site=site_one', fallbackRedirectUrl: '/app', signUpUrl: page.props.alternateHref });
  });
  it('keeps onboarding after signup and carries the requested work destination', async () => {
    const page = await SignUpPage({ searchParams: Promise.resolve({ redirect_url: '/app/work?site=site_one' }) });
    expect(page.props.children.type).toBe('RealClerkSignUp');
    expect(page.props.children.props).toMatchObject({ routing: 'path', path: '/sign-up', signInUrl: page.props.alternateHref, forceRedirectUrl: '/app/onboarding?returnTo=%2Fapp%2Fwork%3Fsite%3Dsite_one', fallbackRedirectUrl: '/app/onboarding' });
  });
  it.each(['javascript:alert(1)', '//untrusted.example', '/outside', ['one', 'two']])('rejects unsafe or ambiguous redirect values %j', async redirect_url => {
    const page = await SignInPage({ searchParams: Promise.resolve({ redirect_url }) });
    expect(page.props.children.props.forceRedirectUrl).toBe('/app');
    expect(page.props.alternateHref).toBe('/sign-up?redirect_url=%2Fapp');
  });
  it('retains the setup state when authentication is not configured', async () => {
    state.configured = false;
    try { expect((await SignInPage({ searchParams: Promise.resolve({}) })).type).toBe('SetupState'); expect((await SignUpPage({ searchParams: Promise.resolve({}) })).type).toBe('SetupState'); }
    finally { state.configured = true; }
  });
});
