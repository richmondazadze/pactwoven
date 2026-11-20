import { vi } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import { commandDigest } from '../../../packages/contracts/src/canonical';
import { FINANCE_DEVNET_ASSET, encodeSolanaBase58 } from '../../../packages/contracts/src/finance-provenance';
import { equipmentRequestHash, equipmentResourceHash, optimizeEquipment } from '../../paid-tools/src/equipment-optimizer';
import { paidDemoCatalogue } from '../../paid-tools/src/demo-definition';
import { paidToolChallengeHash } from '../../paid-tools/src/quote-binding';
import { NativePaidEquipmentService } from './native-paid-equipment-service';

export async function equipmentReceiptFixture(budgetMinor = 50000) {
  const at='2026-11-19T16:00:00Z', now='2026-11-19T16:01:00Z', hash='a'.repeat(64);
  const key=(n:number)=>encodeSolanaBase58(new Uint8Array(32).fill(n));
  const signature=encodeSolanaBase58(new Uint8Array(64).fill(8));
  const session:Session={actor:{actorId:'human',principalKind:'human',environment:'development',organizationId:'org',roles:['owner'],siteIds:['site'],actionSiteIds:['site'],sessionId:'session',authenticatedAt:at,correlationId:'test'},organization:{id:'org',name:'Company',authorityEpoch:1},sites:[{id:'site',name:'Site',timeZone:'America/Chicago'}]};
  const request={seats:60,microphones:2,projectors:1,budgetMinor}, catalogue=paidDemoCatalogue();
  const requestHash=await equipmentRequestHash(request),resourceHash=await equipmentResourceHash(catalogue), result=await optimizeEquipment(request,catalogue);
  const payee={id:'payee',version:1,environment:'development',network:'solana-devnet',recipient:key(4),assetId:'devnet_usdc',mint:FINANCE_DEVNET_ASSET.mint,tokenProgram:FINANCE_DEVNET_ASSET.tokenProgram,verificationRef:'fixed_payee'};
  const challenge={id:'quote',providerId:'equipment_optimizer_v1',resourceHash,requestHash,payee,amountBaseUnits:'10000',expiresAt:'2026-11-19T16:05:00Z'};
  const ref={id:'policy',version:1,hash};
  const quote={rootTaskId:'root',quoteId:'quote',instructionRevision:0,quote:{providerId:'equipment_optimizer_v1',resource:{...ref,hash:resourceHash},request:{...ref,hash:requestHash},challenge:{...challenge,hash:await paidToolChallengeHash(challenge as never)},allowlistPolicy:ref,deliveryPolicy:ref},requestBody:request,resourceBody:catalogue,reason:'Compare equipment.',assumptions:[]};
  const review={id:'review',organizationId:'org',siteId:'site',rootTaskId:'root',instructionRevision:0,quoteId:'quote',quoteHash:quote.quote.challenge.hash,providerId:'equipment_optimizer_v1',amountBaseUnits:'10000',maximumFeeLamports:'10000',sourceAccount:key(1),sourceOwner:key(2),feePayer:key(2),destinationAccount:key(3),destinationOwner:key(4),...FINANCE_DEVNET_ASSET,expiresAt:challenge.expiresAt,reviewHash:hash};
  const message={messageHash:hash,messageBase64:'private-synthetic-message',currentBlockHeight:'100',heightObservedAt:at,heightEvidenceRef:'private-height',heightEvidenceHash:hash,blockhash:key(5),lastValidBlockHeight:'200',feeLamports:'5000',sourceObservationId:'private-source',feeObservationId:'private-fee'};
  const attempt={id:'private-attempt',messageHash:hash,wireHash:hash,signature,blockhash:key(5),lastValidBlockHeight:'200'};
  const payment={status:'finalized_transfer',signature,slot:'123',observedAt:now,...FINANCE_DEVNET_ASSET,sourceAccount:key(1),sourceOwner:key(2),destinationAccount:key(3),destinationOwner:key(4),amountBaseUnits:'10000',feeLamports:'5000',messageHash:hash,transactionEvidenceRef:'private-transaction',transactionEvidenceHash:hash,statusEvidenceRef:'private-status',statusEvidenceHash:hash};
  const snapshot={operationId:'operation',version:8,status:'completed',approvedAt:at,revokedAt:null,review,message,attempt,payment,
    delivery:{artifactRef:'private-artifact',resultHash:await commandDigest({namespace:'pactwoven.paid-tools.delivery.v1',result}),requestHash,resourceHash,paymentSignature:signature,verifiedAt:now,resultBody:result},currentInstructionRevision:0,evidenceAvailable:true};
  const roots={quote:vi.fn(async()=>quote)},human={read:vi.fn(async()=>snapshot)};
  return {session,quote,snapshot,roots,human,now,service:new NativePaidEquipmentService(roots as never,human as never,()=>now)};
}
