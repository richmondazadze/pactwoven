'use client';
import Link from 'next/link';
import { isAccessOwner } from '../lib/access-review';
import { useWorkspace } from './workspace-provider';
import { WorkOverview } from './native-work-page';
import { PageHeading } from './ui';
import { Icon } from './icon';
import '../app/native-tasks.css';

export function WorkspaceOverview() {
  const { session } = useWorkspace();
  return <div className="native-overview">
    <PageHeading title="Overview" description="Give the team an outcome. Keep the work, decisions and results together." />
    <div className="native-overview-layout"><WorkOverview/><aside className="native-overview-aside" aria-label="Workspace context and records">
      <h2>{session.organization.name}</h2><p>{session.sites.length} {session.sites.length === 1 ? 'site' : 'sites'} in your workspace</p>
      <nav aria-label="Workspace records"><Link href="/app/responsibilities"><Icon name="layers" /><span><strong>Responsibility records</strong><small>Review existing outcomes and their authority</small></span></Link>{isAccessOwner(session) && <Link href="/app/organization"><Icon name="users" /><span><strong>Workspace access</strong><small>Manage people and permitted sites</small></span></Link>}<Link href="/app/organization/security"><Icon name="shield-lock" /><span><strong>Account security</strong><small>Review your account protection</small></span></Link></nav>
      <p className="native-overview-note">New goals begin with research and advice. Review the scope, follow recorded progress, and return to saved results.</p>
    </aside></div>
  </div>;
}
