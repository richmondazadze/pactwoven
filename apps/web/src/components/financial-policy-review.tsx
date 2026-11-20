'use client';
import type { FinancialPolicyHttpRecord, FinancialPolicyHttpRecordResponse, FinancialPolicyHttpReceipt,
  FinancialPolicyHttpDocumentView, FinancialPolicyRef, FinancialPolicyHttpContext } from '@pactwoven/contracts';
import { ButtonLink, Panel, StatusBadge } from './ui';
import { VerificationDetails } from './verification-details';
import { accessRoleLabels, workspaceTypeLabel } from '../lib/presentation';
import { financialAmount, financialRecordName } from '../lib/financial-presentation';

export const financialPolicyCollectionPath = (responsibilityId: string | null) => responsibilityId === null
  ? '/app/organization/financial-policies' : `/app/responsibilities/${encodeURIComponent(responsibilityId)}/financial-policies`;
export const financialPolicyVersionPath = (responsibilityId: string | null, reference: Pick<FinancialPolicyRef, 'id' | 'version'>) =>
  `${financialPolicyCollectionPath(responsibilityId)}/${encodeURIComponent(reference.id)}/versions/${reference.version}`;
export const financialPolicyLabel = (value: string) => value.toLowerCase().replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
function Reference({ value }: { value: FinancialPolicyRef }) {
  return <span>{value.id} · version {value.version}<code>{value.recordHash}</code></span>;
}
function DocumentRevisionLink({ record, reference }: { record: Extract<FinancialPolicyHttpRecord, { kind: 'document' }>; reference: FinancialPolicyRef }) {
  if (record.responsibilityId === null || record.purpose !== 'financial_mandate') return null;
  return <ButtonLink href={`${financialPolicyVersionPath(record.responsibilityId, reference)}/revise?kind=document`} secondary>Check policy text revision</ButtonLink>;
}
export function FinancialPolicyDocumentText({ document }: { document: FinancialPolicyHttpDocumentView }) {
  return <section className="financial-policy-document" aria-label={`${financialPolicyLabel(document.record.purpose)} version ${document.reference.version}`}>
    <h3>{financialPolicyLabel(document.record.purpose)}</h3><p className="review-note">Version {document.reference.version}</p>
    <p className="financial-policy-text">{document.record.text}</p><VerificationDetails label="Policy text reference"><dl><div><dt>Exact document</dt><dd><Reference value={document.reference}/></dd></div></dl></VerificationDetails>
    <DocumentRevisionLink record={document.record} reference={document.reference}/>
  </section>;
}
function RecordMaterial({ record, context }: { record: FinancialPolicyHttpRecord; context?: FinancialPolicyHttpContext | null }) {
  const asset = context?.scope.organizationId === record.organizationId && context.scope.environment === record.environment ? context.asset : null;
  const amount = (value: string) => record.kind === 'governance' ? financialAmount(value, record.bundle.asset, asset) : `${value} base units`;
  const amountKnown = record.kind === 'governance' && amount('0').endsWith('USDC (devnet)');
  return <><dl className="financial-policy-facts">
    <div><dt>Record</dt><dd>{financialRecordName(record)} · version {record.version}</dd></div>
    <div><dt>Recorded at</dt><dd><time>{record.createdAt}</time> UTC</dd></div>
    <div><dt>Workspace type</dt><dd>{workspaceTypeLabel[record.environment]}</dd></div>
    <div><dt>Previous version</dt><dd>{record.predecessor ? `Version ${record.predecessor.version}` : 'First version'}</dd></div>
  </dl>
    <VerificationDetails label="Record verification"><dl>
      <div><dt>Record reference</dt><dd>{record.id}</dd></div>
      <div><dt>Recorded by</dt><dd>{record.actor.actorId} · membership version {record.actor.membershipVersion}</dd></div>
      <div><dt>Organization epoch</dt><dd>{record.organizationEpoch}</dd></div>
      <div><dt>Operation</dt><dd>{record.operationId}</dd></div>
      {record.predecessor && <div><dt>Previous record</dt><dd><Reference value={record.predecessor}/></dd></div>}
    </dl></VerificationDetails>
    {record.kind === 'document' ? <section className="financial-policy-document"><h3>{financialPolicyLabel(record.purpose)}</h3>
      <p className="financial-policy-text">{record.text}</p><VerificationDetails label="Policy content verification"><dl><div><dt>Content hash</dt><dd>{record.contentHash}</dd></div></dl></VerificationDetails></section>
      : record.kind === 'draft' ? <>
        <Panel title="Pinned responsibility and scope"><dl className="financial-policy-facts">
          <div><dt>Responsibility</dt><dd>{record.draft.scope.authority.responsibility.id} · version {record.draft.scope.authority.responsibility.version}</dd></div>
          <div><dt>Site</dt><dd>{record.draft.scope.site.id}</dd></div>
          <div><dt>Authority basis</dt><dd>{financialPolicyLabel(record.draft.scope.authority.family)}</dd></div>
          <div><dt>Starts at</dt><dd>{record.draft.startsAt} UTC</dd></div><div><dt>Expires at</dt><dd>{record.draft.expiresAt} UTC</dd></div>
        </dl><VerificationDetails label="Scope verification"><dl>
          <div><dt>Site generation</dt><dd>{record.draft.scope.site.generation}</dd></div>
          <div><dt>Authority generation</dt><dd>{record.draft.scope.authority.generation}</dd></div>
          <div><dt>Authority hash</dt><dd>{record.draft.scope.authorityHash}</dd></div>
          <div><dt>Requester</dt><dd>{record.requester.actorId} · membership version {record.requester.membershipVersion}</dd></div>
        </dl></VerificationDetails></Panel>
        <Panel title="Supported terms"><p>Prepare for approval · allocate funds · supplier principal · responsibility earmark.</p>
          <p className="review-note">Supplier, accepted terms, payee, tool, withdrawal and branch are not configured. Communication has no recipients, purposes or kinds; its allowance is 0 base units.</p>
          <dl className="financial-policy-facts"><div><dt>Configuration asset</dt><dd>{record.draft.asset ? <Reference value={{ id: record.draft.asset.key, version: record.draft.asset.version, recordHash: record.draft.asset.recordHash }}/> : 'Unavailable'}</dd></div>
            <div><dt>Account reference</dt><dd>{record.draft.account ? <Reference value={{ id: record.draft.account.key, version: record.draft.account.version, recordHash: record.draft.account.recordHash }}/> : 'Unavailable'}</dd></div>
            <div><dt>Governance reference</dt><dd>{record.draft.governance?.accepted ? <Reference value={record.draft.governance.accepted}/> : 'No accepted configuration pinned'}</dd></div>
            <div><dt>Financial trust</dt><dd>Unavailable</dd></div></dl>
        </Panel>
      </> : <>
        <Panel title="Budget configuration"><dl className="financial-policy-facts">
          <div><dt>Configuration asset</dt><dd>{amountKnown ? 'USDC on Solana devnet' : 'Asset details unavailable for this version'}</dd></div>
          <div><dt>Per operation</dt><dd>{amount(record.bundle.limits.perOperation)}</dd></div>
          <div><dt>Per responsibility</dt><dd>{amount(record.bundle.limits.perResponsibility)}</dd></div>
          <div><dt>Per fixed period</dt><dd>{amount(record.bundle.limits.perPeriod)}</dd></div>
          <div><dt>Fixed UTC period</dt><dd>From {record.bundle.period.startsAt} inclusive to {record.bundle.period.endsAt} exclusive</dd></div>
          <div><dt>Proposal expires</dt><dd>{record.expiresAt} UTC</dd></div>
        </dl><p className="review-note">{amountKnown ? 'Amounts use the verified asset precision without rounding.' : 'Asset precision is unavailable for this exact version, so amounts remain in exact base units.'} These are policy limits, not balances or available funds.</p>
        <VerificationDetails label="Budget verification"><dl>
          <div><dt>Stable budget account</dt><dd>{record.bundle.budgetAccountId}</dd></div>
          <div><dt>Configuration asset</dt><dd><Reference value={{ id: record.bundle.asset.key, version: record.bundle.asset.version, recordHash: record.bundle.asset.recordHash }}/></dd></div>
          <div><dt>Fixed period reference</dt><dd>{record.bundle.period.id}</dd></div>
          <div><dt>Expected budget control</dt><dd>Generation {record.expectedControl.generation}{record.expectedControl.accepted && <Reference value={record.expectedControl.accepted}/>}</dd></div>
          <div><dt>Per operation (base units)</dt><dd>{record.bundle.limits.perOperation}</dd></div>
          <div><dt>Per responsibility (base units)</dt><dd>{record.bundle.limits.perResponsibility}</dd></div>
          <div><dt>Per fixed period (base units)</dt><dd>{record.bundle.limits.perPeriod}</dd></div>
          <div><dt>Approval threshold (base units)</dt><dd>{record.bundle.approval.thresholdBaseUnits}</dd></div>
          <div><dt>Proposer membership version</dt><dd>{record.proposer.membershipVersion}</dd></div>
        </dl></VerificationDetails></Panel>
        <Panel title="Approval policy"><dl className="financial-policy-facts">
          <div><dt>Threshold</dt><dd>{amount(record.bundle.approval.thresholdBaseUnits)}</dd></div>
          <div><dt>Requester roles</dt><dd>{record.bundle.approval.requesterRoles.map(role => accessRoleLabels[role]).join(', ')}</dd></div>
          <div><dt>Approver roles</dt><dd>{record.bundle.approval.approverRoles.map(role => accessRoleLabels[role]).join(', ')}</dd></div>
          <div><dt>Action sites</dt><dd>{record.bundle.approval.actionSiteIds.join(', ')}</dd></div>
          <div><dt>Authentication age ceiling</dt><dd>{record.bundle.approval.maximumAuthenticationAgeSeconds} seconds</dd></div>
          <div><dt>Approval age ceiling</dt><dd>{record.bundle.approval.maximumApprovalAgeSeconds} seconds</dd></div>
          <div><dt>Independence</dt><dd>Required for acceptance</dd></div><div><dt>Proposer</dt><dd>{record.proposer.actorId}</dd></div>
        </dl><p className="review-note">Fixed action: allocate funds. Fixed category: supplier principal.</p></Panel>
      </>}
  </>;
}
export function FinancialPolicyReview({ response, context }: { response: FinancialPolicyHttpRecordResponse; context?: FinancialPolicyHttpContext | null }) {
  const { policy, documents } = response, record = policy.record;
  return <article className="financial-policy-review" aria-label="Exact financial-policy record">
    <div className="financial-policy-status"><StatusBadge>{financialPolicyLabel(policy.projection.state)}</StatusBadge>
      <span>{policy.projection.currentRecord ? 'Current record version at this observation' : 'Historical record version'}</span></div>
    {record.kind === 'governance' && <p className="financial-policy-budget-state">Current accepted budget configuration: {
      policy.budgetConfiguration?.status === 'unavailable' ? 'unavailable at this observation' : policy.budgetConfiguration?.currentBudgetConfiguration ? 'this configuration' : 'a different configuration or none'}.</p>}
    <p className="review-note">This saves configuration. It does not authorize spending or make funds available.</p>
    {policy.projection.blockers.length > 0 && <section aria-label="Configuration blockers"><h3>Configuration blockers</h3><ul>{policy.projection.blockers.map(b => <li key={b}>{financialPolicyLabel(b)}</li>)}</ul></section>}
    <RecordMaterial record={record} context={context ?? null}/>
    {record.kind === 'document' && <DocumentRevisionLink record={record} reference={policy.reference}/>}
    {documents.length > 0 && <Panel title="Complete referenced policy texts">{documents.map(document => <FinancialPolicyDocumentText key={`${document.reference.id}:${document.reference.version}`} document={document}/>)}</Panel>}
    {record.predecessor && record.kind !== 'document' && <ButtonLink href={financialPolicyVersionPath(record.responsibilityId, record.predecessor)} secondary>Read previous version {record.predecessor.version}</ButtonLink>}
  </article>;
}
export function FinancialPolicyReceiptReview({ receipt }: { receipt: FinancialPolicyHttpReceipt }) {
  return <section className="financial-policy-receipt" aria-label="Immutable original result">
    <h3>{financialPolicyLabel(receipt.kind)} recorded</h3><p>Original outcome · {financialRecordName(receipt.record)}, version {receipt.target.version}</p>
    <p className="review-note">This immutable receipt does not describe today's current configuration. No spending authority or funds are created.</p>
    <VerificationDetails label="Original receipt verification"><dl className="financial-policy-facts"><div><dt>Original actor</dt><dd>{receipt.actor.actorId} · membership version {receipt.actor.membershipVersion}</dd></div>
      <div><dt>Operation</dt><dd>{receipt.operationId}</dd></div><div><dt>Record reference</dt><dd><Reference value={receipt.target}/></dd></div></dl></VerificationDetails>
    {receipt.record.kind === 'document' ? <div className="financial-policy-document"><h4>{financialPolicyLabel(receipt.record.purpose)}</h4><p className="financial-policy-text">{receipt.record.text}</p>
      <DocumentRevisionLink record={receipt.record} reference={receipt.target}/></div>
      : <ButtonLink href={financialPolicyVersionPath(receipt.responsibilityId, receipt.target)} secondary>Read exact recorded version</ButtonLink>}
  </section>;
}
