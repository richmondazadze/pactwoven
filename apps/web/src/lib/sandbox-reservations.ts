/** Browser-only deterministic supplier simulator. Never transfers tokens or calls a supplier. */
export type SandboxItem = { id:string; label:string; seats:number; microphones:number; projectors:number; priceMinor:number };
export type SandboxReservation = { item:SandboxItem; confirmation:string; status:'held'|'confirmed'|'cancelled' };
export type SandboxRun = { budget:number; phase:'reserving'|'confirming'|'complete'|'refunding'|'replacing'|'blocked'; reservations:SandboxReservation[]; events:string[]; cancelledId:string|null; recovered:boolean };
export function sandboxBalances(run:SandboxRun){
 const reserved=run.reservations.filter(r=>r.status==='held').reduce((n,r)=>n+r.item.priceMinor,0);
 const spent=run.reservations.filter(r=>r.status==='confirmed').reduce((n,r)=>n+r.item.priceMinor,0);
 return {reserved,spent,available:run.budget-reserved-spent};
}
export function startSandbox(items:SandboxItem[],budget:number):SandboxRun{
 if(!Number.isSafeInteger(budget)||budget<0||items.length===0||items.length>12||new Set(items.map(i=>i.id)).size!==items.length||items.some(i=>!Number.isSafeInteger(i.priceMinor)||i.priceMinor<0)||items.reduce((n,i)=>n+i.priceMinor,0)>budget)throw Error('The recorded package must fit the sandbox budget.');
 return {budget,phase:'reserving',reservations:items.map((item,index)=>({item:{...item},confirmation:`SANDBOX-${String(index+1).padStart(3,'0')}`,status:'held'})),events:['Reservation worker placed simulated holds for the purchased equipment selection.'],cancelledId:null,recovered:false};
}
export function cancelSandboxSupplier(run:SandboxRun):SandboxRun{
 if(run.phase!=='complete'||run.recovered||run.cancelledId)return run;
 const first=run.reservations.find(r=>r.status==='confirmed');if(!first)return run;
 return {...run,phase:'refunding',cancelledId:first.item.id,events:[...run.events,`Injected sandbox cancellation: ${first.item.label}. Refund pending; no released funds may be reused yet.`]};
}
export function advanceSandbox(run:SandboxRun):SandboxRun{
 if(run.phase==='reserving')return {...run,phase:'confirming',events:[...run.events,'All simulated holds accepted. Confirmation worker is completing reservations.']};
 if(run.phase==='confirming')return {...run,phase:'complete',reservations:run.reservations.map(r=>r.status==='held'?{...r,status:'confirmed'}:r),events:[...run.events,run.recovered?'Replacement confirmed within the original sandbox budget.':'Sandbox reservations confirmed. Held amounts moved to simulated spend.']};
 if(run.phase==='refunding')return {...run,phase:'replacing',reservations:run.reservations.map(r=>r.item.id===run.cancelledId?{...r,status:'cancelled'}:r),events:[...run.events,'Simulated full refund confirmed. Recovery worker can now use the released budget.']};
 if(run.phase!=='replacing')return run;
 const cancelled=run.reservations.find(r=>r.item.id===run.cancelledId);if(!cancelled)return {...run,phase:'blocked',events:[...run.events,'Recovery stopped: original reservation missing.']};
 // Two explicit fixture suppliers with identical capacity, not live quotes or an LLM decision.
 const alternatives=[{...cancelled.item,id:`backup-a-${cancelled.item.id}`,label:`Sandbox backup A · ${cancelled.item.label}`,priceMinor:cancelled.item.priceMinor+2500},{...cancelled.item,id:`backup-b-${cancelled.item.id}`,label:`Sandbox backup B · ${cancelled.item.label}`,priceMinor:cancelled.item.priceMinor+5000}];
 const available=sandboxBalances(run).available;
 const replacement=alternatives.filter(i=>i.priceMinor<=available).sort((a,b)=>a.priceMinor-b.priceMinor)[0];
 if(!replacement)return {...run,phase:'blocked',events:[...run.events,'Both fixture alternatives exceed the remaining budget. Recovery stopped without overspending; operator decision required.']};
 return {...run,phase:'confirming',recovered:true,reservations:[...run.reservations,{item:replacement,confirmation:'SANDBOX-REPLACEMENT-001',status:'held'}],events:[...run.events,'Recovery worker compared two fixture suppliers and held the cheapest matching replacement within the remaining budget.']};
}
