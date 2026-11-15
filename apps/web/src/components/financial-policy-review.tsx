'use client';
import type { FinancialPolicyHttpRecord, FinancialPolicyHttpRecordResponse, FinancialPolicyHttpReceipt,
  FinancialPolicyHttpDocumentView, FinancialPolicyRef } from '@pactwoven/contracts';
import { ButtonLink, Panel, StatusBadge } from './ui';

export const financialPolicyCollectionPath = (responsibilityId: string | null) => responsibilityId === null
  ? '/app/organization/financial-policies' : `/app/responsibilities/${encodeURIComponent(responsibilityId)}/financial-policies`;
export const financialPolicyVersionPath = (responsibilityId: string | null, reference: Pick<FinancialPolicyRef, 'id' | 'version'>) =>
  `${financialPolicyCollectionPath(responsibilityId)}/${encodeURIComponent(reference.id)}/versions/${reference.version}`;
export const financialPolicyLabel = (value: string) => value.toLowerCase().replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
function Reference({ value }: { value: FinancialPolicyRef }) {
  return <span>{value.id} · version {value.version}<code>{value.recordHash}</code></span>;
}
export function FinancialPolicyDocumentText({ document }: { document: FinancialPolicyHttpDocumentView }) {
  return <section className="financial-policy-document" aria-label={`${financialPolicyLabel(document.record.purpose)} version ${document.reference.version}`}>
    <h3>{financialPolicyLabel(document.record.purpose)}</h3><p className="review-note">{document.reference.id} · version {document.reference.version}</p>
    <p className="financial-policy-text">{document.record.text}</p><code>{document.reference.recordHash}</code>
  </section>;
}
function RecordMaterial({ record }: { record: FinancialPolicyHttpRecord }) {
  return <><dl className="financial-policy-facts">
    <div><dt>Record</dt><dd>{record.id} · version {record.version}</dd></div>
    <div><dt>Recorded at</dt><dd><time>{record.createdAt}</time> UTC</dd></div>
    <div><dt>Recorded by</dt><dd>{record.actor.actorId} · membership version {record.actor.membershipVersion}</dd></div>
    <div><dt>Organization epoch</dt><dd>{record.organizationEpoch}</dd></div>
    <div><dt>Environment</dt><dd>{record.environment}</dd></div>
    <div><dt>Previous version</dt><dd>{record.predecessor ? <Reference value={record.predecessor}/> : 'First version'}</dd></div>
  </dl>
    {record.kind === 'document' ? <section className="financial-policy-document"><h3>{financialPolicyLabel(record.purpose)}</h3>
      <p className="financial-policy-text">{record.text}</p><p className="review-note">Content hash</p><code>{record.contentHash}</code></section>
      : record.kind === 'draft' ? <>
        <Panel title="Pinned responsibility and scope"><dl className="financial-policy-facts">
          <div><dt>Responsibility</dt><dd>{record.draft.scope.authority.responsibility.id} · version {record.draft.scope.authority.responsibility.version}</dd></div>
          <div><dt>Site</dt><dd>{record.draft.scope.site.id} · generation {record.draft.scope.site.generation}</dd></div>
          <div><dt>Authority basis</dt><dd>{record.draft.scope.authority.family} · generation {record.draft.scope.authority.generation}<code>{record.draft.scope.authorityHash}</code></dd></div>
          <div><dt>Requester</dt><dd>{record.requester.actorId} · membership version {record.requester.membershipVersion}</dd></div>
          <div><dt>Starts at</dt><dd>{record.draft.startsAt} UTC</dd></div><div><dt>Expires at</dt><dd>{record.draft.expiresAt} UTC</dd></div>
        </dl></Panel>
        <Panel title="Supported terms"><p>Prepare for approval · allocate funds · supplier principal · responsibility earmark.</p>
          <p className="review-note">Supplier, accepted terms, payee, tool, withdrawal and branch are not configured. Communication has no recipients, purposes or kinds; its allowance is 0 base units.</p>
          <dl className="financial-policy-facts"><div><dt>Configuration asset</dt><dd>{record.draft.asset ? <Reference value={{ id: record.draft.asset.key, version: record.draft.asset.version, recordHash: record.draft.asset.recordHash }}/> : 'Unavailable'}</dd></div>
            <div><dt>Account reference</dt><dd>{record.draft.account ? <Reference value={{ id: record.draft.account.key, version: record.draft.account.version, recordHash: record.draft.account.recordHash }}/> : 'Unavailable'}</dd></div>
            <div><dt>Governance reference</dt><dd>{record.draft.governance?.accepted ? <Reference value={record.draft.governance.accepted}/> : 'No accepted configuration pinned'}</dd></div>
            <div><dt>Financial trust</dt><dd>Unavailable</dd></div></dl>
        </Panel>
      </> : <>
        <Panel title="Budget configuration"><dl className="financial-policy-facts">
          <div><dt>Stable budget account</dt><dd><code>{record.bundle.budgetAccountId}</code></dd></div>
          <div><dt>Configuration asset</dt><dd><Reference value={{ id: record.bundle.asset.key, version: record.bundle.asset.version, recordHash: record.bundle.asset.recordHash }}/></dd></div>
          <div><dt>Per operation</dt><dd>{record.bundle.limits.perOperation} base units</dd></div>
          <div><dt>Per responsibility</dt><dd>{record.bundle.limits.perResponsibility} base units</dd></div>
          <div><dt>Per fixed period</dt><dd>{record.bundle.limits.perPeriod} base units</dd></div>
          <div><dt>Fixed UTC period</dt><dd>From {record.bundle.period.startsAt} inclusive to {record.bundle.period.endsAt} exclusive<code>{record.bundle.period.id}</code></dd></div>
          <div><dt>Expected budget control</dt><dd>Generation {record.expectedControl.generation}{record.expectedControl.accepted && <Reference value={record.expectedControl.accepted}/>}</dd></div>
          <div><dt>Proposal expires</dt><dd>{record.expiresAt} UTC</dd></div>
        </dl><p className="review-note">Values are exact base units for the pinned configuration asset. They are policy limits, not balances or available funds.</p></Panel>
        <Panel title="Approval policy"><dl className="financial-policy-facts">
          <div><dt>Threshold</dt><dd>{record.bundle.approval.thresholdBaseUnits} base units</dd></div>
          <div><dt>Requester roles</dt><dd>{record.bundle.approval.requesterRoles.join(', ')}</dd></div>
          <div><dt>Approver roles</dt><dd>{record.bundle.approval.approverRoles.join(', ')}</dd></div>
          <div><dt>Action sites</dt><dd>{record.bundle.approval.actionSiteIds.join(', ')}</dd></div>
          <div><dt>Authentication age ceiling</dt><dd>{record.bundle.approval.maximumAuthenticationAgeSeconds} seconds</dd></div>
          <div><dt>Approval age ceiling</dt><dd>{record.bundle.approval.maximumApprovalAgeSeconds} seconds</dd></div>
          <div><dt>Independence</dt><dd>Required for acceptance</dd></div><div><dt>Proposer</dt><dd>{record.proposer.actorId} · membership version {record.proposer.membershipVersion}</dd></div>
        </dl><p className="review-note">Fixed action: allocate funds. Fixed category: supplier principal.</p></Panel>
      </>}
  </>;
}
export function FinancialPolicyReview({ response }: { response: FinancialPolicyHttpRecordResponse }) {
  const { policy, documents } = response, record = policy.record;
  return <article className="financial-policy-review" aria-label="Exact financial-policy record">
    <div className="financial-policy-status"><StatusBadge>{financialPolicyLabel(policy.projection.state)}</StatusBadge>
      <span>{policy.projection.currentRecord ? 'Current record version at this observation' : 'Historical record version'}</span></div>
    {record.kind === 'governance' && <p className="financial-policy-budget-state">Current accepted budget configuration: {
      policy.budgetConfiguration?.status === 'unavailable' ? 'unavailable at this observation' : policy.budgetConfiguration?.currentBudgetConfiguration ? 'this configuration' : 'a different configuration or none'}.</p>}
    <p className="review-note">This saves configuration. It does not authorize spending or make funds available.</p>
    {policy.projection.blockers.length > 0 && <section aria-label="Configuration blockers"><h3>Configuration blockers</h3><ul>{policy.projection.blockers.map(b => <li key={b}>{financialPolicyLabel(b)}</li>)}</ul></section>}
    <RecordMaterial record={record}/>
    {documents.length > 0 && <Panel title="Complete referenced policy texts">{documents.map(document => <FinancialPolicyDocumentText key={`${document.reference.id}:${document.reference.version}`} document={document}/>)}</Panel>}
    {record.predecessor && record.kind !== 'document' && <ButtonLink href={financialPolicyVersionPath(record.responsibilityId, record.predecessor)} secondary>Read previous version {record.predecessor.version}</ButtonLink>}
  </article>;
}
export function FinancialPolicyReceiptReview({ receipt }: { receipt: FinancialPolicyHttpReceipt }) {
  return <section className="financial-policy-receipt" aria-label="Immutable original result">
    <h3>{financialPolicyLabel(receipt.kind)} recorded</h3><p>Original outcome · {receipt.target.id}, version {receipt.target.version}</p>
    <p className="review-note">This immutable receipt does not describe today's current configuration. No spending authority or funds are created.</p>
    <dl className="financial-policy-facts"><div><dt>Original actor</dt><dd>{receipt.actor.actorId} · membership version {receipt.actor.membershipVersion}</dd></div>
      <div><dt>Operation</dt><dd>{receipt.operationId}</dd></div><div><dt>Record reference</dt><dd><Reference value={receipt.target}/></dd></div></dl>
    {receipt.record.kind === 'document' ? <div className="financial-policy-document"><h4>{financialPolicyLabel(receipt.record.purpose)}</h4><p className="financial-policy-text">{receipt.record.text}</p></div>
      : <ButtonLink href={financialPolicyVersionPath(receipt.responsibilityId, receipt.target)} secondary>Read exact recorded version</ButtonLink>}
  </section>;
}
