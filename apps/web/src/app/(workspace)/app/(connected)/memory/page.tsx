import type { Metadata } from 'next';
import { NativeMemoryPage } from '@/components/native-memory-list';
export const metadata: Metadata = { title: 'Memory' };
export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ site?: string | string[] }> }) {
  const { site } = await searchParams;
  return <NativeMemoryPage initialSite={typeof site === 'string' ? site : undefined}/>;
}
