import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { IdSchema } from '@pactwoven/contracts';
import { NativeAgentWorkDetail } from '@/components/native-agent-work-detail';
export const metadata: Metadata = { title: 'Your work' };
export default async function AgentWorkPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ site?: string | string[] }>;
}) {
  const [{ id }, { site }] = await Promise.all([params, searchParams]);
  if (!IdSchema.safeParse(id).success || typeof site !== 'string' || !IdSchema.safeParse(site).success) notFound();
  return <NativeAgentWorkDetail key={`${site}:${id}`} siteId={site} id={id}/>;
}
