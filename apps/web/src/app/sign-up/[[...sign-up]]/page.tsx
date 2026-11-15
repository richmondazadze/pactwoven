import Link from 'next/link';
import { SignUp } from '@clerk/nextjs';
import { SetupState } from '@/components/setup-state';
import { authConfigured } from '@/lib/server-config';
export const metadata = { title: 'Create an account' };
export default function SignUpPage() {
  if (!authConfigured()) return <SetupState/>;
  return <main className="signin-page"><Link href="/" className="brand-link"><img src="/brand/logo.svg" alt="Pactwoven" width="180" height="40"/></Link><div className="signin-grid"><section><p className="eyebrow">A clear place to begin</p><h1>Bring your<br/>work together.</h1><p>Create your account, choose an organization, then add the first place where work happens.</p><div className="signin-mark"><img src="/brand/symbol.svg" alt="" width="170" height="170"/></div></section><div className="signin-form"><SignUp appearance={{ elements: { rootBox: { width: "100%", maxWidth: 400 }, cardBox: { width: "100%", maxWidth: "100%" } } }} routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/app/onboarding"/></div></div></main>;
}
