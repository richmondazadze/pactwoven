import { MandateAuthoringWorkspace } from '@/components/mandate-authoring-workspace';
export const metadata = { title: 'Revise mandate proposal' };
export default async function ReviseMandatePage({ params }: { params: Promise<{ id: string; proposalId: string; version: string }> }) { const { id, proposalId, version } = await params; return <MandateAuthoringWorkspace responsibilityId={id} revision={{ proposalId, version }}/>; }
