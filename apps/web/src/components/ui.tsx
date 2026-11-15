'use client';
import Link from 'next/link';
import { useEffect, useId, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon, type IconName } from './icon';
import { BrandLoader } from './brand-loader';
import { useReversibleHeight, useDrawerPresence } from './motion';
export function ButtonLink({ href, children, secondary = false, className = '' }: { href: string; children: ReactNode; secondary?: boolean; className?: string }) { return <Link href={href} className={`button ${secondary ? 'secondary' : ''} ${className}`}>{children}</Link>; }
export function PageHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) { return <div className="page-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="actions">{action}</div>}</div>; }
export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'amber' | 'green' | 'red' | 'unknown' }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Alert({ title, children, tone = 'amber' }: { title: string; children: ReactNode; tone?: 'amber' | 'red' | 'blue' }) { return <div className={`alert ${tone}`} role={tone === 'red' ? 'alert' : 'status'}><Icon name={tone === 'red' ? 'circle-x' : tone === 'blue' ? 'circle-question' : 'triangle-alert'} /><div><strong>{title}</strong><div>{children}</div></div></div>; }
export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <section className="panel"><div className="panel-heading"><h2>{title}</h2>{action}</div><div className="panel-body">{children}</div></section>; }
export function EmptyState({ title, children, icon = 'inbox', action }: { title: string; children: ReactNode; icon?: IconName; action?: ReactNode }) { return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={28} /></span><h2>{title}</h2><p>{children}</p>{action && <div className="actions">{action}</div>}</div>; }
export function LoadingState({ label = 'Loading your workspace' }: { label?: string }) {
  const [showLoader, setShowLoader] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setShowLoader(true), 200); return () => clearTimeout(timer); }, []);
  return <div className="loading-state" role="status" aria-live="polite" aria-busy="true"><div className="loading-label">{showLoader && <BrandLoader/>}<span>{label}</span></div><div className="skeleton heading-skeleton"/><div className="skeleton"/><div className="skeleton block-skeleton"/></div>;
}
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false); const id = useId(); const ref = useReversibleHeight(open);
  return <section className="disclosure"><h3><button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={id}>{title}<Icon name="chevron-down" className={open ? 'rotated' : ''}/></button></h3><div id={id} ref={ref} className="disclosure-clip" inert={!open} aria-hidden={!open}><div className="disclosure-content">{children}</div></div></section>;
}
export function MobileDrawer({ trigger, title, children, open, onOpenChange }: { trigger: ReactNode; title: string; children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) {
  const presence = useDrawerPresence(open);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Trigger asChild>{trigger}</Dialog.Trigger>{presence.present && <Dialog.Portal forceMount><Dialog.Overlay forceMount className="dialog-overlay"/><Dialog.Content forceMount ref={presence.ref} inert={!open} className="mobile-drawer managed-drawer"><div className="drawer-title"><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label="Close navigation"><Icon name="close"/></Dialog.Close></div><Dialog.Description className="sr-only">Navigate your current organization workspace.</Dialog.Description>{children}</Dialog.Content></Dialog.Portal>}</Dialog.Root>;
}
