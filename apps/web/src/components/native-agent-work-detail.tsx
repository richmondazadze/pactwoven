'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { NativeAgentWork, NativeAgentWorkControl } from '../../../../packages/contracts/src/native-agent-work';
import type { NativeWorkActivity } from '../../../../packages/contracts/src/native-work-activity';
import { RequestError } from '../lib/api';
import { getNativeApiBase } from '../lib/config';
import { agentWorkIdentity, agentWorkPath, agentWorkTime, agentWorkError, agentWorkReadDenied, agentWorkRejected, canStartAgentWork, readableAgentWorkSites,
  readAgentWorkAttempt, previousAgentWorkConnection, createAgentWorkControl, storeAgentWorkAttempt, clearAgentWorkAttempt, sendAgentWorkControl, recoverAgentWorkControl,
  type AgentWorkControlAttempt } from '../lib/native-agent-work';
import { useWorkspace } from './workspace-provider';
import { canObserveAgentWork, useAgentWorkBinding, useAgentWorkDetail } from './native-agent-work-hooks';
import { ActionLabel, Alert, LoadingState, StatusBadge } from './ui';
import { Icon } from './icon';
import { agentWorkStatusDescription, completedWorkEvidenceCopy } from '../lib/native-agent-work-presentation';
import { NativeAgentWorkAnnouncements } from './native-agent-work-announcements';
import { NativeWorkConversation } from './native-work-conversation';
import { AgentActivityWorkspace } from './demo-workspace';
import { demoActionLabels } from '../lib/demo-workspace';
import { useNativeWorkActivity } from './native-work-activity-hooks';
import { useNativeWorkTeamActivity } from './native-work-team-activity-hooks';
import { NativeWorkTeamActivityPanel } from './native-work-team-activity';
import { SpokenWorkResult } from './voice-command-composer';
import { NativeEquipmentPaymentPanel, equipmentTaskStageCopy, type EquipmentTaskStage } from './native-equipment-payment-panel';
import { NativeAgentWorkComposer, type FreshAgentWorkDraft } from './native-agent-work-composer';
import './native-agent-work.css';

