import type { AccessScope, MemberAccess, Session } from '@pactwoven/contracts';
import { effectiveReadingDescription, type AccessIntent, type AccessSelection } from '../lib/access-review';
import { accessRoleLabels } from '../lib/presentation';
import { VerificationDetails } from './verification-details';
import { Alert, Panel, StatusBadge } from './ui';

function SiteNames({ ids, sites, empty = 'None' }: { ids: string[]; sites: Session['sites']; empty?: string }) {
  return ids.length ? <ul className="access-scope-list">{ids.map(id => {
    const site = sites.find(value => value.id === id), ambiguous = !site || sites.filter(value => value.name === site.name).length > 1;
    return <li key={id}><span>{site?.name ?? 'Site name unavailable'}</span>{ambiguous && <code>{id}</code>}</li>;
  })}</ul> : empty;
}
function SiteReferences({ scope }: { scope: Pick<AccessScope, 'siteIds' | 'actionSiteIds'> }) {
  return <VerificationDetails label="Exact site references"><dl><div><dt>Assigned read sites</dt><dd>{scope.siteIds.join(', ') || 'None'}</dd></div><div><dt>Action sites</dt><dd>{scope.actionSiteIds.join(', ') || 'None'}</dd></div></dl></VerificationDetails>;
}
function IdentityReferences({ member }: { member: MemberAccess }) {
  return <VerificationDetails label="Member record verification"><dl>
    <div><dt>Actor</dt><dd>{member.actorId}</dd></div><div><dt>Identity provider subject</dt><dd>{member.externalSubject}</dd></div>
    <div><dt>Organization membership</dt><dd>{member.externalMembershipId}</dd></div><div><dt>Recorded member version</dt><dd>{member.version}</dd></div>
  </dl></VerificationDetails>;
}
export function AccessScopeFacts({ scope, sites }: { scope: AccessScope; sites: Session['sites'] }) {
  return <><dl className="review-key-values"><div><dt>Roles</dt><dd>{scope.roles.map(role => accessRoleLabels[role]).join(', ')}</dd></div>
    <div><dt>Effective reading scope</dt><dd>{effectiveReadingDescription(scope)}</dd></div>
    <div><dt>Assigned read sites</dt><dd><SiteNames ids={scope.siteIds} sites={sites}/></dd></div><div><dt>Action sites</dt><dd><SiteNames ids={scope.actionSiteIds} sites={sites}/></dd></div>
    <div><dt>Access expires</dt><dd>{scope.expiresAt ? <time dateTime={scope.expiresAt}>{scope.expiresAt}</time> : 'No scheduled expiry'}</dd></div>
  </dl><SiteReferences scope={scope}/></>;
}
export function MemberAccessReview({ selection, intent, sites }: { selection: AccessSelection; intent: AccessIntent; sites: Session['sites'] }) {
  const identity = selection.kind === 'grant' ? selection.candidate : selection.member;
  return <div className="access-exact-review"><Panel title="Exact access change">
    <div className="access-person"><span className="access-avatar">{identity.displayName.slice(0,1)}</span><div><h3>{identity.displayName}</h3><p>{intent.kind === 'grant' ? 'Grant app access' : intent.kind === 'revise' ? 'Revise app access' : 'Revoke app access'}</p></div></div>
    <dl className="review-key-values"><div><dt>Identity provider subject</dt><dd><code>{identity.externalSubject}</code></dd></div></dl>
    <p className="review-note">Verify this identity before changing access. People can share a display name.</p>
    <VerificationDetails label="Access change verification"><dl><div><dt>Organization membership</dt><dd>{identity.externalMembershipId}</dd></div><div><dt>Expected member version</dt><dd>{intent.command.expectedVersion}</dd></div><div><dt>Organization authority epoch</dt><dd>{intent.command.authorityEpoch}</dd></div></dl></VerificationDetails>
  </Panel><div className="access-comparison"><Panel title="Before">{selection.kind === 'grant' ? <p className="review-note">No app grant is being used as the basis of this request. The service checks that this membership can receive its first grant.</p> : <><p className="review-note">Reported status: {selection.member.status}</p><AccessScopeFacts scope={selection.member} sites={sites}/></>}</Panel>
    <Panel title="After">{intent.kind === 'revoke' ? <><p className="access-revoke-copy">App access revoked</p><p className="review-note">Historical access records and existing obligations remain.</p><dl className="review-key-values"><div><dt>Reason</dt><dd>{intent.command.payload.reason}</dd></div></dl></> : <AccessScopeFacts scope={intent.command.payload} sites={sites}/>}</Panel></div>
    <p className="review-note">Owner, finance and auditor roles read permitted records across all organization sites, even with no assigned read sites. Receivers also require responsibility assignment. Action sites remain explicit. This review does not authorize a command by itself.</p>
  </div>;
}
export function MemberIdentity({ member }: { member: MemberAccess }) { return <><strong>{member.displayName}</strong><span className="fine">Member version {member.version}</span></>; }
export function ReadOnlyMemberReview({ member, sites }: { member: MemberAccess; sites: Session['sites'] }) {
  if (member.status === 'revoked') return <RevokedMemberReview member={member} sites={sites}/>;
  return <div className="access-exact-review"><Panel title="Member record inspection"><p className="review-note">This is a read-only observation from the member list. It does not resolve an earlier request or start an access change.</p><div className="access-person"><div><h3>{member.displayName}</h3><StatusBadge>{member.status}</StatusBadge></div></div>
    {member.status === 'suspended' && <p className="review-note">This grant is suspended. Its recorded role and site fields do not prove active access.</p>}
    <AccessScopeFacts scope={member} sites={sites}/><IdentityReferences member={member}/>
  </Panel></div>;
}
export function RevokedMemberReview({ member, sites }: { member: MemberAccess; sites: Session['sites'] }) {
  return <div className="access-exact-review"><Alert title="Revoked access is read-only" tone="amber"><p>This app grant has been revoked. It cannot be revised or restored in this flow. You can inspect its recorded details below.</p></Alert><Panel title="Recorded member"><div className="access-person"><span className="access-avatar">{member.displayName.slice(0,1)}</span><div><h3>{member.displayName}</h3><StatusBadge tone="red">Revoked</StatusBadge></div></div><dl className="review-key-values"><div><dt>Reading authority</dt><dd>None from this revoked grant</dd></div><div><dt>Action authority</dt><dd>None from this revoked grant</dd></div></dl><IdentityReferences member={member}/></Panel>
    <Panel title="Recorded grant details"><p className="review-note">These retained fields describe the grant record. They do not provide active access.</p><dl className="review-key-values"><div><dt>Recorded roles</dt><dd>{member.roles.map(role => accessRoleLabels[role]).join(', ')}</dd></div><div><dt>Recorded assigned read sites</dt><dd><SiteNames ids={member.siteIds} sites={sites} empty="None recorded"/></dd></div><div><dt>Recorded action sites</dt><dd><SiteNames ids={member.actionSiteIds} sites={sites} empty="None recorded"/></dd></div><div><dt>Recorded expiry</dt><dd>{member.expiresAt ? <time dateTime={member.expiresAt}>{member.expiresAt}</time> : 'No scheduled expiry was recorded'}</dd></div></dl><SiteReferences scope={member}/></Panel></div>;
}
