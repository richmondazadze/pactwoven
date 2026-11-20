'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NativeWorkIntentPrepareSchema, type NativeWorkIntentReview, type NativeWorkIntentOperation } from '../../../../packages/contracts/src/native-work-intent';
import { RequestError } from '../lib/api';
import { getNativeApiBase } from '../lib/config';
import { memoryDetailSchema, memoryRequest } from '../lib/native-memory';
import { agentWorkIdentity, agentWorkPath, agentWorkTime, agentWorkError, agentWorkRejected, canStartAgentWork, readableAgentWorkSites,
  createAgentWorkIntent, confirmAgentWorkIntent, storeAgentWorkAttempt, clearAgentWorkAttempt, readAgentWorkAttempt, previousAgentWorkConnection,
  sendAgentWorkIntent, recoverAgentWorkIntent, type AgentWorkIntentAttempt } from '../lib/native-agent-work';
import { useWorkspace } from './workspace-provider';
import { useMemoryList } from './native-memory-hooks';
import { useAgentWorkBinding } from './native-agent-work-hooks';
import { ActionLabel, Alert, LoadingState, PageHeading, StatusBadge } from './ui';
import { VoiceCommandComposer } from './voice-command-composer';
import { appendVoiceTranscript } from '../lib/voice-command';
import { clearPaidWorkIntent, confirmPaidWorkIntent, createPaidWorkIntent, previousPaidWorkConnection, readPaidWorkIntent, recoverPaidWorkIntent, retainPaidWorkReview, samePaidWorkPolicy, sendPaidWorkIntent, storePaidWorkIntent, type PaidWorkIntentAttempt, type PaidWorkPolicy } from '../lib/native-paid-work-intent';
import { usePaidWorkOptions } from './native-paid-work-intent-hooks';
import { EquipmentDemoOptIn, EquipmentDemoCeilingReview } from './equipment-demo-opt-in';
import './native-agent-work.css';

