import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { ClerkProvider } from '@clerk/nextjs';
import { RecoveryPrivacyBoundary } from '@/components/recovery-privacy';
import { MotionProvider } from '@/components/motion';
import { authConfigured } from '@/lib/server-config';
import './globals.css';
const geist = localFont({ src: '../fonts/geist-variable.ttf', variable: '--font-geist', weight: '100 900', display: 'swap' });
const manrope = localFont({ src: '../fonts/manrope-variable.ttf', variable: '--font-manrope', weight: '200 800', display: 'swap' });
export const metadata: Metadata = { title: { default: 'Pactwoven — Keep the promise.', template: '%s · Pactwoven' }, description: 'A clear home for responsibilities, supplier handoffs and the decisions that keep work moving.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const content = <MotionProvider>{children}</MotionProvider>;
  return <html lang="en" data-scroll-behavior="smooth" className={`${geist.variable} ${manrope.variable}`}><body>{authConfigured() ? <ClerkProvider publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!} signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/app" signUpFallbackRedirectUrl="/app/onboarding" appearance={{ variables: { colorPrimary: '#155EEF', borderRadius: '.75rem', fontFamily: 'var(--font-manrope)' } }}><RecoveryPrivacyBoundary>{content}</RecoveryPrivacyBoundary></ClerkProvider> : content}</body></html>;
}
