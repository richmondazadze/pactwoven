import type { NativePaidHistoryResponse } from '../../../../packages/contracts/src/native-paid-history';
import { agentWorkTime } from '../lib/native-agent-work';
import { demoTextPreview } from '../lib/demo-workspace';
import { ReadingRegion } from './readable-content';
import { Icon } from './icon';
import { EquipmentItemList, equipmentDollars } from './ux7-equipment-items';

type Record = Extract<NativePaidHistoryResponse, { kind: 'recorded' }>;

/** Read-only rendering of a separately admitted immutable public result. */
export function NativePaidSavedResult({ record }: { record: Record }) {
  const preview = demoTextPreview(record.advice.summary), selection = record.equipment;
  return <section className="paid-tool-result paid-tool-saved-result" aria-label="Saved result">
    <div className="paid-tool-result-heading"><div className="ux7-result-label"><Icon name="circle-check" size={19}/><h3>Saved result</h3></div><span>Completed <time dateTime={record.completedAt}>{agentWorkTime(record.completedAt)}</time></span></div>
    <h4 className="ux7-result-title">{record.advice.title}</h4><p className="ux7-result-summary">{preview.text}</p>
    {preview.shortened && <details className="ux7-summary-disclosure"><summary>Read full summary<Icon name="chevron-down" size={16}/></summary><ReadingRegion label="Saved summary"><p className="paid-tool-saved-text">{record.advice.summary}</p></ReadingRegion></details>}
    {selection.status === 'feasible' ? <><div className="ux7-estimate-panel"><p className="paid-tool-estimate"><span>Saved sample equipment estimate</span><strong>{equipmentDollars(selection.totalMinor!)}</strong><span>USD catalogue estimate · separate from the computation fee</span></p><div className="ux7-estimate-context"><Icon name="package" size={24}/><p>No equipment has been ordered.</p></div></div>
      <section className="paid-tool-selected-equipment" aria-label="Saved selected equipment"><h4>Selected equipment at completion</h4><EquipmentItemList items={selection.items} saved/><p>Equipment estimate budget: {equipmentDollars(selection.budgetMinor)}. No equipment has been ordered.</p></section></>
      : <div className="ux7-result-empty"><Icon name="package" size={24}/><p>No equipment package matched the saved requirements. This is a completed computation, not a failed payment.</p></div>}
    {record.advice.artifacts.length > 0 && <div className="ux7-result-documents"><h4>Saved documents</h4>{record.advice.artifacts.map(artifact => <details key={artifact.id} className="ux7-result-document"><summary><Icon name="document-signature" size={20}/><span>{artifact.title}</span><Icon name="chevron-down" size={16}/></summary><ReadingRegion label={artifact.title}><div className="paid-tool-saved-text">{artifact.text}</div></ReadingRegion></details>)}</div>}
    <p className="paid-tool-saved-notice">Recorded at completion. Sources and prices have not been checked again; this saved result does not authorize further work or payments.</p>
    <details className="ux7-source-context"><summary>Saved source context<Icon name="chevron-down" size={16}/></summary><ReadingRegion label="Saved source context"><p>Controlled demo catalogue and the operator’s request. Original evidence review window: until <time dateTime={record.evidenceValidUntil}>{agentWorkTime(record.evidenceValidUntil)}</time>.</p>{record.provenance.sources.length > 0 && <ul>{record.provenance.sources.map((source, index) => <li key={`${source.url}:${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{new URL(source.url).hostname} <span>(opens a new tab)</span></a><span> · recorded <time dateTime={source.observedAt}>{agentWorkTime(source.observedAt)}</time></span></li>)}</ul>}</ReadingRegion></details>
  </section>;
}
