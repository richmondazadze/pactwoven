import { IdSchema } from '../../../../packages/contracts/src/core';
import { NativePaidEquipmentResponseSchema, type NativePaidEquipmentResponse } from '../../../../packages/contracts/src/native-paid-equipment';
import type { NativePaidToolView } from '../../../../packages/contracts/src/native-paid-tool';
import { RequestError, requestApiAtBase, type TokenSource } from './api';
import { getNativeApiBase } from './config';
import { agentWorkResponseScope, type AgentWorkScope } from './native-agent-work';

/** Display only server-verified equipment belonging to this exact recorded delivery. */
export function paidEquipmentMatchesReceipt(value: NativePaidEquipmentResponse, receipt: NativePaidToolView) {
  const result=receipt.delivery?.result,selection=value.selection;
  return receipt.state==='completed'&&receipt.resultApplicability==='current'&&result?.status==='feasible'&&selection!==null&&
    value.scope.environment===receipt.scope.environment&&value.scope.organizationId===receipt.scope.organizationId&&value.scope.siteId===receipt.scope.siteId&&
    value.rootTaskId===receipt.rootTaskId&&value.operationId===receipt.operationId&&value.instructionRevision===receipt.instructionRevision&&
    selection.status===result.status&&selection.catalogueHash===result.catalogueHash&&selection.requestHash===result.requestHash&&selection.totalMinor===result.totalMinor&&selection.items.length===result.selectedOfferIds.length&&
    selection.items.every(item=>result.selectedOfferIds.includes(item.id))&&
    selection.items.reduce((n,item)=>n+item.seats,0)===result.supplied?.seats&&
    selection.items.reduce((n,item)=>n+item.microphones,0)===result.supplied?.microphones&&
    selection.items.reduce((n,item)=>n+item.projectors,0)===result.supplied?.projectors;
}
export function paidEquipmentSelection(receipt:NativePaidToolView,value:unknown){
  const parsed=NativePaidEquipmentResponseSchema.safeParse(value);
  return parsed.success&&paidEquipmentMatchesReceipt(parsed.data,receipt)?parsed.data.selection:null;
}
export const paidEquipmentResponseSchema=(scope:AgentWorkScope,receipt:NativePaidToolView)=>NativePaidEquipmentResponseSchema.refine(value=>
  agentWorkResponseScope(scope,value)&&paidEquipmentMatchesReceipt(value,receipt));
export async function readPaidEquipment(receipt:NativePaidToolView,scope:AgentWorkScope,getToken:TokenSource,current:()=>AgentWorkScope,signal:AbortSignal){
  if(receipt.state!=='completed'||receipt.resultApplicability!=='current'||receipt.delivery?.result.status!=='feasible'||!agentWorkResponseScope(scope,receipt))throw new RequestError('EVIDENCE_STALE','Refresh the original receipt before checking its equipment.');
  const path=`/v1/agent-work/${encodeURIComponent(IdSchema.parse(receipt.rootTaskId))}/purchases/${encodeURIComponent(IdSchema.parse(receipt.operationId))}/equipment?siteId=${encodeURIComponent(IdSchema.parse(scope.siteId))}`;
  const check=()=>{const active=current();if(getNativeApiBase()!==scope.apiBase||Object.keys(scope).some(key=>scope[key as keyof AgentWorkScope]!==active[key as keyof AgentWorkScope]))throw new RequestError('SCOPE_CHANGED','Your workspace changed.');};
  signal.throwIfAborted();check();const value=await requestApiAtBase(scope.apiBase,path,paidEquipmentResponseSchema(scope,receipt),async()=>{check();return getToken();},{signal,beforeDispatch:()=>{check();return undefined;}});signal.throwIfAborted();check();return value;
}
