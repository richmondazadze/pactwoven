import { ResponsibilityDetail } from '@/components/responsibility-detail';
export const metadata = { title: 'Responsibility' };
export default async function ResponsibilityPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <ResponsibilityDetail id={id}/>; }
