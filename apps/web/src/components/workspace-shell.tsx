'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { useEffect, useRef, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Icon, type IconName } from './icon';
import { MobileDrawer } from './ui';
import { RouteArrival } from './motion';
import { readableMemorySites } from '../lib/native-memory';
import { isAccessOwner } from '../lib/access-review';
import { canManageGoogle } from '../lib/google-access';
import { useWorkspace, canReadResponsibilities } from './workspace-provider';

type Destination = { href: string; label: string; icon: IconName; active: boolean };
const SIDEBAR_PREFERENCE = 'pactwoven.sidebar.collapsed';

function NavigationGroup({ label, items, collapsed = false }: { label: string; items: Destination[]; collapsed?: boolean }) {
  if (!items.length) return null;
  return <div className="workspace-nav-group"><span className="nav-label">{label}</span>{items.map(item => {
    const link = <Link href={item.href} aria-current={item.active ? 'page' : undefined}><Icon name={item.icon}/><span className="nav-item-label">{item.label}</span></Link>;
    return collapsed ? <Tooltip.Root key={item.href}><Tooltip.Trigger asChild>{link}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="workspace-tooltip" side="right" sideOffset={12}>{item.label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root> : <span className="workspace-nav-item" key={item.href}>{link}</span>;
  })}</div>;
}

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const { session } = useWorkspace();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [details, setDetails] = useState(false);
  const detailsToggle = useRef<HTMLButtonElement>(null);
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { try { setCollapsed(localStorage.getItem(SIDEBAR_PREFERENCE) === 'true'); } catch { /* Navigation works without local storage. */ } }, []);
  useEffect(() => {
    setOpen(false); setDetails(false);
    const main = document.getElementById('workspace-main');
    if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
  }, [pathname]);
  useEffect(() => { if (details) detailsHeading.current?.focus({ preventScroll: true }); }, [details]);
  function toggleSidebar() {
    const next = !collapsed; setCollapsed(next);
    try { localStorage.setItem(SIDEBAR_PREFERENCE, String(next)); } catch { /* Preference is optional. */ }
  }
  function closeDetails() { setDetails(false); detailsToggle.current?.focus({ preventScroll: true }); }
  const isWork = pathname.startsWith('/app/work');
  const isCalendar = pathname.startsWith('/app/settings/connections/google');
  const isMemory = pathname.startsWith('/app/memory');
  const isSecurity = pathname.startsWith('/app/organization/security');
  const isOrganization = pathname.startsWith('/app/organization');
  const readsRecords = canReadResponsibilities(session);
  const readsMemory = readableMemorySites(session).length > 0;
  const managesGoogle = canManageGoogle(session);
  const ownsAccess = isAccessOwner(session);
  const title = pathname === '/app' ? 'Overview' : pathname.startsWith('/app/inbox') ? 'Inbox' : isWork ? 'Work' : isCalendar ? 'Google Calendar' : isMemory ? 'Memory' : isSecurity ? 'Security & access' : pathname.includes('/financial-policies') ? 'Financial policies' : pathname.includes('/mandates') ? 'Mandates' : isOrganization ? 'People & authority' : pathname.includes('/decisions') ? 'Decisions' : 'Responsibilities';
  const permitted = isCalendar ? managesGoogle : isMemory ? readsMemory : isSecurity || (isOrganization ? ownsAccess : readsRecords);
  const primary: Destination[] = [
    ...(readsRecords ? [
      { href: '/app', label: 'Overview', icon: 'connected-nodes' as const, active: pathname === '/app' },
      { href: '/app/work', label: 'Work', icon: 'chat' as const, active: isWork },
      { href: '/app/inbox', label: 'Inbox', icon: 'inbox' as const, active: pathname.startsWith('/app/inbox') },
      { href: '/app/responsibilities', label: 'Records', icon: 'folder' as const, active: pathname.includes('/responsibilities') },
    ] : []),
    ...(readsMemory ? [{ href: '/app/memory', label: 'Memory', icon: 'layers' as const, active: isMemory }] : []),
  ];
  const management: Destination[] = [
    ...(managesGoogle ? [{ href: '/app/settings/connections/google', label: 'Calendar', icon: 'calendar' as const, active: isCalendar }] : []),
    ...(ownsAccess ? [{ href: '/app/organization', label: 'Workspace access', icon: 'users' as const, active: isOrganization && !isSecurity }] : []),
    { href: '/app/organization/security', label: 'Security & access', icon: 'shield-lock', active: isSecurity },
  ];
  const availableSites = session.sites.filter(site => session.actor.siteIds.includes(site.id));
  const environmentLabel = { production: 'Production', development: 'Development', simulation: 'Simulation', staging: 'Staging' }[session.actor.environment];
  const sectionDescription = isWork ? 'Give your agents a task, follow their progress and review the result.' : isMemory ? 'Keep useful context ready for the work you choose to share it with.' : isCalendar ? 'Manage your Google Calendar connection and event permissions.' : isOrganization ? 'Manage the access and safeguards for this workspace.' : pathname.startsWith('/app/inbox') ? 'Review the decisions and updates that need your attention.' : pathname === '/app' ? 'A starting point for your work, records and decisions.' : 'Keep the request, its decisions and supporting evidence together.';
  function navigation(isCollapsed = false) {
    return <nav className="workspace-nav" aria-label="Workspace"><NavigationGroup label="Workspace" items={primary} collapsed={isCollapsed}/><NavigationGroup label="Manage" items={management} collapsed={isCollapsed}/></nav>;
  }
  const organization = <div className="workspace-org"><span className="organization-icon"><Icon name="building"/></span><div><strong title={session.organization.name}>{session.organization.name}</strong><span>Your workspace</span></div></div>;
  return <Tooltip.Provider delayDuration={200}><div className="workspace" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
    <a href="#workspace-main" className="skip-link">Skip to content</a>
    <aside className="workspace-rail" aria-label="Workspace sidebar">
      <Link href="/" className="rail-logo" aria-label="Pactwoven home"><img className="rail-wordmark" src="/brand/logo.svg" alt="" width="140" height="32"/><img className="rail-symbol" src="/brand/symbol-small.svg" alt="" width="28" height="28"/></Link>
      {organization}{navigation(collapsed)}
      <div className="rail-bottom"><button className="sidebar-toggle" onClick={toggleSidebar} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><Icon name={collapsed ? 'arrow-right' : 'arrow-left'}/><span>Collapse sidebar</span></button></div>
    </aside>
    <div className="workspace-body">
      <header className="workspace-header">
        <MobileDrawer open={open} onOpenChange={setOpen} title={session.organization.name} trigger={<button className="icon-button workspace-menu" aria-label="Open workspace navigation"><Icon name="menu"/></button>}>
          {organization}{navigation()}<div className="rail-bottom"><Link href="/" className="muted-link"><Icon name="arrow-left"/>Pactwoven home</Link></div>
        </MobileDrawer>
        <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-divider" aria-hidden="true">/</span><span>{title}</span></div>
        <div className="workspace-header-right"><button ref={detailsToggle} className="workspace-details-toggle" aria-expanded={details} aria-controls="workspace-context" onClick={() => details ? closeDetails() : setDetails(true)}><Icon name="circle-question" size={18}/><span>Details</span></button><span className="workspace-header-divider" aria-hidden="true"/><UserButton appearance={{ elements: { userButtonTrigger: 'pact-user-trigger' } }}/></div>
      </header>
      <div className="workspace-content" data-details={details || undefined}>
        {details && <aside id="workspace-context" className="workspace-context" aria-labelledby="workspace-context-title" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeDetails(); } }}>
          <div className="workspace-context-heading"><h2 id="workspace-context-title" ref={detailsHeading} tabIndex={-1}>Workspace details</h2><button className="icon-button" onClick={closeDetails} aria-label="Close workspace details"><Icon name="close" size={18}/></button></div>
          <section className="workspace-context-section"><span className="context-label">You’re in</span><h3>{title}</h3><p>{sectionDescription}</p></section>
          <section className="workspace-context-section"><span className="context-label">Workspace</span><h3>{session.organization.name}</h3><span className={`environment ${session.actor.environment === 'production' ? 'production' : ''}`}><span/>{environmentLabel}</span><p>{session.actor.environment === 'production' ? 'Access follows your role and assigned sites.' : 'Test workspace. Live orders and funds require separate authorization.'}</p></section>
          <section className="workspace-context-section"><h3 className="context-label">Available sites</h3>{availableSites.length ? <ul className="workspace-context-sites">{availableSites.map(site => <li key={site.id}><Icon name="map-pin" size={16}/><div><strong>{site.name}</strong><span>{site.timeZone.replaceAll('_', ' ')}</span></div></li>)}</ul> : <p>No sites are assigned to your account.</p>}</section>
          <Link className="workspace-context-link" href="/app/organization/security"><Icon name="shield-lock" size={18}/>Security & access<Icon name="arrow-right" size={16}/></Link>
        </aside>}
        <main id="workspace-main" tabIndex={-1} className="workspace-main"><RouteArrival>{permitted ? children : <div className="empty-state"><Icon name="shield-lock" size={32}/><h1>This page is outside your role.</h1><p>Your current role does not have access to this page. Use the workspace navigation to open permitted records.</p></div>}</RouteArrival></main>
      </div>
    </div>
  </div></Tooltip.Provider>;
}
