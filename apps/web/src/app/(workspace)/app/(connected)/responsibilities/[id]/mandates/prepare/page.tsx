import { MandateAuthoringWorkspace } from '@/components/mandate-authoring-workspace';
export const metadata = { title: 'Prepare mandate proposal' };
export default async function PrepareMandatePage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <MandateAuthoringWorkspace responsibilityId={id}/>; }
