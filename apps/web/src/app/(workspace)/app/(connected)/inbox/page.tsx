import type { Metadata } from 'next';
import { NativeInbox } from '@/components/native-inbox';
export const metadata: Metadata = { title: 'Inbox' };
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ site?: string | string[] }> }) {
  const { site } = await searchParams;
  return <NativeInbox initialSite={typeof site === 'string' ? site : undefined}/>;
}
