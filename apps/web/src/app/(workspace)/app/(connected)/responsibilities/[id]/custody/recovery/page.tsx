import { CustodySetupRecoveryWorkspace } from '@/components/custody-setup-recovery-workspace';
export const metadata = { title: 'Saved setup requests' };
export default async function CustodyRecoveryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustodySetupRecoveryWorkspace id={id}/>;
}
