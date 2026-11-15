import Link from 'next/link';
import { SignIn } from '@clerk/nextjs';
import { SetupState } from '@/components/setup-state';
import { authConfigured } from '@/lib/server-config';
export const metadata = { title: 'Sign in' };
export default function SignInPage() {
  if (!authConfigured()) return <SetupState/>;
  return <main className="signin-page"><Link href="/" className="brand-link"><img src="/brand/logo.svg" alt="Pactwoven" width="180" height="40"/></Link><div className="signin-grid"><section><p className="eyebrow">Everything in its place</p><h1>Welcome back.<br/>Let’s keep work moving.</h1><p>Your responsibilities, decisions and handoffs are waiting in your organization’s workspace.</p><div className="signin-mark"><img src="/brand/symbol.svg" alt="" width="170" height="170"/></div></section><div className="signin-form"><SignIn appearance={{ elements: { rootBox: { width: "100%", maxWidth: 400 }, cardBox: { width: "100%", maxWidth: "100%" } } }} routing="path" path="/sign-in" fallbackRedirectUrl="/app" signUpUrl="/sign-up"/></div></div></main>;
}
