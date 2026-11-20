import { SignIn } from '@clerk/nextjs';
import { AuthShell, authAppearance } from '@/components/auth-shell';
import { SetupState } from '@/components/setup-state';
import { authConfigured } from '@/lib/server-config';
import { workspaceAuthPath, workspaceReturnPath } from '@/lib/workspace-return';
export const metadata = { title: 'Sign in' };
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ redirect_url?: string | string[] }> }) {
  if (!authConfigured()) return <SetupState/>;
  const destination = workspaceReturnPath((await searchParams).redirect_url);
  return <AuthShell mode="sign-in"><SignIn appearance={authAppearance} routing="path" path="/sign-in" forceRedirectUrl={destination} fallbackRedirectUrl="/app" signUpUrl={workspaceAuthPath('/sign-up', destination)}/></AuthShell>;
}
