import { FinancialPolicyWorkspace } from '@/components/financial-policy-workspace';
export const metadata = { title: 'Responsibility financial policies' };
export default async function ResponsibilityFinancialPoliciesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FinancialPolicyWorkspace id={id}/>;
}
