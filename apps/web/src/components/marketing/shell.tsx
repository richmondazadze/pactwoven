'use client';
import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from '../icon';
import { useMarketingMotion } from './use-marketing-motion';
import { useDrawerPresence } from '../motion';

const navigation = [{ href: '/platform', label: 'Platform' }, { href: '/how-it-works', label: 'How it works' }, { href: '/use-cases', label: 'Use cases' }, { href: '/trust', label: 'Trust & control' }];
function NavigationProgress() { const { pending } = useLinkStatus(); return <span aria-hidden="true" className="mk-navigation-pending" data-pending={pending}/>; }
export function MarketingShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const root = useRef<HTMLDivElement>(null);
  useMarketingMotion(root, path);
  const [open, setOpen] = useState(false);
  const presence = useDrawerPresence(open);
  const previousPath = useRef(path);
  useEffect(() => { if (previousPath.current !== path) { setOpen(false); previousPath.current = path; } }, [path]);
  const links = navigation.map(item => <Link href={item.href} key={item.href} aria-current={path === item.href || path.startsWith(`${item.href}/`) ? 'page' : undefined} onClick={() => setOpen(false)}>{item.label}<NavigationProgress/></Link>);
  return <div className="marketing" ref={root}><a href="#marketing-main" className="skip-link">Skip to content</a><header className="mk-header"><span className="mk-header-depth" aria-hidden="true"/><span className="mk-reading-progress" aria-hidden="true"/><div className="mk-container mk-header-inner"><Link href="/" className="mk-brand" aria-label="Pactwoven home"><img src="/brand/logo.svg" alt="Pactwoven" width="168" height="38"/></Link><nav className="mk-desktop-nav" aria-label="Main navigation">{links}</nav><div className="mk-header-actions"><Link href="/sign-in" className="mk-sign-in">Sign in</Link><Link href="/app" className="mk-button mk-header-cta">Open workspace<Icon name="arrow-right" size={16}/></Link><Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><button type="button" className="mk-menu-button" aria-label="Open navigation"><Icon name="menu" size={22}/></button></Dialog.Trigger>{presence.present && <Dialog.Portal forceMount><Dialog.Overlay forceMount className="mk-menu-overlay"/><Dialog.Content forceMount ref={presence.ref} inert={!open} className="mk-mobile-panel"><div className="mk-mobile-heading"><Dialog.Title>Pactwoven</Dialog.Title><Dialog.Close className="mk-menu-close" aria-label="Close navigation"><Icon name="close"/></Dialog.Close></div><Dialog.Description className="sr-only">Explore Pactwoven’s platform, workflow and use cases.</Dialog.Description><nav aria-label="Mobile navigation">{links}<Link href="/about" onClick={() => setOpen(false)}>About</Link><Link href="/sign-in" onClick={() => setOpen(false)}>Sign in</Link></nav><Link href="/app" className="mk-button" onClick={() => setOpen(false)}>Open workspace<Icon name="arrow-right" size={18}/></Link><p className="mk-small">Development preview. Agent demonstrations are illustrative.</p></Dialog.Content></Dialog.Portal>}</Dialog.Root></div></div></header><main id="marketing-main" tabIndex={-1}><div className="route-content">{children}</div></main><footer className="mk-footer"><div className="mk-container"><div className="mk-footer-top"><div className="mk-footer-brand"><Link href="/" aria-label="Pactwoven home"><img src="/brand/logo.svg" alt="Pactwoven" width="168" height="38"/></Link><p>Keep the promise.<br/>Coordinate the rest.</p></div><nav aria-label="Footer product navigation"><h2>Explore</h2>{navigation.map(item => <Link key={item.href} href={item.href}>{item.label}</Link>)}</nav><nav aria-label="Footer company navigation"><h2>Pactwoven</h2><Link href="/about">About</Link><Link href="/trust#preview-status">Development status</Link><Link href="/app">Workspace</Link><Link href="/sign-in">Sign in</Link></nav></div><div className="mk-footer-bottom"><span>© {new Date().getFullYear()} Pactwoven</span><span>Built for one human. Designed to work together.</span></div></div></footer></div>;
}
