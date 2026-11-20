'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import type { NativeWorkConversation, NativeWorkInstructionReceipt } from '../../../../packages/contracts/src/native-work-conversation';
import { RequestError } from '../lib/api';
import { agentWorkError, agentWorkReadDenied, agentWorkRequest, agentWorkTime, canStartAgentWork, previousAgentWorkConnection, readAgentWorkAttempt } from '../lib/native-agent-work';
import { clearWorkInstructionAttempt, createWorkInstructionAttempt, previousWorkInstructionConnection, readWorkInstructionAttempt,
  recoverWorkInstruction, sendWorkInstruction, storeWorkInstructionAttempt, workConversationSchema, workInstructionError, workInstructionRejected, type WorkInstructionAttempt } from '../lib/native-work-conversation';
import { canObserveAgentWork, useAgentWorkBinding } from './native-agent-work-hooks';
import { ActionLabel, Alert } from './ui';
import { VoiceCommandComposer } from './voice-command-composer';
import { appendVoiceTranscript } from '../lib/voice-command';

const unavailableLabels={pause_required:'Pause work before updating its instructions.',finished:'This work is finished. Its saved instructions remain available.',cancelled:'This work was cancelled. Its saved instructions remain available.',authority_unavailable:'Current work permission is unavailable. Refresh your access before continuing.',instruction_limit:'This work has reached its instruction update limit.',execution_limit:'This work has reached its execution limit. Its saved instructions remain available.'} as const;

export function NativeWorkConversationContent({ conversation }: { conversation: NativeWorkConversation }) {
  return <div className="agent-work-conversation"><article className="agent-work-message"><div className="agent-work-message-byline"><h3>Your original request</h3></div><p className="agent-work-text">{conversation.originalPrompt}</p></article>
    {conversation.entries.map(entry=><article className="agent-work-message" key={entry.sequence}><div className="agent-work-message-byline"><h3>Your instruction update</h3><time dateTime={entry.recordedAt}>{agentWorkTime(entry.recordedAt)}</time></div><p className="agent-work-text">{entry.text}</p><p className="agent-work-caption">{entry.state==='applied'?'Included in the team’s current instructions.':'Saved. Waiting for the team to apply this update.'}</p></article>)}
  </div>;
}

