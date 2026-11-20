import { describe, expect, it } from 'vitest';
import { decodeSolanaBase58, encodeSolanaBase58, FINANCE_DEVNET_ASSET, type FinanceProvenanceAppend } from '@pactwoven/contracts';
import { physicalAccountEffectKey, physicalAccountKey, physicalAssetKey, physicalTransferKey, prepareProvenanceAppend,
  provenanceHex, decodeProvenanceTokenAccount, transferDirection, transferFactDigest, transferFactsEqual } from './finance-provenance';

const address=(n:number)=>encodeSolanaBase58(new Uint8Array(32).fill(n));
const locator={genesis:FINANCE_DEVNET_ASSET.genesis,signature:encodeSolanaBase58(new Uint8Array(64).fill(7)),outerInstructionIndex:2,innerInstructionOrdinal:null};
const fact={locator,asset:FINANCE_DEVNET_ASSET,source:address(2),destination:address(3),amountBaseUnits:'10',instructionKind:'TransferChecked' as const,checkedDecimals:6 as const,instructionDataHash:'a'.repeat(64)};
const evidence={reference:'fixture:inert',sha256:'a'.repeat(64)};
async function input(): Promise<FinanceProvenanceAppend> {
  const bytes=new Uint8Array(165);bytes.set(decodeSolanaBase58(FINANCE_DEVNET_ASSET.mint,32));bytes.set(new Uint8Array(32).fill(2),32);new DataView(bytes.buffer).setBigUint64(64,100n,true);bytes[108]=1;
  const payload=new TextEncoder().encode('synthetic payload');
  return {schemaVersion:1,source:{id:'source_a',version:1},asset:{key:await physicalAssetKey(FINANCE_DEVNET_ASSET),version:1},account:{key:await physicalAccountKey({genesis:locator.genesis,address:address(3)}),version:1},
    deliveryKey:'delivery_one',adapterVersion:'adapter',normalizerVersion:'normalizer',payloadHex:provenanceHex(payload),payloadHash:provenanceHex(new Uint8Array(await crypto.subtle.digest('SHA-256',payload))),evidence,providerMetadata:{},
    observation:{kind:'balance',context:{observedAt:'2026-11-15T00:00:00Z',slot:'18446744073709551615',commitment:'finalized',blockHash:null,evidence},amountBaseUnits:'100',accountDataHex:provenanceHex(bytes)}};
}
describe('inert physical provenance',()=>{
  it('reproduces the independently pinned physical asset key',async()=>expect(await physicalAssetKey(FINANCE_DEVNET_ASSET)).toBe('34ee730cf90d3d55ea2d34e911aa4ad941aafb29668bf4056cfa88c6cf0492e4'));
  it('excludes tenant, registry version and provider from physical keys',async()=>{
    const base={genesis:locator.genesis,address:address(3)};const key=await physicalAccountKey(base);
    expect(await physicalAccountKey({...base})).toBe(key);expect(await physicalAccountKey({...base,address:address(4)})).not.toBe(key);
    expect(await physicalAccountKey({...base,genesis:address(5)})).not.toBe(key);
  });
  it('domain separates outer, inner zero, transaction and account effects',async()=>{
    const keys=await Promise.all([physicalTransferKey(locator),physicalTransferKey({...locator,innerInstructionOrdinal:0}),physicalTransferKey({...locator,outerInstructionIndex:3}),physicalTransferKey({...locator,signature:'1'.repeat(64)})]);expect(new Set(keys).size).toBe(4);
    expect(await physicalAccountEffectKey(locator,{genesis:locator.genesis,address:address(2)})).not.toBe(await physicalAccountEffectKey(locator,{genesis:locator.genesis,address:address(3)}));
  });
  it('one locator has one immutable fact digest, independent of observational finality',async()=>{
    expect(transferFactsEqual(fact,{...fact})).toBe(true);expect(await transferFactDigest({...fact,amountBaseUnits:'11'})).not.toBe(await transferFactDigest(fact));
    expect(transferDirection(fact,{genesis:locator.genesis,address:address(3)})).toBe('incoming');expect(transferDirection(fact,{genesis:locator.genesis,address:address(2)})).toBe('outgoing');
    expect(transferDirection({...fact,source:address(3)},{genesis:locator.genesis,address:address(3)})).toBe('self');expect(()=>transferDirection(fact,{genesis:locator.genesis,address:address(4)})).toThrow();
  });
  it('checks exact payload and token bytes without assigning financial authority',async()=>{
    const value=await input();expect(await prepareProvenanceAppend(value)).toEqual(value);
    if(value.observation.kind!=='balance')throw new Error('fixture');expect(decodeProvenanceTokenAccount(value.observation.accountDataHex).amountBaseUnits).toBe('100');
    await expect(prepareProvenanceAppend({...value,payloadHash:'0'.repeat(64)})).rejects.toThrow();
    await expect(prepareProvenanceAppend({...value,observation:{...value.observation,amountBaseUnits:'99'}})).rejects.toThrow();
  });
  it('keeps zero and maximum balances exact and rejects invalid token options',async()=>{
    const value=await input();if(value.observation.kind!=='balance')throw new Error('fixture');
    for(const amount of [0n,18446744073709551615n]){const bytes=Uint8Array.from(value.observation.accountDataHex.match(/../g)!,v=>parseInt(v,16));new DataView(bytes.buffer).setBigUint64(64,amount,true);expect(decodeProvenanceTokenAccount(provenanceHex(bytes)).amountBaseUnits).toBe(amount.toString());}
    const bytes=new Uint8Array(165);bytes[72]=2;expect(()=>decodeProvenanceTokenAccount(provenanceHex(bytes))).toThrow();
  });
  it('retains unsupported opaque bytes without decoding unsafe numerics or manufacturing a normalized fact',async()=>{
    const value=await input();value.observation={kind:'raw',reason:'unparsed',detail:'Retain bytes before normalization'};
    const payload=Uint8Array.of(0,255,128,34);value.payloadHex=provenanceHex(payload);value.payloadHash=provenanceHex(new Uint8Array(await crypto.subtle.digest('SHA-256',payload)));
    expect(await prepareProvenanceAppend(value)).toEqual(value);
  });
});
