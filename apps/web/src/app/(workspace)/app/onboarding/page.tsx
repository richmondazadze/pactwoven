import { OrganizationOnboarding } from '@/components/organization-onboarding';
import { workspaceReturnPath } from '@/lib/workspace-return';
export const metadata = { title: 'Set up your workspace' };
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const value = workspaceReturnPath((await searchParams).returnTo);
  const destination = value.split(/[?#]/)[0] === '/app/onboarding' ? '/app' : value;
  return <OrganizationOnboarding destination={destination}/>;
}
