'use client';
import {useEffect,useState} from 'react';
import {advanceSandbox,cancelSandboxSupplier,sandboxBalances,startSandbox,type SandboxItem,type SandboxRun} from '../lib/sandbox-reservations';
import {equipmentDollars} from './ux7-equipment-items';
import './sandbox-reservation-run.css';
export function SandboxReservationRun({items,budgetMinor,enabled=true}:{items:SandboxItem[];budgetMinor:number;enabled?:boolean}){
 const [run,setRun]=useState<SandboxRun|null>(null),[error,setError]=useState(false);
 const active=run&&!['complete','blocked'].includes(run.phase);
 useEffect(()=>{if(!active||!enabled)return;const timer=setTimeout(()=>setRun(current=>current?advanceSandbox(current):null),1500);return()=>clearTimeout(timer);},[run,active,enabled]);
 const balances=run?sandboxBalances(run):{available:budgetMinor,reserved:0,spent:0};
 function begin(){if(!enabled)return;try{setRun(startSandbox(items,budgetMinor));setError(false);}catch{setError(true);}}
 return <section className="sandbox-run" aria-label="Sandbox reservation and recovery">
  <header><div><p className="sandbox-label">SANDBOX · BROWSER SIMULATION</p><h3>From paid result to arrangements</h3></div><span className="sandbox-badge">{!run?'Ready':run.phase==='complete'?(run.recovered?'Recovered':'Reserved'):run.phase==='blocked'?'Needs your decision':'Executing'}</span></header>
  <p>Use the equipment package returned by the paid computation to run simulated reservations, budget holds and supplier recovery. The computation receipt above is real Devnet; the arrangements below are not real bookings or token transfers.</p>
  <dl className="sandbox-ledger"><div><dt>Sandbox budget</dt><dd>{equipmentDollars(budgetMinor)}</dd></div><div><dt>Available</dt><dd>{equipmentDollars(balances.available)}</dd></div><div><dt>Reserved</dt><dd>{equipmentDollars(balances.reserved)}</dd></div><div><dt>Simulated spend</dt><dd>{equipmentDollars(balances.spent)}</dd></div></dl>
  {!run?<button type="button" className="button" disabled={!enabled} onClick={begin}>Run sandbox reservations</button>:<>
   <ol className="sandbox-chain" aria-label="Simulation stages">{['Reserve','Confirm','Monitor','Recover'].map((label,index)=><li key={label} data-current={active&&(run.phase==='reserving'?index===0:run.phase==='confirming'?index===1:index===3)}>{label}</li>)}</ol>
   <ul className="sandbox-bookings">{run.reservations.map(r=><li key={r.confirmation}><div><strong>{r.item.label}</strong><small>{r.confirmation} · {r.status}</small></div><strong>{equipmentDollars(r.item.priceMinor)}</strong></li>)}</ul>
   <p className="sandbox-update" role="status" aria-live="polite">{run.events.at(-1)}</p>
   <details><summary>Simulation activity ({run.events.length})</summary><ol>{run.events.map((event,index)=><li key={index}>{event}</li>)}</ol></details>
   {run.phase==='complete'&&!run.recovered&&<button type="button" className="button secondary" disabled={!enabled} onClick={()=>setRun(current=>current?cancelSandboxSupplier(current):null)}>Simulate supplier cancellation</button>}
   {run.phase==='blocked'&&<p>No further reservation is permitted under this sandbox budget.</p>}
  </>}
  {error&&<p role="alert">The package could not be reserved within its recorded budget.</p>}
  <p className="sandbox-footnote">Deterministic fixture suppliers, not live AI booking tools. Recovery uses matching capacity and the cheapest eligible replacement. This simulation runs while this page is open and resets on reload. It never authorizes another payment.</p>
 </section>;
}
