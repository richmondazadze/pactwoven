import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { authConfigured } from '@/lib/server-config';
import { SetupState } from '@/components/setup-state';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Workspace' };
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  if (!authConfigured()) return <SetupState/>;
  const session = await auth();
  if (!session.userId) redirect('/sign-in');
  return children;
}
