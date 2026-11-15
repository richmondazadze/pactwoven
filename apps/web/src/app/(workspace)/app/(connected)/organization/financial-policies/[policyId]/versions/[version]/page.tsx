import { FinancialPolicyWorkspace } from '@/components/financial-policy-workspace';
export const metadata = { title: 'Financial-policy version' };
export default async function OrganizationFinancialPolicyVersionPage({ params }: { params: Promise<{ policyId: string; version: string }> }) {
  const { policyId, version } = await params;
  return <FinancialPolicyWorkspace policyId={policyId} version={version}/>;
}
