import { FinancialPolicyAuthoringWorkspace } from '@/components/financial-policy-authoring-workspace';
export const metadata = { title: 'Prepare financial configuration' };
export default async function PrepareFinancialPolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FinancialPolicyAuthoringWorkspace id={id}/>;
}
