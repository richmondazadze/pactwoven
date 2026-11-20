import {NativePaidHistoryResponseSchema} from '../../../../packages/contracts/src/native-paid-history';
import {paidToolFixture} from './native-paid-tool.test-fixtures';
import {paidEquipmentFixture} from './native-paid-equipment.test-fixtures';
export function paidHistoryFixture(){
 const receipt=paidToolFixture();return NativePaidHistoryResponseSchema.parse({kind:'recorded',scope:receipt.scope,rootTaskId:receipt.rootTaskId,operationId:receipt.operationId,instructionRevision:receipt.instructionRevision,
  completedAt:'2026-11-19T16:00:10Z',evidenceValidUntil:'2026-11-19T16:01:00Z',freshness:'historical',authority:'none',sourcePolicy:'public_or_operator_only_v1',
  advice:{title:'Workshop equipment recommendation',summary:'Use the saved seating and presentation package for this workshop.',artifacts:[{id:'hidden-artifact',title:'Preparation checklist',text:'Confirm the room layout, test the projector and arrange seating.'}]},equipment:paidEquipmentFixture().selection,
  payment:{signature:receipt.transaction!.signature,amountBaseUnits:receipt.amount.baseUnits,feeLamports:'5000',finalizedAt:receipt.transaction!.finalizedAt,slot:receipt.transaction!.slot},
  provenance:{completionDigest:'c'.repeat(64),requestHash:'a'.repeat(64),resourceHash:'d'.repeat(64),resultHash:'e'.repeat(64),catalogue:'controlled_demo_catalogue',sources:[{url:'https://example.com/workshop',observedAt:'2026-11-19T16:00:00Z',validUntil:'2026-11-19T16:01:00Z'}]}});
}
