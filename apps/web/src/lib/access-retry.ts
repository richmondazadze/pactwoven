import { OperationSchema, type Operation, type Session } from '@pactwoven/contracts';
import { capsuleMatchesSession, observeOriginalIdentity, verifyAccessCapsule, type AccessCapsule, type CapsuleAuth } from './access-capsule';
import { apiRequest, RequestError, type TokenSource } from './api';
// This local limit only expires the UI confirmation. The service independently verifies both factors.
export const RETRY_REVIEW_LIFETIME_MS=240_000;
export function recoveryFailureKind(error:unknown):'verification-expired'|'scope-denied'|'unconfirmed' {
  if(error instanceof RequestError&&error.status===403&&error.code==='STEP_UP_REQUIRED')return 'verification-expired';
  return error instanceof RequestError&&[401,403].includes(error.status)?'scope-denied':'unconfirmed';
}
export type RecoveryPhase='check'|'checked'|'reviewed'|'verified'|'retrying';
export type RecoveryFlow={phase:RecoveryPhase;reviewedHash:string|null;verifiedAt:number|null};
export const initialRecoveryFlow:RecoveryFlow={phase:'check',reviewedHash:null,verifiedAt:null};
export type RecoveryEvent={type:'check-result'}|{type:'review';hash:string}|{type:'verified';at:number}|{type:'retry-click';now:number}|{type:'reset'}|{type:'verification-invalidated'};
export function recoveryFlow(state:RecoveryFlow,event:RecoveryEvent):RecoveryFlow {
  if(event.type==='reset')return initialRecoveryFlow;
  if(event.type==='check-result')return {phase:'checked',reviewedHash:null,verifiedAt:null};
  if(event.type==='review'&&state.phase==='checked')return {phase:'reviewed',reviewedHash:event.hash,verifiedAt:null};
  if(event.type==='verified'&&state.phase==='reviewed')return {...state,phase:'verified',verifiedAt:event.at};
  if(event.type==='verification-invalidated'&&['reviewed','verified'].includes(state.phase))return {...state,phase:'reviewed',verifiedAt:null};
  if(event.type==='retry-click'&&state.phase==='verified'&&retryVerificationCurrent(state.verifiedAt,event.now))return {...state,phase:'retrying'};
  return state;
}
export function retryVerificationCurrent(at:number|null,now=Date.now()) {return at!==null&&now>=at&&now-at<RETRY_REVIEW_LIFETIME_MS;}
export function originalOperation(operation:Operation,environment:Session['actor']['environment'],capsule:AccessCapsule|null=null) {
  if(operation.environment!==environment||operation.financialState!==null||(capsule&&capsule.original.kind!=='grant'&&operation.aggregateId!==capsule.original.targetActorId))throw new RequestError('RESPONSE_UNVERIFIED','The response does not match the original access request. Its outcome remains unknown.');
  return operation;
}
export type RetryContext={session:Session;auth:CapsuleAuth;apiBase:string|null};
export async function retryOriginalAccess(capsule:AccessCapsule,flow:RecoveryFlow,current:()=>RetryContext,getToken:TokenSource,signal:AbortSignal):Promise<Operation> {
  function assertCurrent() {
    signal.throwIfAborted();const context=current();
    if(!capsuleMatchesSession(capsule,context.session,context.auth,context.apiBase))throw new RequestError('RECOVERY_SCOPE_CHANGED','The current session no longer matches the original request.',403);
    if(flow.phase!=='retrying'||flow.reviewedHash!==capsule.integrityHash||!retryVerificationCurrent(flow.verifiedAt))throw new RequestError('RECOVERY_REVIEW_REQUIRED','Check the original result, review its exact request and verify both factors again.');
  }
  assertCurrent();
  const original=await verifyAccessCapsule(capsule,capsule.scope);
  const guardedToken=async()=>{assertCurrent();const token=await getToken();assertCurrent();return token;};
  await observeOriginalIdentity(original,guardedToken,signal);
  assertCurrent();
  // The only POST in recovery: an explicit retry click supplies its original frozen body and key.
  const operation=await apiRequest(original.original.path,OperationSchema,guardedToken,{body:original.original.command,idempotencyKey:original.key,signal});
  signal.throwIfAborted();
  return originalOperation(operation,original.scope.environment,original);
}
