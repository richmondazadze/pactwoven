import type { Session } from '@pactwoven/contracts';
import type { AccessCapsule, OriginalObservation } from '../lib/access-capsule';
import { effectiveReadingDescription } from '../lib/access-review';
import { Disclosure, Panel, StatusBadge } from './ui';

export function OriginalAccessReview({capsule,observation,sites=[]}:{capsule:AccessCapsule;observation:OriginalObservation;sites?:Session['sites']}) {
  const {original,scope}=capsule;const command=original.command;
  const title=original.kind==='grant'?'Grant app access':original.kind==='revise'?'Revise app access':'Revoke app access';
  const orderedIds=(items:string[])=>items.length?<ol className="access-scope-list">{items.map(id=><li key={id}><code>{id}</code></li>)}</ol>:'None (empty array)';
  const siteNames=(ids:string[])=>ids.length?<ul className="original-access-sites">{ids.map(id=>{
    const name=sites.find(site=>site.id===id)?.name;
    const repeatedName=name&&ids.filter(other=>sites.find(site=>site.id===other)?.name===name).length>1;
    return <li key={id}><span>{name??'Site name unavailable'}</span>{(!name||repeatedName)&&<small>{id}</small>}</li>;
  })}</ul>:<span className="original-access-empty">No sites assigned</span>;
  return <div className="access-exact-review original-access-review">
    <Panel title={title}>
      <div className="original-access-primary">
        <div className="original-access-person"><span className="access-avatar" aria-hidden="true">{observation.target.displayName.slice(0,1)}</span><div><h3>{observation.target.displayName}</h3><p>Current member name, observed for this review</p></div></div>
        <p className="original-access-intro">This retry keeps the original access change. Member and site names are current observations; they do not change the retained request.</p>
        {original.kind==='revoke'?<div className="original-access-revocation"><p className="access-revoke-copy">End this member’s app access</p><dl className="original-access-facts"><div><dt>Original reason</dt><dd className="original-access-reason">{original.command.payload.reason}</dd></div></dl><p className="review-note">Historical records and existing obligations remain.</p></div>:<>
          <dl className="original-access-facts">
            <div className="original-access-roles"><dt>Roles in the original request</dt><dd><ul>{original.command.payload.roles.map(role=><li key={role}>{role.slice(0,1).toUpperCase()+role.slice(1)}</li>)}</ul></dd></div>
            <div className="original-access-reading"><dt>Effective reading scope</dt><dd>{effectiveReadingDescription(original.command.payload)}</dd></div>
            <div><dt>Assigned reading sites</dt><dd>{siteNames(original.command.payload.siteIds)}</dd></div>
            <div><dt>Action sites</dt><dd>{siteNames(original.command.payload.actionSiteIds)}</dd></div>
            <div className="original-access-expiry"><dt>Access expires</dt><dd>{original.command.payload.expiresAt?<time dateTime={original.command.payload.expiresAt}>{original.command.payload.expiresAt}</time>:'No scheduled expiry'}</dd></div>
          </dl>
          <p className="review-note">Site names are current workspace labels, shown in the original request order. Action sites remain explicit; receivers also require responsibility assignment.</p>
        </>}
        <div className="original-access-observation"><h3>Current record observation</h3>{'status'in observation.target?<div className="original-access-observed-state"><span>Recorded status <StatusBadge tone={observation.target.status==='revoked'?'red':'neutral'}>{observation.target.status}</StatusBadge></span><span>Member version <strong>{observation.target.version}</strong></span></div>:<p>Provider role: <strong>{observation.target.externalRole}</strong>. App grant status and version are not included in this observation.</p>}<p>Observed <time dateTime={observation.observedAt}>{observation.observedAt}</time>. This does not confirm the original request’s outcome.</p></div>
      </div>
      <div className="original-access-details"><Disclosure title="Request details">
        <p className="review-note">Immutable original request. These retained values stay unchanged on retry. No original before-state was retained; the current record above is a separate observation.</p>
        <dl className="review-key-values">
          <div><dt>Original action</dt><dd>{original.kind}</dd></div><div><dt>Original endpoint</dt><dd><code>{original.path}</code></dd></div><div><dt>Original target actor</dt><dd><code>{original.targetActorId??'null (new grant)'}</code></dd></div><div><dt>Original target subject</dt><dd><code>{capsule.targetIdentity.externalSubject}</code></dd></div><div><dt>Original target membership</dt><dd><code>{capsule.targetIdentity.externalMembershipId}</code></dd></div>
          <div><dt>Original requester subject</dt><dd><code>{scope.userId}</code></dd></div><div><dt>Original requester actor</dt><dd><code>{scope.actorId}</code></dd></div><div><dt>Original requester membership</dt><dd><code>{scope.requesterMembershipId}</code></dd></div><div><dt>External organization</dt><dd><code>{scope.organizationId}</code></dd></div><div><dt>Internal organization</dt><dd><code>{scope.internalOrganizationId}</code></dd></div><div><dt>Environment</dt><dd>{scope.environment}</dd></div><div><dt>Service</dt><dd><code>{scope.apiBase}</code></dd></div>
          <div><dt>Expected member version</dt><dd>{command.expectedVersion}</dd></div><div><dt>Authority epoch</dt><dd>{command.authorityEpoch}</dd></div><div><dt>Mandate version</dt><dd>{command.mandateVersion===null?'null':command.mandateVersion}</dd></div>
          {original.kind==='revoke'?<div><dt>Original reason</dt><dd>{original.command.payload.reason}</dd></div>:<><div><dt>Original roles, in order</dt><dd>{orderedIds(original.command.payload.roles)}</dd></div><div><dt>Original assigned read sites, in order</dt><dd>{orderedIds(original.command.payload.siteIds)}</dd></div><div><dt>Original action sites, in order</dt><dd>{orderedIds(original.command.payload.actionSiteIds)}</dd></div><div><dt>Original expiry</dt><dd>{original.command.payload.expiresAt??'null (no scheduled expiry)'}</dd></div></>}
          <div><dt>Original request key</dt><dd><code>{capsule.key}</code></dd></div><div><dt>Retained at</dt><dd>{capsule.createdAt}</dd></div><div><dt>Schema / digest version</dt><dd>{capsule.schemaVersion} / {capsule.digestSchemaVersion}</dd></div><div><dt>Original command digest</dt><dd><code>{capsule.commandHash}</code></dd></div><div><dt>Capsule integrity digest</dt><dd><code>{capsule.integrityHash}</code></dd></div>
          <div><dt>Current requester name</dt><dd>{observation.requester.displayName}</dd></div>
        </dl>
      </Disclosure></div>
    </Panel>
  </div>;
}
