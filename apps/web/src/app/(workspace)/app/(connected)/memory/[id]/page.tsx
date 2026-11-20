import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { IdSchema } from '@pactwoven/contracts';
import { NativeMemoryEditor } from '@/components/native-memory-editor';
export const metadata: Metadata = { title: 'Saved note' };
export default async function MemoryDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ site?: string | string[] }> }) {
  const [{ id }, { site }] = await Promise.all([params, searchParams]);
  const parsedId = IdSchema.safeParse(id), parsedSite = IdSchema.safeParse(site);
  if (!parsedId.success || !parsedSite.success) notFound();
  return <NativeMemoryEditor id={parsedId.data} siteId={parsedSite.data}/>;
}
