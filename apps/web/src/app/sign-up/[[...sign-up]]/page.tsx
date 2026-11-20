import { SignUp } from '@clerk/nextjs';
import { AuthShell, authAppearance } from '@/components/auth-shell';
import { SetupState } from '@/components/setup-state';
import { LoadingState } from '@/components/ui';
import { authConfigured } from '@/lib/server-config';
import { workspaceAuthPath, workspaceOnboardingPath, workspaceReturnPath } from '@/lib/workspace-return';
export const metadata = { title: 'Create an account' };
export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ redirect_url?: string | string[] }> }) {
  if (!authConfigured()) return <SetupState/>;
  const destination = workspaceReturnPath((await searchParams).redirect_url);
  return <AuthShell mode="sign-up" alternateHref={workspaceAuthPath('/sign-in', destination)}><SignUp fallback={<LoadingState variant="compact" label="Loading account setup"/>} appearance={authAppearance} routing="path" path="/sign-up" signInUrl={workspaceAuthPath('/sign-in', destination)} forceRedirectUrl={workspaceOnboardingPath(destination)} fallbackRedirectUrl="/app/onboarding"/></AuthShell>;
}
