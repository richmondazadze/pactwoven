'use client';
import type { FinancialPolicyHttpContext, FinancialPolicyPreparationResponse } from '@pactwoven/contracts';
import { VerificationDetails } from './verification-details';
import { accessRoleLabels } from '../lib/presentation';
import { ActionLabel, Disclosure, Panel } from './ui';

/** Only local authored text survives expiry here. The opaque comparison digest never enters the view. */
export function FinancialPolicyNewTextIntentReview({ text, targetId, context, preparation, acknowledged,
  canAcknowledge, disabled, saving, onAcknowledge, onSave }: {
  text: string; targetId: string; context: FinancialPolicyHttpContext | null; preparation: FinancialPolicyPreparationResponse | null;
  acknowledged: boolean; canAcknowledge: boolean; disabled: boolean; saving: boolean;
  onAcknowledge: () => void; onSave: () => void;
}) {
  const current = context !== null && preparation !== null;
  return <Panel title="Save reviewed text when ready">
    <p>Review your exact text and the checked preparation below, then acknowledge them. The separate save action refreshes current access and preparation and stops if the checked material changed.</p>
    <div className="actions">
      <button type="button" className="button secondary" disabled={disabled || acknowledged || !canAcknowledge}
        aria-describedby="financial-new-text-intent-status" onClick={onAcknowledge}>
        <ActionLabel label="Acknowledge reviewed text & checks" reserve={['Acknowledge reviewed text & checks']}/>
      </button>
      <button type="button" className="button" disabled={disabled || !acknowledged}
        aria-describedby="financial-new-text-intent-status" onClick={onSave}>
        <ActionLabel label={saving ? 'Refreshing checks & saving…' : 'Refresh checks & save reviewed text'}
          reserve={['Refreshing checks & saving…', 'Refresh checks & save reviewed text']}/>
      </button>
    </div>
    <p id="financial-new-text-intent-status" className="review-note">{acknowledged
      ? current ? 'Review acknowledged. Saving still requires fresh checks. Nothing has been saved.'
        : 'Review acknowledged. The earlier checks expired. Your text remains unsaved; the save action must check current access again.'
      : saving ? 'The separate save action is checking current material. It will send at most one save if every check passes.'
        : 'Acknowledgment requires current checked material and is separate from saving. An edit removes it.'}</p>
    {acknowledged && <section className="financial-authoring-local-review" aria-label="Acknowledged unsent local text">
      <h3>Your acknowledged text</h3><VerificationDetails label="Unsent record reference"><dl><div><dt>Chosen record</dt><dd>{targetId}</dd></div></dl></VerificationDetails>
      <p className="financial-policy-text">{text}</p>
    </section>}
    {context && preparation && <section aria-label="Current checked access for this text">
      <h3>Current checked access</h3>
      <p>Current role: {context.scope.roles.map(role => accessRoleLabels[role]).join(', ')}. Read access covers {context.scope.siteIds.length} site{context.scope.siteIds.length === 1 ? '' : 's'}; action access covers {context.scope.actionSiteIds.length}.</p>
      <Disclosure title="Exact access references">
      <dl className="financial-policy-facts">
        <div><dt>Environment</dt><dd>{context.scope.environment}</dd></div>
        <div><dt>Organization</dt><dd>{context.scope.organizationId} · epoch {context.scope.organizationEpoch}</dd></div>
        <div><dt>Actor</dt><dd>{context.scope.actor.actorId} · membership version {context.scope.actor.membershipVersion}</dd></div>
        <div><dt>Roles</dt><dd>{context.scope.roles.join(', ')}</dd></div>
        <div><dt>Read sites</dt><dd>{context.scope.siteIds.join(', ') || 'None'}</dd></div>
        <div><dt>Action sites</dt><dd>{context.scope.actionSiteIds.join(', ') || 'None'}</dd></div>
        <div><dt>Configuration visibility</dt><dd>{context.configurationVisibility === 'full' ? 'Full' : 'References only'}</dd></div>
      </dl>
      </Disclosure>
      <p className="review-note">The complete checked context must still match at save, including any configuration facts beyond this summary.</p>
    </section>}
    <p className="review-note">Policy configuration only. No spending authority, available funds or financial trust is created.</p>
  </Panel>;
}
