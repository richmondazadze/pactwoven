import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { IdSchema } from '@pactwoven/contracts';
import { NativeTaskWorkspace } from '@/components/native-task-workspace';
export const metadata: Metadata = { title: 'Your work' };
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!IdSchema.safeParse(id).success) notFound();
  return <NativeTaskWorkspace key={id} id={id} />;
}
