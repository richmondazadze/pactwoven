import type {NativePaidHistoryResponse} from '../../../../packages/contracts/src/native-paid-history';
import {agentWorkTime} from '../lib/native-agent-work';
import {demoTextPreview} from '../lib/demo-workspace';

type Record=Extract<NativePaidHistoryResponse,{kind:'recorded'}>;
const dollars=(minor:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(minor/100);

/** Read-only rendering of a separately admitted immutable public result. */
export function NativePaidSavedResult({record}:{record:Record}){
 const preview=demoTextPreview(record.advice.summary),selection=record.equipment;
 return <section className="paid-tool-result paid-tool-saved-result" aria-label="Saved result">
  <div className="paid-tool-result-heading"><h3>Saved result</h3><span>Completed <time dateTime={record.completedAt}>{agentWorkTime(record.completedAt)}</time></span></div>
  <p className="paid-tool-saved-notice">Recorded at completion. Sources and prices have not been checked again; this saved result does not authorize further work or payments.</p>
  <h4>{record.advice.title}</h4><p>{preview.text}</p>
  {preview.shortened&&<details><summary>Read full summary</summary><p className="paid-tool-saved-text">{record.advice.summary}</p></details>}
  {selection.status==='feasible'?<><p className="paid-tool-estimate"><span>Saved sample equipment estimate</span><strong>{dollars(selection.totalMinor!)}</strong><span>USD catalogue estimate · separate from the computation fee</span></p>
   <section className="paid-tool-selected-equipment" aria-label="Saved selected equipment"><h4>Selected equipment at completion</h4><ul>{selection.items.map(item=><li key={item.id}><div><strong>{item.label}</strong><span>{item.seats} {item.seats===1?'seat':'seats'} · {item.microphones} {item.microphones===1?'microphone':'microphones'} · {item.projectors} {item.projectors===1?'projector':'projectors'}</span></div><div><strong>{dollars(item.priceMinor)}</strong><span>Saved sample price</span></div></li>)}</ul><p>Equipment estimate budget: {dollars(selection.budgetMinor)}. No equipment has been ordered.</p></section></>:<p>No equipment package matched the saved requirements. This is a completed computation, not a failed payment.</p>}
  {record.advice.artifacts.map(artifact=><details key={artifact.id}><summary>{artifact.title}</summary><div className="paid-tool-saved-text">{artifact.text}</div></details>)}
  <details><summary>Saved source context</summary><p>Controlled demo catalogue and the operator’s request. Original evidence review window: until <time dateTime={record.evidenceValidUntil}>{agentWorkTime(record.evidenceValidUntil)}</time>.</p>{record.provenance.sources.length>0&&<ul>{record.provenance.sources.map((source,index)=><li key={`${source.url}:${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{new URL(source.url).hostname} <span>(opens a new tab)</span></a><span> · recorded <time dateTime={source.observedAt}>{agentWorkTime(source.observedAt)}</time></span></li>)}</ul>}</details>
 </section>;
}
