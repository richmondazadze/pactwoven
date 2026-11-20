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
    borderRadius: '8px',
  },
  elements: {
    rootBox: 'auth-clerk-root',
    cardBox: 'auth-clerk-card-box',
    card: 'auth-clerk-card',
    headerTitle: 'auth-clerk-title',
    headerSubtitle: 'auth-clerk-subtitle',
    formFieldLabel: 'auth-clerk-label',
    formFieldInput: 'auth-clerk-input',
    formButtonPrimary: 'auth-clerk-primary',
    socialButtonsBlockButton: 'auth-clerk-social',
    footer: 'auth-clerk-footer',
    footerActionText: 'auth-clerk-footer-text',
    footerActionLink: 'auth-clerk-footer-link',
  },
};

export function AuthShell({ mode, children }: { mode: 'sign-in' | 'sign-up'; children: ReactNode }) {
  const signingIn = mode === 'sign-in';
  return (
    <div className="auth-page">
      <a href="#auth-content" className="skip-link">Skip to {signingIn ? 'sign in' : 'create account'}</a>
      <header className="auth-header">
        <Link href="/" className="brand-link"><img src="/brand/logo.svg" alt="Pactwoven" width="162" height="36"/></Link>
        <Link href="/" className="auth-back-link"><Icon name="arrow-left" size={16}/><span>Back to Pactwoven</span></Link>
      </header>
      <main id="auth-content" className="auth-layout">
        <section className="auth-story" aria-labelledby="auth-title">
          <p className="auth-kicker"><span/>{signingIn ? 'Your workspace' : 'A clear place to begin'}</p>
          <h1 id="auth-title">{signingIn ? <>Welcome back.<br/>Keep work moving.</> : <>Bring your<br/>work together.</>}</h1>
          <p className="auth-description">{signingIn ? 'Pick up your responsibilities, review decisions and follow the handoffs in your organization’s workspace.' : 'Create your account, choose your organization and give the work a place to happen.'}</p>
          <div className="auth-brand-field" aria-hidden="true">
            <div className="auth-fold-frame"><span/><img src="/brand/symbol.svg" alt="" width="112" height="112"/><span/></div>
            <span className="auth-brand-caption">Keep the promise.</span>
          </div>
        </section>
        <section className="auth-form-column" aria-label={signingIn ? 'Sign in to Pactwoven' : 'Create your Pactwoven account'}>
          {children}
          <p className="auth-form-note"><Icon name="building" size={16}/>Your account connects you to your organization’s workspace.</p>
        </section>
      </main>
      <footer className="auth-footer"><span>Pactwoven</span><Link href="/trust">Trust &amp; safeguards<Icon name="arrow-right" size={14}/></Link></footer>
    </div>
  );
}
