import {describe,it,expect} from 'vitest';
import {paidDemoCatalogue,paidDemoDefinition} from './demo-definition';
import {optimizeEquipment} from './equipment-optimizer';
import {encodeSolanaBase58} from '../../../packages/contracts/src/finance-provenance';
describe('fixed controlled equipment demo',()=>{
 it('finds the actual cheapest complete20-person package across63 combinations',async()=>{const result=await optimizeEquipment({seats:20,microphones:1,projectors:1,budgetMinor:50000},paidDemoCatalogue());expect(result).toMatchObject({status:'feasible',evaluatedPackages:63,totalMinor:27000,selectedOfferIds:['audio_pair','projection','seating_20']});});
 it('keeps recipient-bound allowlist and catalogue-bound delivery hashes stable',async()=>{const a=encodeSolanaBase58(new Uint8Array(32).fill(1)),b=encodeSolanaBase58(new Uint8Array(32).fill(2)),one=await paidDemoDefinition(a),two=await paidDemoDefinition(b);expect(await paidDemoDefinition(a)).toEqual(one);expect(one.resourceHash).toBe(two.resourceHash);expect(one.allowlistPolicy.hash).not.toBe(two.allowlistPolicy.hash);expect(one.deliveryPolicy).toEqual(two.deliveryPolicy);expect(one.priceBaseUnits).toBe('10000');});
});
