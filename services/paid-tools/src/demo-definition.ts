import {commandDigest} from '../../../packages/contracts/src/canonical';
import {FINANCE_DEVNET_ASSET,SolanaPublicKeySchema} from '../../../packages/contracts/src/finance-provenance';
import {parseEquipmentCatalogue,equipmentResourceHash} from './equipment-optimizer';
/** Controlled sample inventory. USD estimates are unrelated to the separate
 * 0.01 devnet USDC computation fee; nothing here places an equipment order. */
export const paidDemoCatalogue=()=>parseEquipmentCatalogue({version:1,currency:'USD',provenance:'controlled_demo_catalogue',offers:[
 {id:'seating_20',label:'20-seat package',seats:20,microphones:0,projectors:0,priceMinor:9000},
 {id:'seating_40',label:'40-seat package',seats:40,microphones:0,projectors:0,priceMinor:16500},
 {id:'audio_pair',label:'Two wireless microphones',seats:0,microphones:2,projectors:0,priceMinor:7000},
 {id:'projection',label:'Projector and screen',seats:0,microphones:0,projectors:1,priceMinor:11000},
 {id:'workshop_20',label:'20-person workshop package',seats:20,microphones:1,projectors:0,priceMinor:22000},
 {id:'workshop_60',label:'60-person workshop package',seats:60,microphones:2,projectors:1,priceMinor:56000},
]});
export async function paidDemoDefinition(destinationOwner:string){
 const recipient=SolanaPublicKeySchema.parse(destinationOwner),catalogue=paidDemoCatalogue(),resourceHash=await equipmentResourceHash(catalogue);
 const allowlist={namespace:'pactwoven.paid-demo.allowlist.v1',service:'equipment_optimizer_v1',recipient,...FINANCE_DEVNET_ASSET,resourceHash,maximumPriceBaseUnits:'10000',maximumFeeLamports:'10000'};
 const delivery={namespace:'pactwoven.paid-demo.delivery.v1',service:'equipment_optimizer_v1',resourceHash,computation:'minimum_total_then_fewest_offers_then_sorted_ids',requires:'exact_finalized_original_transfer',redemption:'once_per_original_signature'};
 return {catalogue,resourceHash,priceBaseUnits:'10000',maximumFeeLamports:'10000',
  payee:{id:'paid_demo_payee_v1',version:1,environment:'development' as const,network:'solana-devnet',recipient,assetId:'devnet_usdc',mint:FINANCE_DEVNET_ASSET.mint,tokenProgram:FINANCE_DEVNET_ASSET.tokenProgram,verificationRef:'paid_demo_devnet_enrollment_v1'},
  allowlistPolicy:{id:'paid_demo_allowlist_v1',version:1,hash:await commandDigest(allowlist)},deliveryPolicy:{id:'paid_demo_delivery_v1',version:1,hash:await commandDigest(delivery)}};
}
