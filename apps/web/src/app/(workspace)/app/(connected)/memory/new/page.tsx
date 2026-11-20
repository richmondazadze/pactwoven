import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { IdSchema } from '@pactwoven/contracts';
import { NativeMemoryEditor } from '@/components/native-memory-editor';
export const metadata: Metadata = { title: 'Remember something' };
export default async function NewMemoryPage({ searchParams }: { searchParams: Promise<{ site?: string | string[] }> }) {
  const { site } = await searchParams;
  const parsed = IdSchema.safeParse(site);
  if (!parsed.success) notFound();
  return <NativeMemoryEditor siteId={parsed.data}/>;
}
