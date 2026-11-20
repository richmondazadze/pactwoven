import { FinancialPolicyAuthoringWorkspace } from '../../../../../../../../../../../components/financial-policy-authoring-workspace';
import { Alert } from '../../../../../../../../../../../components/ui';
export const metadata = { title: 'Review a financial configuration revision' };
export default async function ReviseFinancialPolicyPage({ params, searchParams }: {
  params: Promise<{ id: string; policyId: string; version: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, policyId, version } = await params;
  const { kind } = await searchParams;
  if (kind !== undefined && kind !== 'document' && kind !== 'draft')
    return <Alert title="Configuration preparation unavailable"><p>Choose a supported policy text or incomplete draft revision.</p></Alert>;
  return <FinancialPolicyAuthoringWorkspace id={id} policyId={policyId} version={version} revisionKind={kind ?? 'draft'}/>;
}
