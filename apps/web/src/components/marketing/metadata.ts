import type { Metadata } from 'next';
export const siteOrigin = 'https://pactwoven.vercel.app';
export function marketingMetadata(title: string, description: string, path: string): Metadata {
  return {
    title, description, alternates: { canonical: `${siteOrigin}${path}` },
    openGraph: { title: `${title} · Pactwoven`, description, url: `${siteOrigin}${path}`, siteName: 'Pactwoven', type: 'website', images: [{ url: `${siteOrigin}/social-preview`, width: 1200, height: 630, alt: 'Pactwoven — one operator, a coordinated team of AI agents.' }] },
    twitter: { card: 'summary_large_image', title: `${title} · Pactwoven`, description, images: [`${siteOrigin}/social-preview`] },
  };
}
