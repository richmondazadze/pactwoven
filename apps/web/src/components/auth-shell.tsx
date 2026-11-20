import Link from 'next/link';
import type { SignIn } from '@clerk/nextjs';
import type { ComponentProps, ReactNode } from 'react';
import { Icon } from './icon';
import '../app/auth.css';

export const authAppearance: NonNullable<ComponentProps<typeof SignIn>['appearance']> = {
  variables: {
    colorPrimary: '#155EEF',
    colorForeground: '#111318',
    colorMutedForeground: '#596579',
    fontFamily: 'var(--font-manrope)',
    borderRadius: '6px',
  },
  elements: {
    rootBox: 'auth-clerk-root',
    cardBox: 'auth-clerk-card-box',
    card: 'auth-clerk-card',
    header: 'auth-clerk-header',
    headerTitle: 'auth-clerk-title',
    headerSubtitle: 'auth-clerk-subtitle',
    formFieldLabel: 'auth-clerk-label',
    formFieldInput: 'auth-clerk-input',
    formButtonPrimary: 'auth-clerk-primary',
    socialButtonsBlockButton: 'auth-clerk-social',
    footer: 'auth-clerk-footer',
    footerActionText: 'auth-clerk-footer-text',
    footerActionLink: 'auth-clerk-footer-link',
    formFieldAction: 'auth-clerk-field-action',
    formFieldInputShowPasswordButton: 'auth-clerk-password-toggle',
    identityPreviewEditButton: 'auth-clerk-identity-edit',
    alternativeMethodsBlockButton: 'auth-clerk-alternative',
  },
};

/** An explanatory illustration, never a preview of an authenticated task. */
export function AuthWorkflowIllustration() {
  return <figure className="auth-workflow" aria-labelledby="auth-workflow-caption">
    <figcaption id="auth-workflow-caption">How work comes together</figcaption>
    <div className="auth-workflow-diagram" aria-hidden="true">
      <div className="auth-workflow-goal"><Icon name="clipboard" size={18}/><span>Start with a goal</span></div>
      <span className="auth-workflow-stem"/>
      <div className="auth-workflow-coordinator"><span className="auth-workflow-mark"><img src="/brand/symbol.svg" width="32" height="32" alt=""/></span><div><strong>Coordinator</strong><span>Make a plan. Bring the team together.</span></div></div>
      <div className="auth-workflow-branches"><div><span className="auth-workflow-agent-icon"><Icon name="search" size={20}/></span><strong>Research</strong><span>Find the useful details</span></div><div><span className="auth-workflow-agent-icon"><Icon name="split-route" size={20}/></span><strong>Planning</strong><span>Shape the next steps</span></div></div>
      <div className="auth-workflow-outcome"><Icon name="document-signature" size={20}/><div><strong>A clear result</strong><span>Review what matters. Decide what’s next.</span></div><Icon name="arrow-right" size={18}/></div>
    </div>
    <p className="sr-only">You describe a goal. A coordinator brings research and planning together, then presents the result for your review.</p>
  </figure>;
}

export function AuthShell({ mode, alternateHref, children }: { mode: 'sign-in' | 'sign-up'; alternateHref?: string; children: ReactNode }) {
  const signingIn = mode === 'sign-in';
  return <div className="auth-page">
    <a href="#auth-content" className="skip-link">Skip to {signingIn ? 'sign in' : 'create account'}</a>
    <main className="auth-layout">
      <section className="auth-form-column" aria-label={signingIn ? 'Sign in to Pactwoven' : 'Create your Pactwoven account'}>
        <header className="auth-header">
          <Link href="/" className="brand-link" aria-label="Pactwoven home"><img src="/brand/logo.svg" alt="Pactwoven" width="162" height="36"/></Link>
          <nav className="auth-mode-nav" aria-label="Account access">
            {signingIn ? <span aria-current="page">Sign in</span> : <Link href={alternateHref ?? '/sign-in'}>Sign in</Link>}
            {signingIn ? <Link href={alternateHref ?? '/sign-up'}>Create account</Link> : <span aria-current="page">Create account</span>}
          </nav>
        </header>
        <div className="auth-form-content" id="auth-content" tabIndex={-1}>
          {children}
          <p className="auth-form-note"><Icon name="building" size={16}/><span>Your account connects you to your organization’s workspace.</span></p>
        </div>
        <footer className="auth-footer"><Link href="/" className="auth-back-link"><Icon name="arrow-left" size={15}/><span>Back to Pactwoven</span></Link><Link href="/trust">Trust &amp; safeguards<Icon name="arrow-right" size={14}/></Link></footer>
      </section>
      <aside className="auth-story" aria-labelledby="auth-story-title">
        <div className="auth-story-copy"><p className="auth-kicker"><span/>One operator. A coordinated team.</p><h2 id="auth-story-title">Your next idea.<br/>Already in motion.</h2><p className="auth-description">Give your agents a goal. Follow their work, review decisions and keep every result in one place.</p></div>
        <AuthWorkflowIllustration/>
        <p className="auth-story-note"><Icon name="shield-lock" size={17}/><span>You stay in control. Payments need your exact approval.</span></p>
      </aside>
    </main>
  </div>;
}
