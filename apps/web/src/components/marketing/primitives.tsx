import type { ReactNode } from 'react';
import Link from 'next/link';
import { Icon, type IconName } from '../icon';

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="mk-text-link">{children}<Icon name="arrow-right" size={18}/></Link>;
}
export function MarketingButton({ href, children, secondary = false }: { href: string; children: ReactNode; secondary?: boolean }) {
  return <Link href={href} className={`mk-button${secondary ? ' mk-button-secondary' : ''}`}>{children}<Icon name="arrow-right" size={18}/></Link>;
}
export function PageHero({ eyebrow, title, description, children }: { eyebrow?: string; title: string; description: string; children?: ReactNode }) {
  return <section className={`mk-container mk-page-hero${children ? ' mk-page-hero-split' : ''}`}><div className="mk-hero-copy">{eyebrow && <p className="mk-kicker">{eyebrow}</p>}<h1>{title}</h1><p className="mk-lead">{description}</p></div>{children}</section>;
}
export function SectionHeading({ eyebrow, title, description }: { eyebrow?: string; title: string; description?: string }) {
  return <div className="mk-section-heading">{eyebrow && <p className="mk-kicker">{eyebrow}</p>}<h2>{title}</h2>{description && <p>{description}</p>}</div>;
}
export function FeatureGrid({ items }: { items: { icon: IconName; title: string; description: string }[] }) {
  return <div className="mk-feature-grid">{items.map(item => <article className="mk-feature" key={item.title}><span className="mk-feature-icon"><Icon name={item.icon} size={24}/></span><h3>{item.title}</h3><p>{item.description}</p></article>)}</div>;
}
export function Availability() {
  return <section className="mk-container mk-section" aria-label="Development availability"><SectionHeading eyebrow="Where we are today" title="A clear view of what’s ready." description="Pactwoven is in development. Explore the workspace today and follow the direction we’re building toward."/><div className="mk-status-grid"><article className="mk-status-card"><span className="mk-status"><span/>Development preview</span><h3>A foundation for your operations.</h3><p>Set up your organization, define responsibilities and review scoped access and policy records.</p><TextLink href="/app">Open the workspace</TextLink></article><article className="mk-status-card"><span className="mk-status mk-status-planned"><Icon name="clock" size={14}/>In development</span><h3>Your own team of AI agents.</h3><p>Native coordination, specialist tools, shared memory and a live execution view. Website demos illustrate this intended experience.</p><TextLink href="/how-it-works">Explore the workflow</TextLink></article></div></section>;
}
export function Cta({ title = 'Give the work direction.', description = 'Start with a clear outcome. Bring the plan, the decisions and the record together.' }: { title?: string; description?: string }) {
  return <section className="mk-container mk-closing"><div><img src="/brand/symbol.svg" width="48" height="48" alt=""/><h2>{title}</h2><p>{description}</p></div><MarketingButton href="/app">Explore the preview</MarketingButton></section>;
}
