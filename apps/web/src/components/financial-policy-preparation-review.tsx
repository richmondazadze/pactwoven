'use client';
import type { FinancialPolicyPreparationResponse, FinancialPolicyRef } from '@pactwoven/contracts';
import { FinancialPolicyDocumentText, financialPolicyLabel } from './financial-policy-review';
import { VerificationDetails } from './verification-details';
import { financialRecordName } from '../lib/financial-presentation';
import { Panel, StatusBadge } from './ui';

function Reference({ value }: { value: FinancialPolicyRef }) { return <span>{value.id} · version {value.version}<code>{value.recordHash}</code></span>; }
/** Preparation records retain their own current/historical meaning; no synthetic read envelope. */
export function FinancialPolicyPreparationReview({ response }: { response: FinancialPolicyPreparationResponse }) {
  const { decision, target, material } = response;
  return <article className="financial-authoring-preparation" aria-label="Checked preparation">
    <div className="financial-policy-status"><StatusBadge tone={decision.state === 'reviewable' ? 'blue' : 'neutral'}>{financialPolicyLabel(decision.state)}</StatusBadge>
      <span>{decision.action === 'save_document' ? 'Policy text preparation' : 'Draft preparation'}</span></div>
    <p className="review-note">This metadata check creates no policy record. A reviewable check still requires exact local review and a separate save.</p>
    {decision.reasons.length > 0 && <section aria-label="Action blockers"><h3>Action cannot proceed</h3><ul>{decision.reasons.map(reason => <li key={reason}>{financialPolicyLabel(reason)}</li>)}</ul></section>}
    <dl className="financial-policy-facts"><div><dt>Selected predecessor</dt><dd>{response.selection.previous ? `Version ${response.selection.previous.version}` : 'New record — no predecessor selected'}</dd></div>
      <div><dt>Observed target</dt><dd>{financialPolicyLabel(target.state)}</dd></div>
      <div><dt>Check expires</dt><dd>{response.observation.expiresAt} UTC</dd></div></dl>
    <VerificationDetails label="Preparation references"><dl>
      <div><dt>Selected target</dt><dd>{response.selection.targetId}</dd></div>
      {response.selection.previous && <div><dt>Selected predecessor</dt><dd><Reference value={response.selection.previous}/></dd></div>}
      {target.latestReference && <div><dt>Observed latest reference</dt><dd><Reference value={target.latestReference}/></dd></div>}
    </dl></VerificationDetails>
    {target.state === 'changed' && <p className="financial-authoring-error">The target changed. No latest version has been substituted. Select and read that exact version separately before a new check.</p>}
    {target.state === 'unavailable' && <p>No target information is available for this check.</p>}
    {target.record && <Panel title="Exact selected previous record">
      <p>{financialRecordName(target.record.record)} · version {target.record.record.version} · {financialPolicyLabel(target.record.projection.state)}</p><VerificationDetails label="Previous record reference"><dl><div><dt>Record</dt><dd><Reference value={target.record.reference}/></dd></div></dl></VerificationDetails>
      {target.record.record.kind === 'document' ? <p className="financial-policy-text">{target.record.record.text}</p>
        : target.record.record.kind === 'draft' ? <><dl className="financial-policy-facts">
          <div><dt>Historical starts at</dt><dd>{target.record.record.draft.startsAt} UTC</dd></div>
          <div><dt>Historical expires at</dt><dd>{target.record.record.draft.expiresAt} UTC</dd></div>
          <div><dt>Historical authority</dt><dd>{financialPolicyLabel(target.record.record.draft.scope.authority.family)}</dd></div></dl><VerificationDetails label="Historical scope verification"><dl className="financial-policy-facts"><div><dt>Original requester</dt><dd>{target.record.record.requester.actorId} · membership version {target.record.record.requester.membershipVersion}</dd></div><div><dt>Authority generation</dt><dd>{target.record.record.draft.scope.authority.generation}<code>{target.record.record.draft.scope.authorityHash}</code></dd></div>
          <div><dt>Historical responsibility</dt><dd>{target.record.record.draft.scope.authority.responsibility.id} · version {target.record.record.draft.scope.authority.responsibility.version}<code>{target.record.record.draft.scope.authority.responsibility.hash}</code></dd></div>
          <div><dt>Historical site</dt><dd>{target.record.record.draft.scope.site.id} · generation {target.record.record.draft.scope.site.generation}<code>{target.record.record.draft.scope.site.recordHash}</code></dd></div>
          <div><dt>Historical asset</dt><dd>{target.record.record.draft.asset ? <Reference value={{ id: target.record.record.draft.asset.key, version: target.record.record.draft.asset.version, recordHash: target.record.record.draft.asset.recordHash }}/> : 'Absent'}</dd></div>
          <div><dt>Historical account</dt><dd>{target.record.record.draft.account ? <Reference value={{ id: target.record.record.draft.account.key, version: target.record.record.draft.account.version, recordHash: target.record.record.draft.account.recordHash }}/> : 'Absent'}</dd></div>
          <div><dt>Historical governance</dt><dd>{target.record.record.draft.governance ? <>Generation {target.record.record.draft.governance.generation}<code>{target.record.record.draft.governance.budgetAccountId}</code>{target.record.record.draft.governance.accepted && <Reference value={target.record.record.draft.governance.accepted}/>}</> : 'Absent'}</dd></div>
        </dl></VerificationDetails><p className="review-note">Historical terms: prepare for approval; allocate funds; supplier principal; responsibility earmark. Supplier, accepted terms, payee, tool, withdrawal and branch are absent. Communication has no recipients, purposes or kinds and an allowance of 0 base units. Financial trust is absent. The new incomplete draft never drops inherited optional material to make a check pass.</p></> : null}
    </Panel>}
    {target.historicalDocuments.length > 0 && <Panel title="Historical document texts from the selected draft">
      {target.historicalDocuments.map(document => <FinancialPolicyDocumentText key={`${document.reference.id}:${document.reference.version}`} document={document}/>)}</Panel>}
    {(material.action === 'save_document' || material.action === 'save_draft') && material.draftScope && <Panel title="Current checked responsibility basis">
      <dl className="financial-policy-facts"><div><dt>Responsibility</dt><dd>{material.draftScope.authority.responsibility.id} · version {material.draftScope.authority.responsibility.version}</dd></div>
        <div><dt>Site</dt><dd>{material.draftScope.site.id}</dd></div>
        <div><dt>Authority</dt><dd>{financialPolicyLabel(material.draftScope.authority.family)}</dd></div></dl>
      <VerificationDetails label="Checked scope verification"><dl>
        <div><dt>Responsibility hash</dt><dd>{material.draftScope.authority.responsibility.hash}</dd></div>
        <div><dt>Site generation</dt><dd>{material.draftScope.site.generation}</dd></div><div><dt>Site hash</dt><dd>{material.draftScope.site.recordHash}</dd></div>
        <div><dt>Authority generation</dt><dd>{material.draftScope.authority.generation}</dd></div><div><dt>Authority hash</dt><dd>{material.draftScope.authorityHash}</dd></div>
      </dl></VerificationDetails>
    </Panel>}
    {material.action === 'save_draft' && material.document && <Panel title="Selected current policy text"><FinancialPolicyDocumentText document={material.document}/></Panel>}
    {response.configurationWarnings.length > 0 && <section aria-label="Configuration warnings"><h3>Configuration warnings</h3><ul>{response.configurationWarnings.map(warning => <li key={warning}>{financialPolicyLabel(warning)}</li>)}</ul></section>}
    <p className="review-note">Configuration only. No spending authority, available funds or financial trust is created.</p>
  </article>;
}
