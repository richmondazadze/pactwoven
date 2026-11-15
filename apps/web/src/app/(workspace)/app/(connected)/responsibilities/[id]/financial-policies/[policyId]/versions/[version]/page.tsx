import { FinancialPolicyWorkspace } from '@/components/financial-policy-workspace';
export const metadata = { title: 'Responsibility financial-policy version' };
export default async function ResponsibilityFinancialPolicyVersionPage({ params }: { params: Promise<{ id: string; policyId: string; version: string }> }) {
  const { id, policyId, version } = await params;
  return <FinancialPolicyWorkspace id={id} policyId={policyId} version={version}/>;
}
