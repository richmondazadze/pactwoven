import { notFound } from 'next/navigation';
import { findUseCase, useCases } from '@/components/marketing/content';
import { marketingMetadata } from '@/components/marketing/metadata';
import { UseCaseDetailPage } from '@/components/marketing/secondary-pages';

type Props = { params: Promise<{ slug: string }> };
export const dynamicParams = false;
export function generateStaticParams() {
  return useCases.map(({ slug }) => ({ slug }));
}
export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const item = findUseCase(slug);
  if (!item) notFound();
  return marketingMetadata(item.title, item.description, `/use-cases/${item.slug}`);
}
export default async function Page({ params }: Props) {
  const { slug } = await params;
  const item = findUseCase(slug);
  if (!item) notFound();
  return <UseCaseDetailPage item={item} />;
}
