'use client';
import { useId } from 'react';
import { EquipmentDemoCeilingSchema, sameEquipmentDemoCeiling, type EquipmentDemoCeiling } from '../lib/equipment-demo-selection';
import { paidToolAmount } from '../lib/native-paid-tool-presentation';
import './equipment-demo-opt-in.css';

type Props = { ceiling: EquipmentDemoCeiling; selection: EquipmentDemoCeiling | null; onSelectionChange: (selection: EquipmentDemoCeiling | null) => void; disabled?: boolean };
export function EquipmentDemoOptIn({ ceiling, selection, onSelectionChange, disabled = false }: Props) {
  const id = useId(), description = useId(), parsed = EquipmentDemoCeilingSchema.safeParse(ceiling);
  if (!parsed.success) return <p role="status">The equipment demo limits could not be confirmed. Continue with advice or refresh the available options.</p>;
  const selected = sameEquipmentDemoCeiling(selection, parsed.data);
  return <section className="equipment-demo-opt-in" aria-label="Optional equipment demo">
    <div className="equipment-demo-option"><input id={id} type="checkbox" checked={selected} disabled={disabled} aria-describedby={description} onChange={event => onSelectionChange(event.currentTarget.checked ? { ...parsed.data } : null)}/><div><label htmlFor={id}>Include an equipment comparison</label><p id={description}>Let the team suggest an equipment package from the demo catalogue and prepare a computation quote.</p></div><span>Optional</span></div>
    <div className="equipment-demo-limits"><CeilingValues ceiling={parsed.data}/></div>
    <p className="equipment-demo-approval-note">You will review the exact service, recipient and price before any payment. Selecting this option does not authorize spending.</p>
    {selection && !selected && <p className="equipment-demo-changed" role="status">The proposed limits changed. Select this option again to use the limits shown above.</p>}
  </section>;
}
function CeilingValues({ ceiling }: { ceiling: EquipmentDemoCeiling }) {
  return <dl><div><dt>Computation fee limit</dt><dd>{paidToolAmount({ baseUnits: ceiling.maximumComputationBaseUnits, decimals: 6, symbol: 'devnet USDC' })}</dd></div><div><dt>Network fee limit</dt><dd>{paidToolAmount({ baseUnits: ceiling.maximumFeeLamports, decimals: 9, symbol: 'test SOL' })}</dd></div></dl>;
}

/** Read-only initial work review: deliberately has no purchase-approval callback. */
export function EquipmentDemoCeilingReview({ selection }: { selection: EquipmentDemoCeiling }) {
  const parsed = EquipmentDemoCeilingSchema.safeParse(selection);
  if (!parsed.success) return <p role="alert">The equipment demo selection needs reviewing again.</p>;
  return <section className="equipment-demo-ceiling-review" aria-label="Equipment demo planning permission"><header><h3>Equipment demo included</h3><span>Planning permission</span></header><p>The team can compare the controlled catalogue and suggest one computation within these limits.</p><CeilingValues ceiling={parsed.data}/><p className="equipment-demo-approval-note">These limits stay with this work. A separate, exact quote review is required before funds can be reserved or spent.</p><p className="equipment-demo-footnote">Equipment prices are sample USD estimates. The service fee uses devnet USDC, and the network fee uses test SOL. No equipment is ordered and no supplier is paid.</p></section>;
}
