import { z } from 'zod';
import { IdSchema, MandateCollectionQuerySchema, MandatePageSchema, MandateReviewQuerySchema, MandateReviewSchema, type MandateEffectiveAuthority, type MandatePage, type MandatePolicy, type MandateProposalVersion, type MandateReview, type MandateSummary, type PolicyDocumentVersion, type Responsibility, type Session } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from '@pactwoven/contracts/canonical';
import { getApiBase } from './config';
import { apiRequest, RequestError, type TokenSource } from './api';

export const MANDATE_OBSERVATION_LIFETIME_MS=60_000;
export type MandateReadScope={userId:string;externalOrganizationId:string;sessionId:string;apiBase:string;organizationId:string;environment:Session['actor']['environment'];actorId:string;organizationEpoch:number;principalKind:Session['actor']['principalKind'];roles:string[];siteIds:string[];actionSiteIds:string[];responsibilityId:string};
export function createMandateReadScope(session:Session,auth:{userId?:string|null|undefined;orgId?:string|null|undefined;sessionId?:string|null|undefined},apiBase:string|null,responsibilityId:string):MandateReadScope {
  if(!auth.userId||!auth.orgId||!auth.sessionId)throw new RequestError('SESSION_REQUIRED','A current organization session is required.',401);
  if(!apiBase)throw new RequestError('API_NOT_CONFIGURED','The workspace service is not connected yet.');
  if(session.actor.organizationId!==session.organization.id)throw new RequestError('RESPONSE_UNVERIFIED','The current organization scope could not be verified.');
  return {userId:auth.userId,externalOrganizationId:auth.orgId,sessionId:auth.sessionId,apiBase,organizationId:session.organization.id,environment:session.actor.environment,actorId:session.actor.actorId,organizationEpoch:session.organization.authorityEpoch,principalKind:session.actor.principalKind,roles:[...session.actor.roles],siteIds:[...session.actor.siteIds],actionSiteIds:[...session.actor.actionSiteIds],responsibilityId:IdSchema.parse(responsibilityId)};
}
export const mandateScopeKey=(scope:MandateReadScope)=>canonicalJson(scope);
export const mandateQueryKey=(scope:MandateReadScope,selection:{cursor:string}|{proposalId:string;version:number})=>['mandates',mandateScopeKey(scope),'cursor'in selection?'collection':'review',selection] as const;
export function mandateCollectionPath(responsibilityId:string,cursor='') {const query=MandateCollectionQuerySchema.parse({limit:25,...(cursor?{cursor}:{})});return `/v1/responsibilities/${IdSchema.parse(responsibilityId)}/mandates?limit=25${query.cursor?`&cursor=${encodeURIComponent(query.cursor)}`:''}`;}
export function mandateReviewPath(responsibilityId:string,proposalId:string,version:unknown) {const query=MandateReviewQuerySchema.parse({version});return `/v1/responsibilities/${IdSchema.parse(responsibilityId)}/mandates/${IdSchema.parse(proposalId)}?version=${query.version}`;}
export const mandateCollectionHref=(id:string)=>`/app/responsibilities/${IdSchema.parse(id)}/mandates`;
export function mandateProposalHref(id:string,proposalId:string,version:number) {const query=MandateReviewQuerySchema.parse({version});return `${mandateCollectionHref(id)}/${IdSchema.parse(proposalId)}/versions/${query.version}`;}
export function nextMandateCursors(cursors:string[],next:string) {MandateCollectionQuerySchema.parse({cursor:next});if(cursors.includes(next))throw new RequestError('CURSOR_UNVERIFIED','The service repeated a page reference. Refresh this collection before continuing.');return [...cursors,next];}
const sameReference=(a:{id:string;version:number;hash:string},b:{id:string;version:number;hash:string})=>a.id===b.id&&a.version===b.version&&a.hash===b.hash;
function need(value:unknown):asserts value {if(!value)throw new RequestError('MANDATE_RESPONSE_UNVERIFIED','The mandate response does not match this review or its complete historical records. Refresh to obtain a verified observation.');}
function consistentDecision(recorded:string,effective:string) {return recorded==='OPEN'?['OPEN','EXPIRED','STALE'].includes(effective):recorded===effective;}
function recordInScope(record:Responsibility,scope:MandateReadScope) {return record.id===scope.responsibilityId&&record.organizationId===scope.organizationId&&record.environment===scope.environment;}
function headInScope(value:MandatePage['head'],scope:MandateReadScope) {return !value||(value.organizationId===scope.organizationId&&value.environment===scope.environment&&value.responsibilityId===scope.responsibilityId);}
function adviseOnly(policy:MandatePolicy,siteId:string) {return policy.mode==='ADVISE'&&policy.siteIds.length===1&&policy.siteIds[0]===siteId&&!policy.actions.length&&!policy.budgets.length&&!policy.supplierRelationshipIds.length&&!policy.communication.recipientIds.length&&!policy.communication.purposes.length&&!policy.communication.messageKinds.length&&policy.communication.maximumMessages===0;}
async function checkResponsibility(record:Responsibility,reference:MandatePage['responsibilityReference']) {need(record.id===reference.id&&record.version===reference.version&&record.siteId===reference.siteId&&await commandDigest(record)===reference.hash);}
function checkEffectiveAuthority(authority:MandateEffectiveAuthority,head:MandatePage['head'],organizationEpoch:number,observedAt:string) {
  if(!head){need(authority.state==='NONE');return;}
  need(authority.state!=='NONE');
  if(authority.state==='ACTIVE')need(head.state==='ACTIVE'&&head.organizationEpoch===organizationEpoch&&Date.parse(head.expiresAt)>Date.parse(observedAt));
  if(authority.state==='PAUSED')need(head.state==='PAUSED');
  if(head.state==='REVOKED')need(authority.state==='REVOKED');
  if(head.state==='EXPIRED')need(authority.state==='EXPIRED'||authority.state==='REVOKED');
}
export async function qualifyMandatePage(input:unknown,scope:MandateReadScope,cursor=''):Promise<MandatePage> {
  const page=MandatePageSchema.parse(input);
  need(page.organizationId===scope.organizationId&&page.environment===scope.environment&&recordInScope(page.responsibility,scope)&&page.site.id===page.responsibility.siteId&&headInScope(page.head,scope));
  await checkResponsibility(page.responsibility,page.responsibilityReference);
  need(page.nextCursor===null||page.nextCursor!==cursor);
  need(new Set(page.items.map(item=>item.proposal.id)).size===page.items.length);
  for(const item of page.items){need(consistentDecision(item.decisionState,item.effectiveDecisionState));if(item.effectiveDecisionState==='OPEN')need(canonicalJson(item.responsibility)===canonicalJson(page.responsibilityReference)&&Date.parse(item.expiresAt)>Date.parse(page.observedAt));need(item.responsibility.id===scope.responsibilityId&&item.responsibility.version<=page.responsibility.version);if(item.responsibility.version===page.responsibility.version)need(canonicalJson(item.responsibility)===canonicalJson(page.responsibilityReference));}
  if(page.acceptedVersion)need(page.head&&page.acceptedVersion.id===page.head.mandateId&&page.acceptedVersion.version===page.head.mandateVersion);
  checkEffectiveAuthority(page.effectiveAuthority,page.head,page.organizationEpoch,page.observedAt);return page;
}
export function proposalResponsibility(review:MandateReview,proposal:MandateProposalVersion):Responsibility {const record=review.responsibilityVersions.find(value=>value.id===proposal.responsibility.id&&value.version===proposal.responsibility.version);need(record);return record;}
export function proposalDocument(review:MandateReview,proposal:MandateProposalVersion,purpose:PolicyDocumentVersion['purpose']) {const ref=purpose==='ACCEPTANCE_POLICY'?proposal.policy.acceptancePolicy:proposal.policyDocument;const document=review.envelope.policyDocuments.find(value=>sameReference(value,ref)&&value.purpose===purpose);need(document);return document;}
export async function qualifyMandateReview(input:unknown,scope:MandateReadScope,proposalId:string,version:number):Promise<MandateReview> {
  const review=MandateReviewSchema.parse(input),e=review.envelope;
  need(recordInScope(e.responsibility,scope)&&e.site.id===e.responsibility.siteId&&headInScope(e.head,scope)&&e.financialState===null);
  need(e.proposal&&e.proposal.id===proposalId&&e.proposal.version===version&&e.decision&&review.effectiveDecisionState&&consistentDecision(e.decision.state,review.effectiveDecisionState));
  need(!e.operation||(e.operation.environment===scope.environment&&e.operation.financialState===null));
  await checkResponsibility(e.responsibility,e.responsibilityReference);
  const expectedRecords=new Set([`${e.responsibility.id}:${e.responsibility.version}`,...[e.proposal,e.acceptedProposal].flatMap(p=>p?[`${p.responsibility.id}:${p.responsibility.version}`]:[])]);
  need(review.responsibilityVersions.length===expectedRecords.size);
  for(const record of review.responsibilityVersions)need(recordInScope(record,scope)&&expectedRecords.has(`${record.id}:${record.version}`)&&record.version<=e.responsibility.version);
  need(review.responsibilityVersions.some(record=>canonicalJson(record)===canonicalJson(e.responsibility)));
  const documentRefs=new Set<string>();
  for(const proposal of [e.proposal,e.acceptedProposal]){
    if(!proposal)continue;
    need(proposal.organizationId===scope.organizationId&&proposal.environment===scope.environment&&proposal.responsibility.id===scope.responsibilityId&&proposal.organizationEpoch<=e.organizationEpoch&&adviseOnly(proposal.policy,proposal.responsibility.siteId));
    const {hash,...body}=proposal;need(await commandDigest(body)===hash&&await commandDigest(proposal.policy)===proposal.policyHash);
    const historical=proposalResponsibility(review,proposal);await checkResponsibility(historical,proposal.responsibility);
    const decision=proposal===e.proposal?e.decision:e.acceptedDecision;need(decision);if(decision.authorization)need(decision.authorization.requesterId===proposal.requesterId&&decision.actorId!==proposal.requesterId);
    for(const purpose of ['ACCEPTANCE_POLICY','MANDATE_POLICY'] as const){const document=proposalDocument(review,proposal,purpose);documentRefs.add(`${document.id}:${document.version}`);need(document.organizationId===scope.organizationId&&document.environment===scope.environment);const {hash:documentHash,...documentBody}=document;need(document.text===document.text.normalize('NFC').replace(/\r\n?/g,'\n')&&await commandDigest(document.text)===document.contentHash&&await commandDigest(documentBody)===documentHash);if(purpose==='ACCEPTANCE_POLICY')need(document.text===historical.acceptancePolicy.normalize('NFC').replace(/\r\n?/g,'\n'));}
  }
  need(documentRefs.size===e.policyDocuments.length);
  if(e.acceptedVersion){
    const accepted=e.acceptedVersion;need(e.acceptedProposal&&e.acceptedDecision?.authorization&&e.head&&accepted.organizationId===scope.organizationId&&accepted.environment===scope.environment&&accepted.responsibilityId===scope.responsibilityId&&accepted.id===e.acceptedProposal.mandateId&&accepted.organizationEpoch===e.acceptedProposal.organizationEpoch&&canonicalJson(accepted.policy)===canonicalJson(e.acceptedProposal.policy)&&accepted.policyHash===e.acceptedProposal.policyHash&&accepted.policyHash===e.head.policyHash&&accepted.policy.expiresAt===e.head.expiresAt);
    need(accepted.createdBy===e.acceptedProposal.requesterId&&accepted.createdAt===e.acceptedDecision.authorization.approvedAt&&e.head.organizationEpoch===accepted.organizationEpoch&&e.head.mandateEpoch>=accepted.mandateEpoch);
    const ref=e.acceptedDecision.authorization.acceptedVersion;need(ref.id===accepted.id&&ref.version===accepted.version&&ref.hash===await commandDigest(accepted));
    const initialHead={...e.head,state:'ACTIVE' as const,mandateEpoch:accepted.mandateEpoch};const receiptHead=e.acceptedDecision.authorization.acceptedHead;
    need(receiptHead.mandateId===initialHead.mandateId&&receiptHead.mandateVersion===initialHead.mandateVersion&&receiptHead.mandateEpoch===initialHead.mandateEpoch&&receiptHead.hash===await commandDigest(initialHead));
    if(review.effectiveAuthority.state==='ACTIVE'||review.effectiveAuthority.state==='PAUSED')need(canonicalJson(e.acceptedProposal.responsibility)===canonicalJson(e.responsibilityReference)&&e.acceptedProposal.organizationEpoch===e.organizationEpoch);
  }
  if(review.effectiveDecisionState==='OPEN'){
    need(canonicalJson(e.proposal.responsibility)===canonicalJson(e.responsibilityReference)&&e.proposal.organizationEpoch===e.organizationEpoch&&Date.parse(e.proposal.expiresAt)>Date.parse(e.observedAt));
    const currentHead=e.head?{mandateId:e.head.mandateId,mandateVersion:e.head.mandateVersion,mandateEpoch:e.head.mandateEpoch,hash:await commandDigest(e.head)}:null;
    need(canonicalJson(e.proposal.expectedHead)===canonicalJson(currentHead));
  }
  checkEffectiveAuthority(review.effectiveAuthority,e.head,e.organizationEpoch,e.observedAt);return review;
}
export type MandateObservation<T>={data:T;receivedAt:number;receivedMonotonic:number};
function assertReadScope(scope:MandateReadScope,current:()=>MandateReadScope|null,signal:AbortSignal) {signal.throwIfAborted();const latest=current();if(!latest||getApiBase()!==scope.apiBase||mandateScopeKey(scope)!==mandateScopeKey(latest))throw new RequestError('MANDATE_SCOPE_CHANGED','The organization, session or selected record changed. The earlier observation has been discarded.');}
async function observe<T>(scope:MandateReadScope,current:()=>MandateReadScope|null,signal:AbortSignal,getToken:TokenSource,path:string,schema:z.ZodType<T>,qualify:(input:T)=>Promise<T>):Promise<MandateObservation<T>> {
  assertReadScope(scope,current,signal);
  const guardedToken=async()=>{assertReadScope(scope,current,signal);const token=await getToken();assertReadScope(scope,current,signal);return token;};
  const response=await apiRequest(path,schema,guardedToken,{signal});assertReadScope(scope,current,signal);const data=await qualify(response);assertReadScope(scope,current,signal);return {data,receivedAt:Date.now(),receivedMonotonic:performance.now()};
}
export const readMandatePage=(scope:MandateReadScope,current:()=>MandateReadScope|null,signal:AbortSignal,getToken:TokenSource,cursor='')=>observe(scope,current,signal,getToken,mandateCollectionPath(scope.responsibilityId,cursor),MandatePageSchema,value=>qualifyMandatePage(value,scope,cursor));
export const readMandateReview=(scope:MandateReadScope,current:()=>MandateReadScope|null,signal:AbortSignal,getToken:TokenSource,proposalId:string,version:number)=>observe(scope,current,signal,getToken,mandateReviewPath(scope.responsibilityId,proposalId,version),MandateReviewSchema,value=>qualifyMandateReview(value,scope,proposalId,version));
export function mandateObservationTime(observedAt:string,observation:Pick<MandateObservation<unknown>,'receivedAt'|'receivedMonotonic'>,wall=Date.now(),monotonic=performance.now()) {return Math.max(wall,Date.parse(observedAt)+Math.max(0,wall-observation.receivedAt,monotonic-observation.receivedMonotonic));}
export function displayedAuthority(authority:MandateEffectiveAuthority,head:MandatePage['head'],observedAt:string,now:number,organizationEpoch:number):MandateEffectiveAuthority {
  if(authority.state==='REVOKED'||authority.state==='EXPIRED')return authority;
  if(head&&Date.parse(head.expiresAt)<=now)return {state:'EXPIRED',blockers:['AUTHORITY_EXPIRED']};
  if(Date.parse(observedAt)+MANDATE_OBSERVATION_LIFETIME_MS<=now)return {state:'STALE',blockers:['OBSERVATION_STALE']};
  if(head&&head.organizationEpoch!==organizationEpoch)return {state:'STALE',blockers:['ORGANIZATION_CHANGED']};
  return authority;
}
export function displayedDecision(item:Pick<MandateSummary,'decisionState'|'effectiveDecisionState'|'expiresAt'>,now:number,observedAt?:string,current=true) {if(item.decisionState==='OPEN'){if(Date.parse(item.expiresAt)<=now)return 'EXPIRED';if(!current||(observedAt&&Date.parse(observedAt)+MANDATE_OBSERVATION_LIFETIME_MS<=now))return 'STALE';}return item.effectiveDecisionState;}
const blockers:Record<string,string>={NO_AUTHORITY:'No mandate has been accepted.',NO_ACCEPTED_MANDATE:'No mandate has been accepted.',AUTHORITY_REVOKED:'Authority has been revoked.',AUTHORITY_PAUSED:'Authority is paused.',AUTHORITY_EXPIRED:'The authority expiry has been reached.',OBSERVATION_STALE:'This observation needs refreshing before current authority can be shown.',ORGANIZATION_CHANGED:'Organization authority has changed.',RESPONSIBILITY_CHANGED:'The responsibility has changed since these terms were accepted.',SITE_UNAVAILABLE:'The site is not currently available.',REQUESTER_INELIGIBLE:'The requester no longer meets the current requirements.',INDEPENDENT_APPROVER_REQUIRED:'A different qualified reviewer is required.',ACCEPTANCE_POLICY_REQUIRED:'The responsibility needs an acceptance policy.',AUTHORITY_TERMINAL:'This authority can no longer be resumed.',AUTHORITY_CHANGED:'The current authority differs from the reviewed version.',NO_PROPOSAL:'Select a proposal to view its review requirements.',FORBIDDEN:'The current member does not have the required authority.',DECISION_CLOSED:'This proposal already has a recorded decision.',DECISION_TERMINAL:'This proposal is no longer open for a decision. Review its recorded outcome.',PROPOSAL_EXPIRED:'The proposal review deadline has passed.',PROPOSAL_STALE:'A fresh proposal is required because its reviewed basis changed.'};
export const mandateBlockerText=(code:string)=>blockers[code]??'The service reported an additional review requirement. Its exact code is available in the reference details.';
export function mandateReadError(error:unknown) {const status=error instanceof RequestError?error.status:0;return {title:status===401?'Sign-in needs attention':status===403?'Mandate access is unavailable':status===404?'This mandate record was not found':error instanceof RequestError&&error.code==='API_NOT_CONFIGURED'?'Mandate service is not connected':'The mandate observation is unavailable',detail:status===401||status===403?'Private mandate information is hidden while current organization access is checked.':status===404?'The selected responsibility or exact proposal version could not be read in this scope.':error instanceof RequestError?error.message:'Refresh the observation to check the service again.'};}