const stateLabels={queued:'Queued',working:'Working',waiting:'Waiting for specialists',awaiting_calendar:'Finish calendar setup',waiting_external:'Waiting for an update',paused:'Paused',cancelled:'Cancelled',completed:'Advice ready',needs_review:'Needs review'} as const;
const stepLabels={planned:'Planned',active:'In progress',done:'Complete',blocked:'Needs review'} as const;
const actionLabels={pause:'Pause work',resume:'Resume work',cancel:'Cancel work'} as const;
export function NativeAgentWorkContent({work,observing=true,evidenceExpired=false,instructionsChanged=false,conversation}:{work:NativeAgentWork;observing?:boolean;evidenceExpired?:boolean;instructionsChanged?:boolean;conversation?:ReactNode}) {
  const withheld=instructionsChanged||work.evidenceUnavailable||evidenceExpired||Boolean(work.result?.evidenceValidUntil&&Date.now()>=Date.parse(work.result.evidenceValidUntil));
  const awaitingCalendar=['awaiting_calendar'].includes(work.state),waitingExternal=['waiting_external'].includes(work.state);
  return <div className="agent-work-detail-grid"><div className="agent-work-main">
    {awaitingCalendar&&<Alert title="Finish calendar setup" tone="blue"><p>This request is saved. Work has not started. An event and its read permission must be reviewed before it can begin.</p></Alert>}
    {withheld?<Alert title={instructionsChanged?"Instructions updated":work.state==='completed'?completedWorkEvidenceCopy.title:"Earlier evidence needs review"} tone={work.state==='completed'&&!instructionsChanged?"blue":"amber"}><p>{instructionsChanged?"Checking the saved work against your updated instructions. Earlier progress and advice are unavailable while this check finishes.":work.state==='completed'?completedWorkEvidenceCopy.body:"Previous progress and advice are unavailable in this view. Your original work request is retained."}</p></Alert>:work.result&&<section className="agent-work-panel agent-work-result" aria-label="Saved advice"><div className="agent-work-panel-heading"><h2>{work.result.title}</h2><StatusBadge tone="green">Advice only</StatusBadge></div><p className="agent-work-text">{work.result.summary}</p>{work.result.artifacts.map(artifact=><details key={artifact.id} className="agent-work-artifact" open={work.result!.artifacts.length===1}><summary>{artifact.title}</summary><div className="agent-work-text">{artifact.text}</div></details>)}{work.result.evidenceValidUntil&&<p className="agent-work-caption">Evidence review window ends <time dateTime={work.result.evidenceValidUntil}>{agentWorkTime(work.result.evidenceValidUntil)}</time>.</p>}</section>}
    {conversation??<section className="agent-work-panel"><h2>Your request</h2><p className="agent-work-text">{work.prompt}</p></section>}
  </div><aside className="agent-work-panel agent-work-progress" aria-label="Recorded progress"><h2>Recorded progress</h2>{!withheld&&!awaitingCalendar&&work.progress?<><p className="agent-work-text">{work.progress.summary}</p>{(work.progress.historical||waitingExternal)&&<p className="agent-work-caption">{waitingExternal?'These are saved steps. Work is waiting for an update.':'Earlier progress is retained while the team checks what can continue.'}</p>}<ol>{work.progress.steps.map(step=><li key={step.id} data-state={step.state} data-observing={observing&&!work.progress?.historical&&work.state==='working'}><span className="agent-work-step-dot" aria-hidden="true"/><div><h3>{step.title}</h3><span>{waitingExternal&&step.state==='active'?'Waiting':stepLabels[step.state]}</span></div></li>)}</ol></>:<p>{withheld?'The evidence behind earlier progress is no longer available.':awaitingCalendar?'No work has started.':waitingExternal?'Work is waiting for an update.':'Updates will appear after the team records its plan.'}</p>}<div className="agent-work-permission"><h3>{awaitingCalendar?'Setup review window':'Background permission'}</h3><p>{awaitingCalendar?'Complete the reviewed setup before ':'Your original permission allows background work until '}<time dateTime={work.expiresAt}>{agentWorkTime(work.expiresAt)}</time>.</p><p>{awaitingCalendar?'Saving setup does not start background work.':waitingExternal?'The team is waiting for an update from the connected service.':work.state==='cancelled'?'This work is cancelled.':work.state==='completed'?'This work is complete.':work.state==='paused'?'This work stays paused until you resume it.':work.state==='needs_review'?'This work needs your review. Check its saved status and receipt.':'Active work continues when you close this tab or sign out.'}</p><p>This background permission covers advice only. Messages, orders and account changes are not permitted. Any payment needs its own exact approval.</p></div></aside></div>;
}
export function EquipmentWorkNextStep({stage}:{stage:EquipmentTaskStage}){
  const copy={
    quote_ready:{title:'Ready for your payment review',text:'The computation quote is ready above. Review its price and limits, then approve only if you want to continue.'},
    quote_expired:{title:'This payment review has expired',text:'Use the equipment section above to prepare a fresh request for review. The original quote and any payment record stay unchanged.'},
    equipment_unavailable:{title:'Equipment review needs attention',text:'The saved quote or its supporting evidence is unavailable. Check the equipment section above; a fresh request requires a new review.'},
    approval_unconfirmed:{title:'Check the original approval',text:'Use the recovery action above to check whether the original approval was saved. Do not start another payment.'},
    purchase_recorded:{title:'Follow payment and delivery',text:'The original purchase is recorded above. Its receipt shows payment confirmation and service delivery separately.'},
  }[stage];
  return <section className="agent-work-panel" aria-label="Payment next step"><h2>{copy.title}</h2><p>{copy.text}</p><p className="agent-work-caption">The original task permission covers planning and advice. A computation payment needs its own exact approval and receipt.</p></section>;
}
export function EquipmentRecordedActivity({activity}:{activity:NativeWorkActivity}){
  if(activity.freshness==='unavailable')return <p>These execution records are unavailable under the current evidence access.</p>;
  return <section aria-label="Saved execution records"><p className="agent-work-caption">These are saved execution records. Use the payment step above for the current quote or purchase status.</p>{activity.actions.length?<ol>{activity.actions.map(action=><li key={action.id}><strong>{activity.agents.find(agent=>agent.id===action.actorId)?.label??'Team'}</strong><p>{action.label}</p><span className="agent-work-caption">Recorded state: {demoActionLabels[action.state]}{action.recordedAt&&<> · <time dateTime={action.recordedAt}>{agentWorkTime(action.recordedAt)}</time></>}</span></li>)}</ol>:<p>No execution details are available in this snapshot.</p>}</section>;
}
function NativeAgentWorkspaceContent({ siteId, work, observing, evidenceExpired, instructionsChanged, conversation, onRefresh, equipmentStage }: {
  siteId: string; work: NativeAgentWork; observing: boolean; evidenceExpired: boolean; instructionsChanged: boolean;
  conversation: ReactNode; onRefresh: () => Promise<void>; equipmentStage:EquipmentTaskStage|null;
}) {
  const [showActivity,setShowActivity]=useState(false);
  useEffect(()=>setShowActivity(false),[equipmentStage,work.controlVersion,work.updatedAt]);
  const activity = useNativeWorkActivity(siteId, work, (!equipmentStage||showActivity) && !instructionsChanged && !work.evidenceUnavailable && !evidenceExpired);
  const teamActivity = useNativeWorkTeamActivity(siteId, work, observing && !instructionsChanged && !work.evidenceUnavailable && !evidenceExpired);
  const refreshing = useRef(false);
  useEffect(() => {
    if ((!activity.revisionChanged && !teamActivity.revisionChanged) || !observing || refreshing.current) return;
    refreshing.current = true; void onRefresh().finally(() => { refreshing.current = false; });
  }, [activity.revisionChanged, teamActivity.revisionChanged, observing, work.updatedAt]);
  if (!equipmentStage&&activity.setupRequired) return <NativeAgentWorkContent work={work} observing={observing} evidenceExpired={evidenceExpired} instructionsChanged={instructionsChanged} conversation={conversation}/>;
  const withheld = instructionsChanged || work.evidenceUnavailable || evidenceExpired;
  return <div className="agent-work-visual-content" data-observing={observing && Boolean(activity.activity)}>
    {!withheld && <NativeWorkTeamActivityPanel activity={teamActivity.activity} work={work} observing={observing && teamActivity.visible && !teamActivity.error}/>}
    {equipmentStage?<EquipmentWorkNextStep stage={equipmentStage}/>:withheld ? <Alert title={instructionsChanged ? 'Instructions updated' : work.state === 'completed' ? completedWorkEvidenceCopy.title : 'Earlier evidence needs review'} tone={work.state === 'completed' && !instructionsChanged ? 'blue' : 'amber'}><p>{instructionsChanged ? 'The team is checking your updated instructions. Earlier activity and advice are unavailable during this check.' : work.state === 'completed' ? completedWorkEvidenceCopy.body : 'Earlier activity and advice are unavailable. Your original request is retained below.'}</p></Alert>
      : activity.activity ? <AgentActivityWorkspace activity={activity.activity} observing={observing && activity.visible && !activity.error} result={work.result}
          resultActions={<SpokenWorkResult key={`${work.controlVersion}:${work.updatedAt}`} siteId={siteId} rootTaskId={work.id} disabled={!observing||withheld}/>}/>
      : activity.error ? <Alert title="Activity needs checking" tone="amber"><p>We could not refresh the team’s activity. Your saved instructions and work controls remain available.</p><button className="button secondary" disabled={!observing || activity.isFetching} onClick={() => void activity.refetch()}>Refresh activity</button></Alert>
      : !observing ? <p className="agent-work-caption">The team’s saved activity will load when this tab reconnects.</p>
      : <LoadingState label={activity.revisionChanged ? 'Checking the latest work and activity' : 'Loading the team’s recorded activity'}/>}
    {equipmentStage&&<details open={showActivity} className="agent-work-conversation-disclosure" onToggle={event=>setShowActivity(event.currentTarget.open)}><summary>Recorded execution details</summary>{showActivity&&(withheld?<p>Earlier execution records are unavailable under the current evidence access.</p>:activity.activity?<EquipmentRecordedActivity activity={activity.activity}/>:activity.error?<p>Execution details could not be refreshed. The original quote or purchase remains above.</p>:!observing?<p>Reconnect to check the saved execution details.</p>:<LoadingState label="Loading recorded execution details"/>)}</details>}
    <details className="agent-work-conversation-disclosure" open={work.state === 'paused'}><summary>Your instructions <span>{work.state === 'paused' ? 'Review or update before resuming' : 'Original request and saved updates'}</span></summary>{conversation}</details>
    <p className="agent-work-caption">{equipmentStage?'Original background permission ends ':<>{work.state === 'completed' ? 'This work is complete.' : work.state === 'cancelled' ? 'This work is cancelled.' : work.state === 'paused' ? 'Work stays paused until you resume it.' : work.state === 'needs_review' ? 'This work needs your review. Check its saved status and receipt.' : ['awaiting_calendar'].includes(work.state) ? 'Finish calendar setup before work can begin.' : ['waiting_external'].includes(work.state) ? 'The team is waiting for an update.' : 'Permitted background work continues when you close this tab.'} Background permission ends </>}<time dateTime={work.expiresAt}>{agentWorkTime(work.expiresAt)}</time>.</p>
  </div>;
}
export function NativeAgentWorkDetail({siteId,id}:{siteId:string;id:string}) {
  const {session}=useWorkspace();
  if(!getNativeApiBase())return <Alert title="Work is not connected" tone="blue"><p>Your saved requests remain in this tab.</p></Alert>;
  if(!readableAgentWorkSites(session).some(site=>site.id===siteId))return <Alert title="This site is outside your access" tone="red"><p>Choose an accessible site from Work.</p></Alert>;
  return <Detail key={`${agentWorkIdentity(session,siteId)}:${id}`} siteId={siteId} id={id}/>;
}
function Detail({siteId,id}:{siteId:string;id:string}) {
  const binding=useAgentWorkBinding(siteId),query=useAgentWorkDetail(siteId,id),work=query.data?.work;
  const [attempt,setAttempt]=useState<AgentWorkControlAttempt|null>(null),pending=useRef<AgentWorkControlAttempt|null>(null);
  const [instructionsLocked,setInstructionsLocked]=useState(true),[instructionVersionFloor,setInstructionVersionFloor]=useState(0);
  const instructionsChanged=Boolean(work&&work.controlVersion<instructionVersionFloor);
  const [ready,setReady]=useState(false),[blocked,setBlocked]=useState(false),[busy,setBusy]=useState(false),sending=useRef(false);
  const [error,setError]=useState<unknown>(null),[message,setMessage]=useState(''),[retry,setRetry]=useState(false),[cancel,setCancel]=useState(false),[evidenceExpired,setEvidenceExpired]=useState(false);
  const [equipmentStage,setEquipmentStage]=useState<{revisionKey:string;stage:EquipmentTaskStage|null}|null>(null);
  const [freshDraft,setFreshDraft]=useState<FreshAgentWorkDraft|null>(null),freshDraftElement=useRef<HTMLElement>(null);
  useEffect(()=>{if(freshDraft){freshDraftElement.current?.focus();freshDraftElement.current?.scrollIntoView({block:'start'});}},[freshDraft]);
  const equipmentStageChanged=useCallback((revisionKey:string,stage:EquipmentTaskStage|null)=>setEquipmentStage({revisionKey,stage}),[]);
  const visibleEquipmentStage=work&&query.visible&&!query.error&&error===null&&!instructionsChanged&&(!work.evidenceUnavailable&&!evidenceExpired||equipmentStage?.stage==='equipment_unavailable')&&['queued','working','waiting'].includes(work.state)&&equipmentStage?.revisionKey===`${work.controlVersion}:${work.updatedAt}`?equipmentStage.stage:null;
  const equipmentCopy=visibleEquipmentStage?equipmentTaskStageCopy[visibleEquipmentStage]:null;
  const writable=canStartAgentWork(binding.session,siteId),denied=agentWorkReadDenied(error)||agentWorkReadDenied(query.error);
  const displayError=error??query.error;
  useEffect(()=>{try{if(previousAgentWorkConnection(sessionStorage,binding.scope,id))throw new RequestError('PREVIOUS_CONNECTION_PENDING','Check the original connection.');const saved=readAgentWorkAttempt(sessionStorage,binding.scope,id);if(saved?.kind==='control'){pending.current=saved;setAttempt(saved);}}
    catch(failure){setError(failure);setBlocked(true);}setReady(true);},[]);
  useEffect(()=>{const until=work?.result?.evidenceValidUntil;if(!until){setEvidenceExpired(false);return;}const check=()=>{const expired=Date.now()>=Date.parse(until);setEvidenceExpired(expired);if(expired&&canObserveAgentWork())void query.refetch();};
    setEvidenceExpired(Date.now()>=Date.parse(until));const timer=Date.parse(until)>Date.now()?setTimeout(check,Date.parse(until)-Date.now()+5):undefined;
    document.addEventListener('visibilitychange',check);return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',check);};},[work?.result?.evidenceValidUntil]);
  const connectedCurrent=()=>{if(!canObserveAgentWork())throw new RequestError('OBSERVATION_PAUSED','Return to this tab and reconnect.');return binding.current();};
  const current=()=>{const scope=connectedCurrent();if(!canStartAgentWork(binding.session,siteId))throw new RequestError('FORBIDDEN','Current work permission is required.',403);return scope;};
  const signal=(ms=25000)=>AbortSignal.any([binding.controller.current.signal,AbortSignal.timeout(ms)]);
  function clear(value:AgentWorkControlAttempt){clearAgentWorkAttempt(sessionStorage,value);pending.current=null;setAttempt(null);}
  async function refresh(){if(!canObserveAgentWork())return;const result=await query.refetch();if(binding.live.current&&result.isSuccess){setError(null);setMessage('');}}
  async function instructionUpdated(version:number){setInstructionVersionFloor(value=>Math.max(value,version));await refresh();}
  function prepareFreshRequest(){if(!work||!query.visible||query.error||denied||!writable||busy||blocked||attempt||instructionsChanged||freshDraft)return;try{current();setFreshDraft({title:work.title,prompt:work.prompt,equipment:true});}catch(failure){setError(failure);}}
  async function control(action:NativeAgentWorkControl['action'],original?:AgentWorkControlAttempt){if(!query.visible||sending.current||blocked||instructionsLocked||instructionsChanged||!ready||!writable||!work||denied||(!original&&(pending.current||query.error||!work.availableActions.includes(action)))||(original&&(!retry||original!==pending.current)))return;
    sending.current=true;setBusy(true);setError(null);setMessage('');setRetry(false);let value:AgentWorkControlAttempt|null=original??null,dispatched=false;
    try{current();value??=createAgentWorkControl(binding.scope,id,{action,expectedVersion:work.controlVersion});storeAgentWorkAttempt(sessionStorage,value);pending.current=value;setAttempt(value);
      await sendAgentWorkControl(value,binding.getToken,current,{signal:signal(),beforeDispatch:()=>{dispatched=true;}});binding.current();clear(value);setCancel(false);setMessage(`${action==='pause'?'Pause':action==='resume'?'Resume':'Cancellation'} saved. Checking the current status…`);await refresh();}
    catch(failure){if(!binding.live.current)return;if(value&&(!dispatched&&!original||agentWorkRejected(failure,Boolean(original),true))){try{clear(value);}catch{setBlocked(true);}}setError(failure);setCancel(false);if(failure instanceof RequestError&&failure.code==='ROOT_CONFLICT'&&canObserveAgentWork())void query.refetch();}
    finally{sending.current=false;if(binding.live.current)setBusy(false);}}
  async function recover(){const original=pending.current;if(!query.visible||!original||sending.current||blocked)return;sending.current=true;setBusy(true);setError(null);setRetry(false);setMessage('');
    try{const result=await recoverAgentWorkControl(original,binding.getToken,connectedCurrent,signal(15000));if(result.operation){clear(original);setMessage('The original action was saved. Checking the current status…');await refresh();}else{setRetry(true);setMessage('No saved action was found yet. You may retry the exact original action.');}}
    catch(failure){if(binding.live.current)setError(failure);}finally{sending.current=false;if(binding.live.current)setBusy(false);}}
  return <div className="agent-work-page"><Link href={agentWorkPath(siteId)} className="agent-work-back"><Icon name="arrow-left" size={16}/>Work</Link>
    {message&&<p className="agent-work-announcement" role="status">{message}</p>}
    {(error!==null||query.error)&&<Alert title="Work needs checking" tone="red"><p>{displayError instanceof RequestError&&displayError.code==='OBSERVATION_PAUSED'?'Return to this tab and reconnect to check the latest status. Any original action is kept.':agentWorkError(displayError)}</p><button className="button secondary" disabled={!query.visible||query.isFetching||busy} onClick={()=>void refresh()}>Refresh work</button></Alert>}
    {!query.visible&&<Alert title="Live updates are paused" tone="amber"><p>{work&&!denied?'Showing the last saved status. ':''}Updates resume when this tab is visible and connected. Background work keeps its current instructions.</p></Alert>}
    {attempt&&<Alert title="Check the original action" tone="blue"><p>Your {attempt.input.action==='cancel'?'cancellation':attempt.input.action} request is retained. Checking will not create another action.</p><div className="actions"><button className="button secondary" disabled={!query.visible||busy||blocked} onClick={()=>void recover()}><ActionLabel label={busy?'Checking…':'Check saved action'} reserve={['Checking…','Check saved action']}/></button>{retry&&writable&&<button className="button" disabled={!query.visible||busy||blocked||denied} onClick={()=>void control(attempt.input.action,attempt)}>Retry original action</button>}</div></Alert>}
    {!work&&!query.error&&<LoadingState label={query.visible?'Loading saved work':'Waiting for a connection'}/>}
    {work&&!denied&&<><header className="agent-work-detail-heading"><div><div className="agent-work-context">{work.siteName}<span>Planning and advice</span></div><h1>{work.title}</h1><p role={equipmentCopy?'status':undefined}>{equipmentCopy?.description??agentWorkStatusDescription(work,evidenceExpired)}</p><p className="agent-work-caption">Last saved update <time dateTime={work.updatedAt}>{agentWorkTime(work.updatedAt)}</time>{query.isFetching?' · Checking…':''}</p></div><StatusBadge tone={work.state==='completed'?'green':work.state==='needs_review'?'amber':work.state==='working'||work.state==='waiting'?'blue':'neutral'}>{equipmentCopy?.title??stateLabels[work.state]}</StatusBadge></header>
      {!instructionsChanged&&work.availableActions.length>0&&writable&&<div className="agent-work-controls" aria-label="Work controls">{work.availableActions.map(action=><button className={`button ${action==='resume'?'':'secondary'}`} key={action} disabled={!query.visible||!ready||busy||blocked||instructionsLocked||Boolean(attempt)||Boolean(query.error)||query.isFetching} onClick={()=>action==='cancel'?setCancel(true):void control(action)}>{actionLabels[action]}</button>)}</div>}
      {cancel&&<Alert title="Cancel this work?" tone="amber"><p>The team will stop further work. Previously saved records remain.</p><div className="actions"><button className="button danger" disabled={!query.visible||busy||Boolean(attempt)} onClick={()=>void control('cancel')}>Confirm cancellation</button><button className="button secondary" disabled={busy} onClick={()=>setCancel(false)}>Keep working</button></div></Alert>}
      {!visibleEquipmentStage&&<NativeAgentWorkAnnouncements work={work} observing={query.visible&&!query.error&&!instructionsChanged} evidenceExpired={evidenceExpired}/>}
      <NativeEquipmentPaymentPanel siteId={siteId} rootTaskId={id} workState={work.state} workControlVersion={work.controlVersion} evidenceAvailable={!work.evidenceUnavailable&&!evidenceExpired&&!instructionsChanged} revisionKey={`${work.controlVersion}:${work.updatedAt}`} onStageChange={equipmentStageChanged} onPrepareFreshRequest={writable&&!busy&&!blocked&&!attempt&&!instructionsChanged&&!freshDraft?prepareFreshRequest:undefined} observing={query.visible&&!query.error&&!instructionsChanged} canAuthorize={writable&&!instructionsChanged&&!work.evidenceUnavailable&&!evidenceExpired&&!busy&&!attempt&&!instructionsLocked&&!blocked&&!['paused','cancelled','completed','needs_review','awaiting_calendar'].includes(work.state)}/>
      <NativeAgentWorkspaceContent siteId={siteId} work={work} equipmentStage={visibleEquipmentStage} onRefresh={refresh} observing={query.visible&&!query.error&&!instructionsChanged} evidenceExpired={evidenceExpired} instructionsChanged={instructionsChanged} conversation={<NativeWorkConversation siteId={siteId} work={work} observing={query.visible&&!query.error} controlPending={!ready||busy||Boolean(attempt)||blocked} onLockChange={setInstructionsLocked} onUpdated={instructionUpdated} onAccessDenied={setError}/>}/></>}
    {freshDraft&&<section ref={freshDraftElement} tabIndex={-1} aria-label="Fresh work draft"><NativeAgentWorkComposer siteId={siteId} initialDraft={freshDraft}/></section>}
  </div>;
}