type Selection={noteId:string;expected:string;title:string};
type WorkAttempt = AgentWorkIntentAttempt | PaidWorkIntentAttempt;
export type FreshAgentWorkDraft={title:string;prompt:string;equipment:boolean};
const equipmentCeiling = (policy: PaidWorkPolicy) => ({ maximumComputationBaseUnits: policy.maximumComputationBaseUnits, maximumFeeLamports: policy.maximumFeeLamports, authorization: policy.authorization });
export function AgentWorkReview({review}:{review:NativeWorkIntentReview}) {
  return <section className="agent-work-panel agent-work-review" aria-label="Reviewed work"><div className="agent-work-panel-heading"><h2>{review.body.title}</h2><StatusBadge tone="blue">Ready for your review</StatusBadge></div>
    <dl className="agent-work-facts"><div><dt>Site</dt><dd>{review.body.siteName}</dd></div><div><dt>Review before</dt><dd><time dateTime={review.confirmBy}>{agentWorkTime(review.confirmBy)}</time></dd></div><div><dt>Work permission ends</dt><dd><time dateTime={review.expiresAt}>{agentWorkTime(review.expiresAt)}</time></dd></div></dl>
    <h3>Your instructions</h3><p className="agent-work-text">{review.body.prompt}</p><h3>Allowed work</h3><ul className="agent-work-capabilities">{review.body.allowedWork.map(label=><li key={label}>{label}</li>)}</ul>
    <p>Work can continue after you close this tab or sign out, until the permission above ends. This is advice only: it cannot send messages, place orders, make payments or change accounts.</p>
    <h3>Selected notes</h3>{review.body.selectedNotes.length===0?<p>No saved notes will be used.</p>:<div className="agent-work-selected-notes">{review.body.selectedNotes.map(note=><article key={note.noteId}><h4>{note.title}</h4><p className="agent-work-text">{note.text}</p><p><strong>Useful for:</strong> {note.purpose}</p><p className="agent-work-caption">{note.sourceLabel}<br/>Supplied by {note.suppliedBy} · Review by <time dateTime={note.reviewBy}>{agentWorkTime(note.reviewBy)}</time></p></article>)}</div>}
  </section>;
}
export function NativeAgentWorkComposer({siteId,onOpenWork,initialDraft}:{siteId:string;onOpenWork?:(id:string)=>void;initialDraft?:FreshAgentWorkDraft}) {
  const {session}=useWorkspace();
  if(!getNativeApiBase())return <Alert title="Work is not connected" tone="blue"><p>Background advisory work is not connected yet.</p></Alert>;
  if(!readableAgentWorkSites(session).some(site=>site.id===siteId))return <Alert title="Choose an accessible site" tone="red"><p>Open Work and choose a site you can access.</p></Alert>;
  return <Composer key={agentWorkIdentity(session,siteId)} siteId={siteId} onOpenWork={onOpenWork} initialDraft={initialDraft}/>;
}
function Composer({siteId,onOpenWork,initialDraft}:{siteId:string;onOpenWork?:((id:string)=>void)|undefined;initialDraft?:FreshAgentWorkDraft|undefined}) {
  const binding=useAgentWorkBinding(siteId),notes=useMemoryList(siteId,'available'),paidOptions=usePaidWorkOptions(siteId);
  const [title,setTitle]=useState(initialDraft?.title??''),[prompt,setPrompt]=useState(initialDraft?.prompt??''),[selected,setSelected]=useState<Selection[]>([]),[selecting,setSelecting]=useState<string|null>(null);
  const promptInput=useRef<HTMLTextAreaElement>(null),promptRef=useRef(prompt);promptRef.current=prompt;
  const [attempt,setAttempt]=useState<WorkAttempt|null>(null),pending=useRef<WorkAttempt|null>(null);
  const [paidSelection,setPaidSelection]=useState<PaidWorkPolicy|null>(null);
  const [review,setReview]=useState<NativeWorkIntentReview|null>(null),[operation,setOperation]=useState<NativeWorkIntentOperation|null>(null);
  const [withheld,setWithheld]=useState(false),[consent,setConsent]=useState(false),[expired,setExpired]=useState(false),[retry,setRetry]=useState(false);
  const [ready,setReady]=useState(false),[blocked,setBlocked]=useState(false),[busy,setBusy]=useState(false),sending=useRef(false);
  const [error,setError]=useState<unknown>(null),heading=useRef<HTMLHeadingElement>(null);
  const writable=canStartAgentWork(binding.session,siteId);
  const [draftEquipmentPending,setDraftEquipmentPending]=useState(Boolean(initialDraft?.equipment));
  useEffect(()=>{try{if(previousAgentWorkConnection(sessionStorage,binding.scope)||previousPaidWorkConnection(sessionStorage,binding.scope))throw new RequestError('PREVIOUS_CONNECTION_PENDING','Check the original connection.');
    const ordinary=readAgentWorkAttempt(sessionStorage,binding.scope),paid=readPaidWorkIntent(sessionStorage,binding.scope);if(ordinary&&paid)throw new RequestError('LOCAL_RECOVERY_INVALID','Two original work requests need checking.');
    const saved=paid??ordinary;if(saved?.kind==='intent'||saved?.kind==='paid-intent'){pending.current=saved;setAttempt(saved);setTitle(saved.input.title);setPrompt(saved.input.prompt);setSelected(saved.input.selections.map(note=>({...note,title:'Selected note'})));if(saved.kind==='paid-intent')setPaidSelection(saved.paidPolicy);}
  }catch(failure){setError(failure);setBlocked(true);}setReady(true);},[]);
  useEffect(()=>{if(!ready||!draftEquipmentPending)return;if(pending.current){setDraftEquipmentPending(false);return;}if(blocked||!writable||!paidOptions.data?.enabled)return;setPaidSelection(paidOptions.data.paidPolicy);setDraftEquipmentPending(false);},[ready,draftEquipmentPending,blocked,writable,paidOptions.data]);
  useEffect(()=>{setConsent(false);if(!review){setExpired(false);return;}heading.current?.focus();const check=()=>setExpired(Date.now()>=Date.parse(review.confirmBy));check();
    const timer=setTimeout(check,Math.max(0,Date.parse(review.confirmBy)-Date.now()+5));document.addEventListener('visibilitychange',check);
    return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',check);};},[review?.id]);
  const current=()=>{const scope=binding.current();if(!canStartAgentWork(binding.session,siteId))throw new RequestError('FORBIDDEN','Current work permission is required.',403);return scope;};
  const signal=(ms=25000)=>AbortSignal.any([binding.controller.current.signal,AbortSignal.timeout(ms)]);
  function retain(value:WorkAttempt){if(value.kind==='paid-intent')storePaidWorkIntent(sessionStorage,value);else storeAgentWorkAttempt(sessionStorage,value);pending.current=value;setAttempt(value);}
  function clear(value:WorkAttempt){if(value.kind==='paid-intent')clearPaidWorkIntent(sessionStorage,value);else clearAgentWorkAttempt(sessionStorage,value);pending.current=null;setAttempt(null);}
  function accept(value:NativeWorkIntentOperation,original:WorkAttempt,unavailable=false){binding.current();setOperation(value);setWithheld(unavailable);setReview(null);setConsent(false);setRetry(false);setError(null);try{clear(original);}catch(failure){setError(failure);setBlocked(true);}}
  async function transmit(original?:WorkAttempt,confirm=false) {
    if(sending.current||!ready||blocked||!writable||operation)return;
    if(original&&(!retry||original!==pending.current))return;
    if(!original&&confirm&&(!review||!pending.current||pending.current.confirmation||!consent||Date.now()>=Date.parse(review.confirmBy)))return;
    if(!original&&!confirm&&pending.current)return;
    if(!original&&!confirm&&draftEquipmentPending)return;
    let value:WorkAttempt|null=original??null,dispatched=false;
    sending.current=true;setBusy(true);setError(null);setRetry(false);
    try{current();if(!value){if(confirm)value=pending.current!.kind==='paid-intent'?confirmPaidWorkIntent(pending.current! as PaidWorkIntentAttempt,review!):confirmAgentWorkIntent(pending.current! as AgentWorkIntentAttempt,review!);
      else {const input=NativeWorkIntentPrepareSchema.parse({siteId,title,prompt,selections:selected.map(({noteId,expected})=>({noteId,expected})),continuesAfterSignOut:true});
        if(paidSelection){if(!paidOptions.data?.enabled||!samePaidWorkPolicy(paidSelection,paidOptions.data.paidPolicy))throw new RequestError('REVIEW_CHANGED','Review the current equipment demo limits.',409);value=createPaidWorkIntent(binding.scope,input,paidSelection);}else value=createAgentWorkIntent(binding.scope,input);}}
      retain(value);const options={signal:signal(),beforeDispatch:()=>{if(confirm&&review&&Date.now()>=Date.parse(review.confirmBy))throw new RequestError('REVIEW_EXPIRED','This review expired.',409);dispatched=true;return undefined;}};
      let result:Awaited<ReturnType<typeof sendAgentWorkIntent>>;
      if(value.kind==='paid-intent'){const wrapped=await sendPaidWorkIntent(value,binding.getToken,current,options);result=wrapped.work;if('review'in result&&!result.operation){value=retainPaidWorkReview(value,result.review,wrapped.paidPolicy);retain(value);}}
      else result=await sendAgentWorkIntent(value,binding.getToken,current,options);
      if('review' in result){if(result.operation)accept(result.operation,value);else{setReview(result.review);setSelected(result.review.body.selectedNotes.map((note,index)=>({...value!.input.selections[index]!,title:note.title})));}}
      else accept(result,value);
    }catch(failure){if(!binding.live.current)return;setReview(null);setConsent(false);if(value&&(!dispatched&&!original||agentWorkRejected(failure,Boolean(original)))){try{clear(value);}catch{setBlocked(true);}}setError(failure);}
    finally{sending.current=false;if(binding.live.current)setBusy(false);}
  }
  async function recover(){let original=pending.current;if(!original||sending.current||blocked)return;sending.current=true;setBusy(true);setRetry(false);setReview(null);setConsent(false);setError(null);
    try{let result:Awaited<ReturnType<typeof recoverAgentWorkIntent>>;if(original.kind==='paid-intent'){const wrapped=await recoverPaidWorkIntent(original,binding.getToken,binding.current,signal(15000));result=wrapped.work;if(result.review&&!result.operation&&wrapped.paidPolicy){original=retainPaidWorkReview(original,result.review,wrapped.paidPolicy);retain(original);}}else result=await recoverAgentWorkIntent(original,binding.getToken,binding.current,signal(15000));if(result.operation)accept(result.operation,original,result.reviewUnavailable);
      else{setReview(result.review);setRetry(Boolean(original.confirmation)||result.review===null);}}
    catch(failure){if(binding.live.current)setError(failure);}finally{sending.current=false;if(binding.live.current)setBusy(false);}}
  function revise(){if(!attempt||attempt.confirmation||busy||!review)return;try{binding.current();clear(attempt);setReview(null);setConsent(false);setError(null);setRetry(false);}catch(failure){setError(failure);setBlocked(true);}}
  async function select(noteId:string,checked:boolean){if(busy||attempt||!writable)return;if(!checked){setSelected(values=>values.filter(note=>note.noteId!==noteId));return;}if(selected.length>=32)return;
    sending.current=true;setBusy(true);setSelecting(noteId);setError(null);try{const result=await memoryRequest(`/v1/memory/${encodeURIComponent(noteId)}?siteId=${encodeURIComponent(siteId)}`,memoryDetailSchema(binding.scope,noteId),binding.scope,binding.getToken,binding.current,{signal:signal(15000)});
      if(result.note.status!=='available'||!result.note.editToken||!result.note.reviewBy||Date.parse(result.note.reviewBy)<=Date.now())throw new RequestError('REVIEW_CHANGED','This note needs review.',409);
      setSelected(values=>values.some(note=>note.noteId===noteId)?values:[...values,{noteId,expected:result.note.editToken!,title:result.note.title}]);
    }catch(failure){if(binding.live.current)setError(failure);}finally{sending.current=false;if(binding.live.current){setBusy(false);setSelecting(null);}}}
  function submit(event:FormEvent){event.preventDefault();void transmit();}
  function addVoiceInstructions(text:string){current();if(!ready||sending.current||blocked||pending.current||!writable)throw new RequestError('SCOPE_CHANGED','This draft is no longer editable.');
    const next=appendVoiceTranscript(promptRef.current,text,12000);promptRef.current=next;setPrompt(next);promptInput.current?.focus();}
  const noteItems=notes.data?.pages.flatMap(page=>page.items)??[];
  return <div className="agent-work-page"><PageHeading title={initialDraft?'Prepare a fresh request':'Give the agent team a task'} description={binding.session.sites.find(site=>site.id===siteId)?.name??'Your site'}/>
    {initialDraft&&<p className="agent-work-caption">Only the original title, instructions and equipment planning choice are copied. Select any notes again and review the current permission. Nothing starts or pays automatically; the earlier work remains above.</p>}
    {error!==null&&<Alert title={attempt?'Check the original request':'Work needs attention'} tone="red"><p>{agentWorkError(error)}</p></Alert>}
    {operation?<section className="agent-work-panel agent-work-saved" aria-label="Saved work"><StatusBadge tone="green">Work saved</StatusBadge><h2>{operation.title}</h2><p>Your original work request was recovered or saved. Permission ends <time dateTime={operation.expiresAt}>{agentWorkTime(operation.expiresAt)}</time>.</p>{withheld&&<p>The original note review is no longer available. Your work request is still saved; starting it again is not required.</p>}{onOpenWork?<button className="button" onClick={()=>onOpenWork(operation.rootTaskId)}>Open work</button>:<Link className="button" href={agentWorkPath(siteId,operation.rootTaskId)}>Open work</Link>}</section>:<>
      {attempt&&(!review||attempt.confirmation)&&<Alert title="Keep the original request" tone="blue"><p>Check what was saved before doing anything else. This uses the same original request and will not start another task.</p><div className="actions"><button className="button secondary" disabled={busy||blocked} onClick={()=>void recover()}><ActionLabel pending={busy} label={busy?'Checking…':'Check saved request'} reserve={['Checking…','Check saved request']}/></button>{retry&&writable&&<button className="button" disabled={busy||blocked} onClick={()=>void transmit(attempt)}>Retry original {attempt.confirmation?'confirmation':'review'}</button>}</div></Alert>}
      {review?<><h2 className="agent-work-review-focus" tabIndex={-1} ref={heading}>Review before starting</h2><AgentWorkReview review={review}/>{attempt?.kind==='paid-intent'&&<EquipmentDemoCeilingReview selection={equipmentCeiling(attempt.paidPolicy)}/>}{expired&&<Alert title="This review window has ended" tone="amber"><p>{attempt?.confirmation?'Check the original confirmation to recover any saved work.':'Prepare a fresh review before authorizing this work.'}</p></Alert>}
        {!attempt?.confirmation&&<section className="agent-work-panel agent-work-consent"><label className="agent-work-check"><input type="checkbox" checked={consent} disabled={busy||expired||!writable} onChange={event=>setConsent(event.target.checked)}/><span>I authorize this advice-only work to continue after I close this tab or sign out, within the reviewed permission.</span></label><div className="actions"><button className="button" disabled={!consent||expired||busy||blocked||!writable} onClick={()=>void transmit(undefined,true)}><ActionLabel pending={busy} label={busy?'Starting…':'Start reviewed work'} reserve={['Starting…','Start reviewed work']}/></button><button className="button secondary" disabled={busy||blocked} onClick={revise}>{expired?'Prepare a new review':'Edit request'}</button></div></section>}</>:
      <div className="agent-work-compose-grid"><section className="agent-work-panel"><form className="agent-work-form" onSubmit={submit}><label>Work title<input aria-label="Work title" required maxLength={180} value={title} disabled={!ready||busy||blocked||Boolean(attempt)||!writable} onChange={event=>setTitle(event.target.value)} placeholder="Compare office chair options"/></label><label>What would you like help with?<textarea ref={promptInput} aria-label="What would you like help with?" required maxLength={12000} rows={7} value={prompt} disabled={!ready||busy||blocked||Boolean(attempt)||!writable} onChange={event=>setPrompt(event.target.value)} placeholder="Explain the outcome you need, constraints and any public links to review."/></label>
        <VoiceCommandComposer siteId={siteId} disabled={!ready||busy||blocked||Boolean(attempt)||!writable||prompt.length>=11998} maxLength={Math.max(1,12000-prompt.length-(prompt?2:0))} onUseTranscript={addVoiceInstructions} label="Add transcript to draft"/>
        {draftEquipmentPending&&!attempt&&<Alert title="Checking current equipment limits" tone="blue"><p>{paidOptions.isLoading?'Loading the current equipment planning option before review.':'The equipment planning option is unavailable. Refresh it or explicitly continue with advice only.'}</p><div className="actions"><button type="button" className="button secondary" disabled={busy||paidOptions.isFetching} onClick={()=>void paidOptions.refetch()}>Refresh equipment option</button><button type="button" className="button secondary" disabled={busy} onClick={()=>setDraftEquipmentPending(false)}>Continue with advice only</button></div></Alert>}
        {paidOptions.data?.enabled?<EquipmentDemoOptIn ceiling={equipmentCeiling(paidOptions.data.paidPolicy)} selection={paidSelection?equipmentCeiling(paidSelection):null} disabled={!ready||busy||blocked||Boolean(attempt)||!writable} onSelectionChange={selection=>setPaidSelection(selection&&paidOptions.data?.enabled?{...paidOptions.data.paidPolicy,...selection}:null)}/>:paidSelection&&!attempt&&<Alert title="Equipment option needs refreshing" tone="amber"><p>The selected equipment planning limits are not currently available. Refresh the option or remove it before reviewing this work.</p><div className="actions"><button type="button" className="button secondary" disabled={busy} onClick={()=>void paidOptions.refetch()}>Refresh equipment option</button><button type="button" className="button secondary" disabled={busy} onClick={()=>setPaidSelection(null)}>Continue with advice only</button></div></Alert>}
        <fieldset disabled={!ready||busy||blocked||Boolean(attempt)||!writable}><legend>Saved notes to include <span>(optional)</span></legend><p>Choose up to 32 notes. You will review the exact text before work starts.</p>{notes.error?<p>Notes could not be loaded. <button type="button" className="button secondary" onClick={()=>void notes.refresh()}>Refresh notes</button></p>:notes.isLoading?<LoadingState variant="compact" label="Loading available notes"/>:noteItems.length===0?<p>No available notes at this site. You can continue without notes.</p>:noteItems.map(note=><label className="agent-work-check" key={note.id}><input type="checkbox" checked={selecting===note.id||selected.some(value=>value.noteId===note.id)} disabled={selected.length>=32&&!selected.some(value=>value.noteId===note.id)} onChange={event=>void select(note.id,event.target.checked)}/><span>{note.title}<small>{note.suppliedBy} · Review by {note.reviewBy?agentWorkTime(note.reviewBy):'Needs review'}</small></span></label>)}{notes.hasNextPage&&<button className="button secondary" type="button" disabled={notes.isFetchingNextPage} onClick={()=>void notes.fetchNextPage()}>More notes</button>}<p className="agent-work-caption">{selected.length===0?'No saved notes selected.':`${selected.length} saved ${selected.length===1?'note':'notes'} selected.`}</p></fieldset>
        <button className="button" type="submit" disabled={!ready||busy||blocked||Boolean(attempt)||!writable||draftEquipmentPending||!title.trim()||!prompt.trim()}><ActionLabel pending={busy} label={busy?'Preparing…':'Review work'} reserve={['Preparing…','Review work']}/></button></form></section><aside className="agent-work-panel agent-work-about"><h2>Work that can continue</h2><p>The team can review public sources, use the notes you select and prepare advice.</p><p>You approve the actual scope in the next step. Once authorized, it can continue when you close this tab or sign out.</p><p>{paidSelection?'This initial advice permission excludes payments. Any suggested computation needs a separate exact quote approval before spending.':'No messages, orders, payments or account changes are permitted.'}</p>{!writable&&<p>Your current access allows reading work. Starting work requires site permission.</p>}</aside></div>}
    </>}
  </div>;
}
