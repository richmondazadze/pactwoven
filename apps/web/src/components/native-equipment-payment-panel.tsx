'use client';
import { useEffect,useRef,useState } from 'react';
import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import type { NativePaidQuoteView } from '../../../../packages/contracts/src/native-paid-quote';
import { RequestError } from '../lib/api';
import { agentWorkError,agentWorkIdentity,agentWorkTime } from '../lib/native-agent-work';
import { approvePaidQuoteAttempt,clearPaidQuoteAttempt,createPaidQuoteAttempt,readPaidQuoteAttempt,recoverPaidQuoteApproval,requestPaidQuoteReview,retainPaidQuoteReview,sendPaidQuoteApproval,storePaidQuoteAttempt,type PaidQuoteAttempt } from '../lib/native-paid-quote';
import { paidToolAmount } from '../lib/native-paid-tool-presentation';
import { canObserveAgentWork,useAgentWorkBinding } from './native-agent-work-hooks';
import { useNativeEquipmentDiscovery } from './native-paid-quote-hooks';
import { useNativePaidToolControl,useNativePaidToolRead } from './native-paid-tool-hooks';
import { useNativePaidEquipment } from './native-paid-equipment-hooks';
import {useNativePaidHistory} from './native-paid-history-hooks';
import { RecordedEquipmentContributors,useNativePaidContributors } from './native-paid-contributors';
import { NativePaidToolReceipt } from './native-paid-tool-receipt';
import { useWorkspace } from './workspace-provider';
import { ActionLabel, Alert, LoadingState } from './ui';
import './native-equipment-payment-panel.css';
import { EquipmentPaymentDialog,EquipmentPaymentFacts,EquipmentPaymentProgress,claimPaymentDialogPrompt,paymentDialogIdentity } from './equipment-payment-dialog';

