import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/components/marketing/metadata';
import { useCases } from '@/components/marketing/content';
export default function sitemap(): MetadataRoute.Sitemap {
  return ['/', '/platform', '/how-it-works', '/use-cases', ...useCases.map(item => `/use-cases/${item.slug}`), '/trust', '/about'].map(path => ({ url: `${siteOrigin}${path}`, changeFrequency: 'monthly', priority: path === '/' ? 1 : .7 }));
}
