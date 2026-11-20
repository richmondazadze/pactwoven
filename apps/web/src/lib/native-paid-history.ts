import {IdSchema} from '../../../../packages/contracts/src/core';
import {NativePaidHistoryResponseSchema,type NativePaidHistoryResponse} from '../../../../packages/contracts/src/native-paid-history';
import type {NativePaidToolView} from '../../../../packages/contracts/src/native-paid-tool';
import {RequestError,requestApiAtBase,type TokenSource} from './api';
import {getNativeApiBase} from './config';
import {agentWorkResponseScope,type AgentWorkScope} from './native-agent-work';

export function paidHistoryMatchesReceipt(value:NativePaidHistoryResponse,receipt:NativePaidToolView){
 if(receipt.state!=='completed'||value.scope.environment!==receipt.scope.environment||value.scope.organizationId!==receipt.scope.organizationId||value.scope.siteId!==receipt.scope.siteId||value.rootTaskId!==receipt.rootTaskId||value.operationId!==receipt.operationId)return false;
 if(value.kind==='unavailable')return true;
 const result=receipt.delivery?.result,selection=value.equipment;
 if(result&&(selection.requestHash!==result.requestHash||selection.catalogueHash!==result.catalogueHash||selection.status!==result.status||selection.totalMinor!==result.totalMinor||selection.items.length!==result.selectedOfferIds.length||selection.items.some(item=>!result.selectedOfferIds.includes(item.id))||result.status==='feasible'&&(['seats','microphones','projectors'] as const).some(key=>selection.items.reduce((n,item)=>n+item[key],0)!==result.supplied?.[key])))return false;
 return value.instructionRevision===receipt.instructionRevision&&receipt.transaction?.state==='finalized'&&
  value.payment.signature===receipt.transaction.signature&&value.payment.amountBaseUnits===receipt.amount.baseUnits&&
  value.payment.slot===receipt.transaction.slot&&Date.parse(value.payment.finalizedAt)===Date.parse(receipt.transaction.finalizedAt!)&&
  (!receipt.feePaid||value.payment.feeLamports===receipt.feePaid.baseUnits);
}
export function paidHistoryRecord(receipt:NativePaidToolView,value:unknown){
 const parsed=NativePaidHistoryResponseSchema.safeParse(value);
 return parsed.success&&parsed.data.kind==='recorded'&&paidHistoryMatchesReceipt(parsed.data,receipt)?parsed.data:null;
}
export const paidHistoryResponseSchema=(scope:AgentWorkScope,receipt:NativePaidToolView)=>NativePaidHistoryResponseSchema.refine(value=>agentWorkResponseScope(scope,value)&&paidHistoryMatchesReceipt(value,receipt));
export async function readPaidHistory(receipt:NativePaidToolView,scope:AgentWorkScope,getToken:TokenSource,current:()=>AgentWorkScope,signal:AbortSignal){
 if(receipt.state!=='completed'||!agentWorkResponseScope(scope,receipt))throw new RequestError('EVIDENCE_STALE','Refresh the original receipt before checking its saved result.');
 const path=`/v1/agent-work/${encodeURIComponent(IdSchema.parse(receipt.rootTaskId))}/purchases/${encodeURIComponent(IdSchema.parse(receipt.operationId))}/history?siteId=${encodeURIComponent(IdSchema.parse(scope.siteId))}`;
 const check=()=>{const active=current();if(getNativeApiBase()!==scope.apiBase||Object.keys(scope).some(key=>scope[key as keyof AgentWorkScope]!==active[key as keyof AgentWorkScope]))throw new RequestError('SCOPE_CHANGED','Your workspace changed.');};
 signal.throwIfAborted();check();const result=await requestApiAtBase(scope.apiBase,path,paidHistoryResponseSchema(scope,receipt),async()=>{check();return getToken();},{signal,beforeDispatch:()=>{check();return undefined;}});signal.throwIfAborted();check();return result;
}