export function NativeWorkConversation({ siteId, work, observing, controlPending, onLockChange, onUpdated, onAccessDenied }: {
  siteId: string; work: NativeAgentWork; observing: boolean; controlPending: boolean;
  onLockChange: (locked: boolean)=>void; onUpdated: (version: number)=>Promise<void>;
  onAccessDenied: (error: unknown)=>void;
}) {
  const binding=useAgentWorkBinding(siteId),client=useQueryClient(),id=work.id,key=['native-work-conversation',binding.identity,id] as const;
  const current=()=>{if(!canObserveAgentWork())throw new RequestError('OBSERVATION_PAUSED','Return to this tab and reconnect.');return binding.current();};
  const query=useQuery({queryKey:key,enabled:observing,queryFn:({signal})=>agentWorkRequest(`/v1/agent-work/${encodeURIComponent(id)}/conversation?siteId=${encodeURIComponent(siteId)}`,
    workConversationSchema(binding.scope,id),binding.scope,binding.getToken,current,{signal:AbortSignal.any([signal,binding.controller.current.signal,AbortSignal.timeout(15000)])}),
    retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
  const conversation=agentWorkReadDenied(query.error)?undefined:query.data;
  const [text,setText]=useState(''),[review,setReview]=useState<WorkInstructionAttempt|null>(null),[attempt,setAttempt]=useState<WorkInstructionAttempt|null>(null);
  const textRef=useRef(text);textRef.current=text;
  const pending=useRef<WorkInstructionAttempt|null>(null),sending=useRef(false),heading=useRef<HTMLHeadingElement>(null),conversationHeading=useRef<HTMLHeadingElement>(null),editor=useRef<HTMLTextAreaElement>(null),editButton=useRef<HTMLButtonElement>(null);
  const [ready,setReady]=useState(false),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false),[retry,setRetry]=useState(false);
  const [error,setError]=useState<unknown>(null),[notice,setNotice]=useState('');
  const previousConversation=useRef<NativeWorkConversation|undefined>(undefined),[announcement,setAnnouncement]=useState('');
  const requestedVersion=useRef(0);
  const writable=canStartAgentWork(binding.session,siteId),denied=agentWorkReadDenied(error)||agentWorkReadDenied(query.error);
  const fresh=conversation?.controlVersion===work.controlVersion;
  const editable=ready&&observing&&!query.error&&!query.isFetching&&!denied&&!controlPending&&!blocked&&writable&&work.state==='paused'&&fresh&&conversation?.canUpdate;
  useEffect(()=>{try{
    if(previousWorkInstructionConnection(sessionStorage,binding.scope,id))throw new RequestError('PREVIOUS_CONNECTION_PENDING','Check the original connection.');
    const saved=readWorkInstructionAttempt(sessionStorage,binding.scope,id);if(saved){pending.current=saved;setAttempt(saved);setText(saved.input.text);}
  }catch(failure){setError(failure);setBlocked(true);}setReady(true);},[]);
  useEffect(()=>{onLockChange(!ready||busy||blocked||Boolean(attempt)||Boolean(review));},[ready,busy,blocked,attempt,review,onLockChange]);
  useEffect(()=>{if(denied)onAccessDenied(error??query.error);},[denied,error,query.error,onAccessDenied]);
  useEffect(()=>{if(work.state!=='paused')setNotice(value=>value.startsWith('Instructions saved.')?'Your updated instructions are saved.':value);},[work.state,notice]);
  useEffect(()=>{if(!observing){void client.cancelQueries({queryKey:key,exact:true});return;}void client.invalidateQueries({queryKey:key,exact:true});},[observing,work.controlVersion,work.updatedAt]);
  useEffect(()=>()=>{void client.cancelQueries({queryKey:key,exact:true});client.removeQueries({queryKey:key,exact:true});},[client,binding.identity,id]);
  useEffect(()=>{if(review)heading.current?.focus();},[review]);
  useEffect(()=>{if(editing&&!review&&!attempt)editor.current?.focus();},[editing,review,attempt]);
  useEffect(()=>{if(conversation&&conversation.controlVersion>work.controlVersion&&conversation.controlVersion>requestedVersion.current){
    requestedVersion.current=conversation.controlVersion;void onUpdated(conversation.controlVersion);
  }},[conversation?.controlVersion,work.controlVersion]);
  useEffect(()=>{
    if(!observing||!conversation||query.error)return;
    const before=previousConversation.current;
    if(before&&conversation.instructionVersion<before.instructionVersion)return;
    if(before){const changes=conversation.entries.filter(entry=>!before.entries.some(prior=>prior.sequence===entry.sequence&&prior.state===entry.state));
      if(changes.length)setAnnouncement(changes.some(entry=>entry.state==='applied')?'The team is using your saved instruction updates.':'Your instruction update is saved.');}
    previousConversation.current=conversation;
  },[conversation,observing,query.error]);
  useEffect(()=>{if(review&&conversation&&(!fresh||!conversation.canUpdate||conversation.instructionVersion!==review.input.expectedInstructionVersion||work.state!=='paused')){
    setReview(null);setNotice('This work changed. Review its latest instructions before saving your update.');
  }},[conversation,work.state,fresh,review]);
  const signal=()=>AbortSignal.any([binding.controller.current.signal,AbortSignal.timeout(25000)]);
  function requireWritable(){current();if(!canStartAgentWork(binding.session,siteId))throw new RequestError('FORBIDDEN','Current work permission is required.',403);
    if(previousAgentWorkConnection(sessionStorage,binding.scope,id)||readAgentWorkAttempt(sessionStorage,binding.scope,id))throw new RequestError('CONTROL_PENDING','Check the original work action first.');}
  function clear(original:WorkInstructionAttempt){clearWorkInstructionAttempt(sessionStorage,original);pending.current=null;setAttempt(null);}
  async function accepted(receipt:NativeWorkInstructionReceipt,original:WorkInstructionAttempt){binding.current();clear(original);setReview(null);setEditing(false);setText('');setRetry(false);setError(null);
    setNotice('Instructions saved. Work remains paused. Resume when you are ready.');await onUpdated(receipt.controlVersion);await query.refetch();conversationHeading.current?.focus();}
  function prepare(event:FormEvent){event.preventDefault();if(!editable||busy||pending.current||!text.trim())return;
    try{requireWritable();const value=createWorkInstructionAttempt(binding.scope,id,{text,expectedInstructionVersion:conversation!.instructionVersion,expectedControlVersion:conversation!.controlVersion});onLockChange(true);setReview(value);setError(null);setNotice('');}
    catch(failure){setError(failure);}}
  async function transmit(original?:WorkInstructionAttempt){if(sending.current||!observing||blocked||!ready||!writable||controlPending||denied)return;
    if(original?original!==pending.current||!retry:!editable||!review||Boolean(pending.current))return;
    const value=original??review!;let dispatched=false;sending.current=true;setBusy(true);setError(null);setRetry(false);setNotice('');
    try{requireWritable();storeWorkInstructionAttempt(sessionStorage,value);pending.current=value;setAttempt(value);
      const receipt=await sendWorkInstruction(value,binding.getToken,current,{signal:signal(),beforeDispatch:()=>{dispatched=true;}});await accepted(receipt,value);
    }catch(failure){if(!binding.live.current)return;
      const rejected=workInstructionRejected(failure);
      if(!dispatched&&!original||rejected){try{clear(value);}catch{setBlocked(true);}}
      setReview(null);setError(failure);if(rejected){await onUpdated(work.controlVersion);void query.refetch();}
    }finally{sending.current=false;if(binding.live.current)setBusy(false);}}
  async function recover(){const original=pending.current;if(!original||sending.current||!observing||blocked)return;
    sending.current=true;setBusy(true);setRetry(false);setError(null);setNotice('');
    try{const recovered=await recoverWorkInstruction(original,binding.getToken,current,signal());
      if(recovered.operation)await accepted(recovered.operation,original);else{setRetry(true);setNotice('No saved update was found yet. You can retry the exact original update.');}}
    catch(failure){if(binding.live.current)setError(failure);}finally{sending.current=false;if(binding.live.current)setBusy(false);}}
  const failure=error??query.error;
  function addVoiceUpdate(value:string){requireWritable();if(!editable||busy||sending.current||pending.current)throw new RequestError('SCOPE_CHANGED','This instruction draft is no longer editable.');
    const next=appendVoiceTranscript(textRef.current,value,4000);textRef.current=next;setText(next);editor.current?.focus();}
  return <section className="agent-work-panel agent-work-conversation-panel" aria-label="Team conversation"><div className="agent-work-panel-heading"><div><h2 ref={conversationHeading} tabIndex={-1}>Team conversation</h2><p className="agent-work-caption">Your request and saved instructions. The team’s recorded plan and advice appear alongside.</p></div></div>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {notice&&<p className="agent-work-announcement" role="status">{notice}</p>}
    {failure!=null&&<Alert title="Instructions need checking" tone="red"><p>{workInstructionError(failure)??(failure instanceof RequestError&&failure.code==='CONTROL_PENDING'?'Check the original work action before updating instructions.':agentWorkError(failure))}</p><button className="button secondary" disabled={!observing||query.isFetching||busy} onClick={()=>{setError(null);void query.refetch();}}>Refresh instructions</button></Alert>}
    {conversation&&!denied?<NativeWorkConversationContent conversation={conversation}/>:!query.error?<p>{observing?'Loading the saved conversation…':'The saved conversation will load when this tab reconnects.'}</p>:null}
    {attempt&&<Alert title="Check the original instruction update" tone="blue"><p>Your exact update is retained in this tab. Check what was saved before resuming or sending another update.</p><details className="agent-work-artifact"><summary>Original update</summary><p className="agent-work-text">{attempt.input.text}</p></details><div className="actions"><button className="button secondary" disabled={!observing||busy||blocked} onClick={()=>void recover()}><ActionLabel label={busy?'Checking…':'Check saved update'} reserve={['Checking…','Check saved update']}/></button>{retry&&writable&&work.state==='paused'&&<button className="button" disabled={!observing||busy||blocked||controlPending||denied} onClick={()=>void transmit(attempt)}>Retry original update</button>}</div></Alert>}
    {!attempt&&!denied&&conversation&&<div className="agent-work-instruction-editor">
      {review?<div className="agent-work-instruction-review"><h3 ref={heading} tabIndex={-1}>Review instruction update</h3><p className="agent-work-text">{review.input.text}</p><p>This adds to your original request. Work stays paused until you resume. The team will recheck its plan and advice against the updated instructions.</p><p className="agent-work-caption">The same notes, permitted sources and advice-only limits apply. Permission still ends {agentWorkTime(work.expiresAt)}.</p><div className="actions"><button className="button" disabled={!editable||busy} onClick={()=>void transmit()}><ActionLabel label={busy?'Saving…':'Save instructions'} reserve={['Saving…','Save instructions']}/></button><button className="button secondary" disabled={busy} onClick={()=>setReview(null)}>Edit update</button></div></div>
      :editing?<form className="agent-work-form" onSubmit={prepare}><label>Instruction update<textarea ref={editor} aria-label="Instruction update" rows={5} maxLength={4000} required value={text} disabled={!editable||busy} onChange={event=>setText(event.target.value)} placeholder="Add a constraint or clarify the outcome you want."/></label><VoiceCommandComposer siteId={siteId} disabled={!editable||busy||text.length>=3998} maxLength={Math.max(1,4000-text.length-(text?2:0))} onUseTranscript={addVoiceUpdate} label="Add transcript to update"/><p className="agent-work-caption">Add instructions to this task. Its original permission and deadline stay the same.</p><div className="actions"><button className="button" disabled={!editable||busy||!text.trim()}>Review update</button><button className="button secondary" type="button" disabled={busy} onClick={()=>{setEditing(false);conversationHeading.current?.focus();}}>Keep current instructions</button></div></form>
      :<><p>{work.state==='paused'?'You can clarify the request before continuing.': ['queued','working','waiting'].includes(work.state)?'Pause work to add a constraint or clarify the request.':'The saved conversation remains available with this work.'}</p>{work.state==='paused'&&<button className="button secondary" ref={editButton} disabled={!editable||busy} onClick={()=>{setEditing(true);setNotice('');}}>Update instructions</button>}
        {work.state==='paused'&&!conversation.canUpdate&&<p className="agent-work-caption">{conversation.updateUnavailableReason?unavailableLabels[conversation.updateUnavailableReason]:'Instruction updates are not available for this work.'}</p>}</>}
    </div>}
  </section>;
}