export type EquipmentTaskStage='quote_ready'|'quote_expired'|'equipment_unavailable'|'approval_unconfirmed'|'purchase_recorded';
export const equipmentTaskStageCopy={
  quote_ready:{title:'Payment review ready',description:'Review the computation quote below. Payment needs your exact approval.'},
  quote_expired:{title:'Payment review expired',description:'The quote review window has ended. Check the equipment status below before continuing.'},
  equipment_unavailable:{title:'Equipment review needs attention',description:'The saved quote or its supporting evidence is unavailable. Check the equipment section below before continuing.'},
  approval_unconfirmed:{title:'Check original payment approval',description:'Your original approval is retained. Check it below before taking another payment action.'},
  purchase_recorded:{title:'Payment and delivery',description:'Follow the original purchase receipt below for its recorded payment and delivery status.'},
} as const;
type Props={siteId:string;rootTaskId:string;workState:NativeAgentWork['state'];workControlVersion:number;evidenceAvailable:boolean;revisionKey:string;observing:boolean;canAuthorize:boolean;onStageChange?:(revisionKey:string,stage:EquipmentTaskStage|null)=>void;onPrepareFreshRequest?:(()=>void)|undefined};
export function NativeEquipmentPaymentPanel(props:Props){const{session}=useWorkspace();return <EquipmentPanel key={`${agentWorkIdentity(session,props.siteId)}:${props.rootTaskId}`} {...props}/>;}
const usd=(minor:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(minor/100);
export function EquipmentQuoteSummary({quote}:{quote:NativePaidQuoteView}){
  return <section className="equipment-quote-summary" aria-label="Equipment computation quote"><header><div><p className="equipment-quote-eyebrow">Suggested computation · Solana devnet</p><h2>{quote.title}</h2></div><strong>{paidToolAmount(quote.amount)}</strong></header>
    <dl className="equipment-quote-requirements"><div><dt>Seats</dt><dd>{quote.request.seats}</dd></div><div><dt>Microphones</dt><dd>{quote.request.microphones}</dd></div><div><dt>Projectors</dt><dd>{quote.request.projectors}</dd></div><div><dt>Sample equipment budget</dt><dd>{usd(quote.request.budgetMinor)}</dd></div></dl>
    <div className="equipment-quote-fees"><p>Computation allowance <strong>{paidToolAmount(quote.allowanceLimit)}</strong></p><p>Maximum network fee <strong>{paidToolAmount(quote.feeCeiling)}</strong></p></div><p className="equipment-quote-notice">{quote.notice}</p>
    <details><summary>Why this service</summary><p>{quote.reason}</p></details>
    {quote.assumptions.length>0&&<details><summary>Assumptions used</summary><ul>{quote.assumptions.map((a,i)=><li key={i}>{a}</li>)}</ul></details>}
    <details><summary>View the controlled demo catalogue</summary><div className="equipment-catalogue">{quote.catalogue.offers.map(offer=><article key={offer.id}><strong>{offer.label}</strong><span>{usd(offer.priceMinor)} sample USD</span><p>{offer.seats} seats · {offer.microphones} microphones · {offer.projectors} projectors</p></article>)}</div></details>
    <details><summary>Service recipient and token details</summary><dl className="equipment-quote-identities"><div><dt>Service</dt><dd>{quote.recipient.label}</dd></div><div><dt>Recipient owner</dt><dd>{quote.recipient.owner}</dd></div><div><dt>Token mint</dt><dd>{quote.asset.mint}</dd></div><div><dt>Token program</dt><dd>{quote.asset.tokenProgram}</dd></div><div><dt>Network genesis</dt><dd>{quote.asset.genesis}</dd></div></dl></details>
  </section>;
}
export function EquipmentPlanningState({workState}:{workState:NativeAgentWork['state']}){
  const [title,message]=workState==='working'
    ?['Preparing an equipment comparison','The team is working on the selected demo catalogue. An exact quote will appear here if the computation is suitable.']
    :workState==='needs_review'
      ?['Equipment comparison needs review','Work has stopped without an equipment quote. Check the saved task update for what needs attention.']
      :workState==='cancelled'
        ?['Equipment comparison stopped','This task was cancelled without an equipment quote.']
        :workState==='completed'
          ?['No equipment quote was prepared','This task has finished. Check the saved result for its findings.']
          :workState==='paused'
            ?['Equipment comparison paused','No equipment quote is available yet. Resume this task when you are ready to continue.']
            :workState==='queued'
              ?['Equipment comparison queued','This task has not started preparing an equipment quote yet.']
              :['Equipment comparison waiting','No equipment quote is available yet. Check the task status for the next step.'];
  return <section className="equipment-planning-state" role="status"><h2>{title}</h2><p>{message}</p></section>;
}
function EquipmentPanel({siteId,rootTaskId,workState,workControlVersion,evidenceAvailable,revisionKey,observing,canAuthorize,onStageChange,onPrepareFreshRequest}:Props){
  const binding=useAgentWorkBinding(siteId),discovery=useNativeEquipmentDiscovery(siteId,rootTaskId,revisionKey,observing);
  const [attempt,setAttempt]=useState<PaidQuoteAttempt|null>(null),pending=useRef<PaidQuoteAttempt|null>(null),[ready,setReady]=useState(false),[blocked,setBlocked]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[consent,setConsent]=useState(false),[expired,setExpired]=useState(false),[reviewVisible,setReviewVisible]=useState(false),[retry,setRetry]=useState(false),[savedOperation,setSavedOperation]=useState<string|null>(null);
  const reviewHeading=useRef<HTMLHeadingElement>(null),reviewTrigger=useRef<HTMLButtonElement>(null),panelRef=useRef<HTMLElement>(null);
  const [dialogOpen,setDialogOpen]=useState(false),[panelInView,setPanelInView]=useState(false);
  const lastDialogRevision=useRef(revisionKey);
  const lock=useRef(false),controller=useRef<AbortController|null>(null),latest=useRef({observing,canAuthorize,revisionKey});latest.current={observing,canAuthorize,revisionKey};
  const operationId=savedOperation??discovery.data?.operationId??null;
  const receipt=useNativePaidToolRead(siteId,rootTaskId,operationId??'none',Boolean(operationId)&&observing),controls=useNativePaidToolControl(siteId,rootTaskId,operationId??'none');
  const equipment=useNativePaidEquipment(siteId,rootTaskId,revisionKey,receipt.purchase,observing&&!receipt.error&&evidenceAvailable);
  const history=useNativePaidHistory(siteId,rootTaskId,revisionKey,receipt.purchase,observing&&!receipt.error&&Boolean(receipt.purchase?.state==='completed'&&(!evidenceAvailable||receipt.purchase.resultApplicability!=='current')));
  const quote=discovery.data?.quote??null,review=reviewVisible?attempt?.review??null:null;
  const quoteCurrent=Boolean(quote&&discovery.data?.state==='awaiting_review'&&(!attempt||JSON.stringify(quote)===JSON.stringify(attempt.quote)));
  const deadline=review?.confirmBy??quote?.reviewBy;
  const staleDiscovery=discovery.error instanceof RequestError&&['EVIDENCE_STALE','REVIEW_EXPIRED'].includes(discovery.error.code);
  const stage:EquipmentTaskStage|null=!ready||blocked||!observing||Boolean(discovery.error&&!staleDiscovery)||!['queued','working','waiting'].includes(workState)?null:
    attempt?.approval?'approval_unconfirmed':operationId?'purchase_recorded':staleDiscovery||discovery.data?.state==='unavailable'?'equipment_unavailable':!evidenceAvailable||error!==null?null:quoteCurrent?(expired||Boolean(deadline&&Date.now()>=Date.parse(deadline))?'quote_expired':'quote_ready'):null;
  useEffect(()=>{onStageChange?.(revisionKey,stage);return()=>onStageChange?.(revisionKey,null);},[revisionKey,stage,onStageChange]);
  const contributors=useNativePaidContributors(siteId,rootTaskId,revisionKey,workControlVersion,quote,stage==='quote_ready');
  useEffect(()=>{if(dialogOpen&&reviewVisible)reviewHeading.current?.focus();},[reviewVisible,attempt?.review?.reviewHash]);
  useEffect(()=>{if(typeof IntersectionObserver==='undefined'){setPanelInView(true);return;}const observer=new IntersectionObserver(([entry])=>setPanelInView(entry?.isIntersecting??false));const taskViewport=panelRef.current?.closest('.agent-work-page')??panelRef.current;if(taskViewport)observer.observe(taskViewport);return()=>observer.disconnect();},[discovery.data?.state,ready]);
  const dialogIdentity=quote?paymentDialogIdentity(JSON.stringify(binding.scope),rootTaskId,quote):null;
  useEffect(()=>{try{const saved=readPaidQuoteAttempt(sessionStorage,binding.scope,rootTaskId);pending.current=saved;setAttempt(saved);}catch(e){setError(e);setBlocked(true);}setReady(true);return()=>controller.current?.abort();},[]);
  useEffect(()=>{if(lastDialogRevision.current!==revisionKey){lastDialogRevision.current=revisionKey;setConsent(false);setReviewVisible(false);setRetry(false);setDialogOpen(false);}},[revisionKey]);
  useEffect(()=>{const change=()=>{if(!canObserveAgentWork()){controller.current?.abort();setConsent(false);setReviewVisible(false);setDialogOpen(false);}};document.addEventListener('visibilitychange',change);window.addEventListener('offline',change);return()=>{document.removeEventListener('visibilitychange',change);window.removeEventListener('offline',change);};},[]);
  useEffect(()=>{setConsent(false);if(!deadline){setExpired(false);return;}const check=()=>setExpired(Date.now()>=Date.parse(deadline));check();const timer=setTimeout(check,Math.max(0,Date.parse(deadline)-Date.now()+5));document.addEventListener('visibilitychange',check);return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',check);};},[deadline,quote?.quoteHash,attempt?.review?.reviewHash]);
  useEffect(()=>{if(dialogIdentity&&stage==='quote_ready'&&canAuthorize&&panelInView&&canObserveAgentWork()&&!attempt?.approval&&claimPaymentDialogPrompt(sessionStorage,dialogIdentity))setDialogOpen(true);},[dialogIdentity,stage,canAuthorize,panelInView,attempt?.approval]);
  useEffect(()=>{if(!canAuthorize||!quoteCurrent||blocked||expired)setConsent(false);},[canAuthorize,quoteCurrent,blocked,expired]);
  const current=()=>{if(!latest.current.observing||!canObserveAgentWork())throw new RequestError('OBSERVATION_PAUSED','Reconnect before continuing.');return binding.current();};
  const authority=()=>{const scope=current();if(!latest.current.canAuthorize||latest.current.revisionKey!==revisionKey)throw new RequestError('REVIEW_CHANGED','The work changed. Review its latest state.',409);return scope;};
  function retain(a:PaidQuoteAttempt){storePaidQuoteAttempt(sessionStorage,a);pending.current=a;setAttempt(a);}
  function clear(a:PaidQuoteAttempt){clearPaidQuoteAttempt(sessionStorage,a);pending.current=null;setAttempt(null);setReviewVisible(false);setConsent(false);setRetry(false);}
  async function refresh(){await Promise.all([discovery.refetch(),operationId?receipt.refetch():Promise.resolve()]);}
  async function run(kind:'review'|'approve'|'recover'|'retry'){
    if(lock.current||blocked||!ready||!observing)return;let a=pending.current;
    if(kind==='approve'&&(!a?.review||a.approval||!consent||!reviewVisible||!quoteCurrent||expired||!canAuthorize))return;
    if(kind==='retry'&&(!a?.approval||!retry||!consent||!reviewVisible||!quoteCurrent||expired||!canAuthorize))return;
    lock.current=true;controller.current=new AbortController();const signal=AbortSignal.any([controller.current.signal,binding.controller.current.signal,AbortSignal.timeout(25000)]);setBusy(true);setError(null);setRetry(false);
    try{current();
      if(kind==='review'){
        authority();if(a?.approval)throw new RequestError('ACTION_PENDING','Recover the original approval first.');
        if(!quoteCurrent||!quote||Date.now()>=Date.parse(quote.reviewBy))throw new RequestError('REVIEW_EXPIRED','This quote review window ended.',409);
        if(!a){a=createPaidQuoteAttempt(binding.scope,rootTaskId,quote);retain(a);}
        const result=await requestPaidQuoteReview(a,binding.getToken,authority,{signal});binding.current();a=retainPaidQuoteReview(a,result);retain(a);setReviewVisible(true);setConsent(false);
      }else if(kind==='recover'){
        if(!a?.approval)throw new RequestError('REVIEW_REQUIRED','There is no original approval to check.');
        const result=await recoverPaidQuoteApproval(a,binding.getToken,current,{signal});
        if(result.purchase){setSavedOperation(result.purchase.operationId);clear(a);await refresh();}else{setRetry(true);setReviewVisible(true);setConsent(false);}
      }else{
        authority();if(!a?.review||Date.now()>=Date.parse(a.review.confirmBy))throw new RequestError('REVIEW_EXPIRED','The exact payment review expired.',409);
        a=approvePaidQuoteAttempt(a);retain(a);setConsent(false);
        const result=await sendPaidQuoteApproval(a,binding.getToken,authority,{signal,beforeDispatch:()=>{if(!a?.review||Date.now()>=Date.parse(a.review.confirmBy))throw new RequestError('REVIEW_EXPIRED','The exact payment review expired.',409);return undefined;}});
        binding.current();setSavedOperation(result.purchase.operationId);clear(a);await refresh();
      }
    }catch(e){if(binding.live.current){setError(e);setConsent(false);if(kind!=='recover')setReviewVisible(false);}}
    finally{lock.current=false;if(binding.live.current)setBusy(false);}
  }
  function openDialog(){if(dialogIdentity)claimPaymentDialogPrompt(sessionStorage,dialogIdentity);setConsent(false);setDialogOpen(true);}
  function changeDialog(open:boolean){if(open){openDialog();return;}setConsent(false);setDialogOpen(false);}
  function closeReview(){const a=pending.current;if(!a||a.approval||busy)return;try{current();clear(a);setError(null);}catch(e){setError(e);setBlocked(true);}}
  if(discovery.data?.state==='not_selected'&&!attempt&&!operationId&&!blocked)return null;
  if(!discovery.data&&!attempt&&!operationId&&!discovery.error)return null;
  return <section className="equipment-payment-panel" aria-label="Equipment service and payment" ref={panelRef} tabIndex={-1}>
    {error!==null&&<Alert title="Check the original equipment request" tone="amber"><p>{error instanceof RequestError&&error.code==='REVIEW_EXPIRED'?'This review has expired. Any original approval must still be checked; expiry does not undo a payment.':agentWorkError(error)}</p></Alert>}
    {attempt?.approval&&<Alert title="Original payment approval retained" tone="blue"><p>Check whether the original approval was saved before taking another action. This will not authorize a second purchase.</p><button className="button secondary" disabled={!observing||busy||blocked} onClick={()=>{openDialog();void run('recover');}}><ActionLabel pending={busy} label={busy?'Checking original approval…':'Check original approval'} reserve={['Checking original approval…','Check original approval']}/></button>{retry&&<p>No saved purchase was found yet. You may explicitly retry this same approval while its exact review is still valid.</p>}</Alert>}
    {discovery.error&&!operationId&&<Alert title="Equipment status needs checking" tone="amber"><p>The saved equipment status could not be refreshed.</p><button className="button secondary" disabled={!observing||discovery.isFetching} onClick={()=>void discovery.refetch()}>Refresh equipment status</button></Alert>}
    {!operationId&&!attempt?.approval&&discovery.data?.state==='planning'&&<EquipmentPlanningState workState={workState}/>}
    {!operationId&&discovery.data?.state==='unavailable'&&<Alert title="Equipment details are unavailable" tone="amber"><p>Refresh the current work before reviewing a quote. Earlier approvals, if any, still need their original receipt checked.</p></Alert>}
    {!operationId&&!attempt?.approval&&onPrepareFreshRequest&&(expired||discovery.data?.state==='unavailable'||staleDiscovery)&&<div className="equipment-quote-actions"><button type="button" className="button secondary" disabled={!ready||busy||blocked||!observing} onClick={onPrepareFreshRequest}>Prepare a fresh request</button><p>Copy the original instructions into a new draft for review. This does not renew the old quote or approve a payment.</p></div>}
    {!operationId&&quote&&discovery.data?.state==='awaiting_review'&&<>{contributors.data&&<RecordedEquipmentContributors value={contributors.data}/>}<EquipmentQuoteSummary quote={quote}/>
      {expired&&<p role="status" className="equipment-quote-notice">The review window has ended. Refresh this task to check what is available next.</p>}
      {!attempt?.approval&&<div className="equipment-quote-actions"><button ref={reviewTrigger} className="button" disabled={!ready||busy||blocked||!observing||!canAuthorize||expired||!quoteCurrent} onClick={openDialog}>Review payment</button><p>Review by <time dateTime={quote.reviewBy}>{agentWorkTime(quote.reviewBy)}</time>. No funds are authorized by opening this review.</p></div>}
    </>}
    {!operationId&&attempt&&!attempt.approval&&<button type="button" className="button secondary" disabled={busy||!observing} onClick={closeReview}>Close unapproved review</button>}
    <EquipmentPaymentDialog open={dialogOpen} onOpenChange={changeDialog} returnFocus={reviewTrigger} fallbackFocus={panelRef} title={operationId?'Payment and delivery':attempt?.approval&&!retry?'Check original approval':'Approve this computation'}>
      <div className="payment-dialog-body">
        {operationId?<EquipmentPaymentProgress purchase={receipt.purchase??null} loading={!receipt.purchase&&!receipt.error}/>:<>
          {(review?.quote??quote)&&<EquipmentPaymentFacts quote={(review?.quote??quote)!} confirmBy={review?.confirmBy??quote!.reviewBy} expired={expired}/>}
          {error!==null&&<Alert title={attempt?.approval?'Checking payment status':'Review needs attention'} tone="amber"><p>{error instanceof RequestError&&error.code==='REVIEW_EXPIRED'?'This review has expired. Any original approval must still be checked; expiry does not undo a payment.':agentWorkError(error)}</p></Alert>}
          {expired&&<Alert title="Review expired" tone="amber"><p>This quote can no longer authorize a payment. Close this review and check the equipment status for the next step.</p></Alert>}
          {(!observing||!canAuthorize||!quoteCurrent)&&<Alert title="Review is unavailable" tone="amber"><p>Reconnect or refresh this task before taking a payment action. No new approval can be submitted from this view.</p></Alert>}
          {attempt?.approval&&!retry&&<Alert title="Original approval retained" tone="blue"><p>{busy?'Submitting the original approval. Waiting for its recorded outcome.':'Check whether the original approval was saved. This will not authorize a second purchase.'}</p></Alert>}
          {review&&<section className="equipment-exact-review" aria-label="Exact payment approval">
            <h3 ref={reviewHeading} tabIndex={-1}>Exact payment approval</h3>
            <details><summary>Check exact payment accounts</summary><dl className="equipment-quote-identities"><div><dt>Payment source</dt><dd>{review.source.tokenAccount}</dd></div><div><dt>Source owner</dt><dd>{review.source.owner}</dd></div><div><dt>Network fee payer</dt><dd>{review.source.feePayer}</dd></div><div><dt>Recipient token account</dt><dd>{review.recipientTokenAccount}</dd></div></dl></details>
            {retry&&<p>No saved purchase was found yet. You may explicitly retry this same approval while its exact review is still valid.</p>}
            <label className="agent-work-check"><input type="checkbox" checked={consent} disabled={!observing||!canAuthorize||busy||expired||!quoteCurrent||Boolean(attempt?.approval&&!retry)} onChange={e=>setConsent(e.target.checked)}/><span>I approve this exact devnet computation payment and its reviewed network fee limit.</span></label>
          </section>}
        </>}
      </div>
      <footer className="payment-dialog-footer">
        <button type="button" className="button secondary" onClick={()=>changeDialog(false)}>{operationId?'Return to task':'Not now'}</button>
        {operationId?<button className="button" disabled={!observing||receipt.isFetching} onClick={()=>void refresh()}><ActionLabel pending={receipt.isFetching} label={receipt.isFetching?'Checking receipt…':'Check payment status'} reserve={['Checking receipt…','Check payment status']}/></button>
          :attempt?.approval&&!retry?<button className="button" disabled={!observing||busy||blocked} onClick={()=>void run('recover')}><ActionLabel pending={busy} label={busy?'Checking payment status…':'Check original approval'} reserve={['Checking payment status…','Check original approval']}/></button>
          :review?<button className="button" disabled={!consent||!observing||!canAuthorize||busy||expired||!quoteCurrent||blocked||Boolean(attempt?.approval&&!retry)} onClick={()=>void run(attempt?.approval?'retry':'approve')}><ActionLabel pending={busy} label={busy?'Confirming original approval…':attempt?.approval?'Retry original approval':`Approve ${paidToolAmount(review.quote.amount)} computation`} reserve={['Confirming original approval…',`Approve ${paidToolAmount(review.quote.amount)} computation`]}/></button>
          :<button className="button" disabled={!ready||busy||blocked||!observing||!canAuthorize||expired||!quoteCurrent||Boolean(attempt?.approval)} onClick={()=>void run('review')}><ActionLabel pending={busy} label={busy?'Loading exact review…':attempt?'Check original quote review':'Review exact payment'} reserve={['Loading exact review…','Check original quote review','Review exact payment']}/></button>}
      </footer>
    </EquipmentPaymentDialog>
    {operationId&&(receipt.purchase?<NativePaidToolReceipt view={receipt.purchase} resultUnavailable={!evidenceAvailable||receipt.purchase.resultApplicability!=='current'} history={history.data} historyLoading={history.enabled&&!history.data&&!history.error} equipment={equipment.data} equipmentLoading={equipment.enabled&&!equipment.data&&!equipment.error} equipmentUnavailable={Boolean(equipment.error)} onRefreshEquipment={equipment.enabled?()=>void equipment.refetch():undefined} observing={observing&&!receipt.error} pending={controls.busy} onAction={async action=>{if(action.action==='check'){await refresh();return;}if(!receipt.purchase||action.version!==receipt.purchase.version||action.operationId!==receipt.purchase.operationId)throw new RequestError('REVIEW_CHANGED','Refresh this receipt.');await controls.act(receipt.purchase,action.action);await refresh();}}/>:<Alert title={receipt.error?'Original purchase needs checking':'Loading the original purchase'} tone="blue">{receipt.error?<p>This receipt could not be refreshed. Check the same purchase again.</p>:<LoadingState variant="compact" announce={false} active={observing} label="Checking recorded payment and delivery"/>}<button className="button secondary" disabled={!observing||receipt.isFetching} onClick={()=>void receipt.refetch()}>Refresh original receipt</button></Alert>)}
    {operationId&&controls.hasPending&&<Alert title="Check the original payment control" tone="blue"><p>A previous cancellation or revocation needs confirmation.</p><button className="button secondary" disabled={!observing||controls.busy} onClick={()=>void controls.recover().then(refresh).catch(()=>{})}>Check saved payment control</button></Alert>}
    {operationId&&controls.error!==null&&<p role="alert">The payment control could not be confirmed. Keep and check the original request before making another change.</p>}
  </section>;
}
