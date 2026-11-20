import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthShell, AuthWorkflowIllustration, authAppearance } from './auth-shell';
import { workspaceAuthPath } from '../lib/workspace-return';

describe('Pactwoven authentication presentation', () => {
  it.each(['sign-in', 'sign-up'] as const)('keeps the real %s provider subtree, errors and recovery controls intact', mode => {
    const provider = createElement('form', { 'aria-label': 'Provider challenge' },
      createElement('label', null, 'Verification code', createElement('input', { name: 'code', autoComplete: 'one-time-code' })),
      createElement('p', { role: 'alert' }, 'The code has expired.'),
      createElement('button', { type: 'submit' }, 'Verify code'),
      createElement('button', { type: 'button' }, 'Use another method'));
    const tree = AuthShell({ mode, children: provider });
    const html = renderToStaticMarkup(tree);
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toContain('Provider challenge'); expect(html).toContain('role="alert"');
    expect(html).toContain('autoComplete="one-time-code"'); expect(html).toContain('Use another method');
    expect(html).toContain('id="auth-content" tabindex="-1"');
    expect(html.indexOf('Provider challenge')).toBeLessThan(html.indexOf('auth-story-title'));
  });
  it.each(['sign-in', 'sign-up'] as const)('marks one current account mode and preserves the safe return path in %s', mode => {
    const other = mode === 'sign-in' ? '/sign-up' : '/sign-in';
    const destination = '/app/work?site=site_one';
    const href = workspaceAuthPath(other, destination);
    const html = renderToStaticMarkup(createElement(AuthShell, { mode, alternateHref: href, children: null }));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('aria-label="Account access"');
    expect(html).toContain('aria-label="Pactwoven home"');
  });
  it('uses an explicitly described illustration without fabricated execution, controls or amounts', () => {
    const html = renderToStaticMarkup(createElement(AuthWorkflowIllustration));
    expect(html).toContain('How work comes together'); expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('You describe a goal.');
    for (const word of ['<button', '<input', 'role="status"', 'aria-live', 'Payment confirmed', 'USDC']) expect(html).not.toContain(word);
  });
  it('keeps six-pixel Clerk controls and names its provider-owned recovery controls for styling', () => {
    expect(authAppearance.variables?.borderRadius).toBe('6px');
    expect(authAppearance.variables?.fontFamily).toBe('var(--font-manrope)');
    expect(authAppearance.elements).toMatchObject({ formFieldInputShowPasswordButton: 'auth-clerk-password-toggle', identityPreviewEditButton: 'auth-clerk-identity-edit', alternativeMethodsBlockButton: 'auth-clerk-alternative' });
  });
});
