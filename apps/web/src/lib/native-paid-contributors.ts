import { IdSchema } from '../../../../packages/contracts/src/core';
import { NativePaidContributorsSchema } from '../../../../packages/contracts/src/native-paid-contributors';
import type { NativePaidQuoteView } from '../../../../packages/contracts/src/native-paid-quote';
import { RequestError,requestApiAtBase,type TokenSource } from './api';
import { getNativeApiBase } from './config';
import { agentWorkResponseScope,type AgentWorkScope } from './native-agent-work';

export const paidContributorsResponseSchema=(scope:AgentWorkScope,rootTaskId:string,controlVersion:number,quote:NativePaidQuoteView)=>NativePaidContributorsSchema.refine(value=>
  agentWorkResponseScope(scope,value)&&value.rootTaskId===rootTaskId&&value.controlVersion===controlVersion&&value.instructionRevision===quote.instructionRevision&&
  Date.parse(value.observedAt)<=Date.now()&&
  (value.state!=='recorded'||value.quoteId===quote.quoteId&&value.availableUntil!==null&&Date.parse(value.availableUntil)>Date.now()));
export async function readPaidContributors(scope:AgentWorkScope,rootTaskId:string,controlVersion:number,quote:NativePaidQuoteView,getToken:TokenSource,current:()=>AgentWorkScope,signal:AbortSignal){
  if(!agentWorkResponseScope(scope,quote)||quote.rootTaskId!==rootTaskId||Date.parse(quote.reviewBy)<=Date.now())throw new RequestError('EVIDENCE_STALE','Refresh this quote before checking its contributors.');
  const path=`/v1/agent-work/${encodeURIComponent(IdSchema.parse(rootTaskId))}/equipment/contributors?siteId=${encodeURIComponent(IdSchema.parse(scope.siteId))}`;
  const check=()=>{const active=current();if(getNativeApiBase()!==scope.apiBase||Object.keys(scope).some(key=>scope[key as keyof AgentWorkScope]!==active[key as keyof AgentWorkScope]))throw new RequestError('SCOPE_CHANGED','Your workspace changed.');};
  signal.throwIfAborted();check();const result=await requestApiAtBase(scope.apiBase,path,paidContributorsResponseSchema(scope,rootTaskId,controlVersion,quote),async()=>{check();return getToken();},{signal,beforeDispatch:()=>{check();return undefined;}});signal.throwIfAborted();check();return result;
}
