import type { Metadata } from 'next';
import { NativeWorkPage } from '@/components/native-work-page';
export const metadata: Metadata = { title: 'Work' };
export default async function WorkPage({ searchParams }: { searchParams: Promise<{ site?: string | string[] }> }) {
  const { site } = await searchParams;
  return <NativeWorkPage initialSite={typeof site === 'string' ? site : undefined}/>;
}
