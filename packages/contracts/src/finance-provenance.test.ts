import { describe, expect, it } from 'vitest';
import { decodeSolanaBase58, encodeSolanaBase58, FINANCE_DEVNET_ASSET, FinancePhysicalAssetSchema, FinanceProvenanceLookupSchema,
  FinanceProvenanceVersionSchema, FinanceRawObservationSchema, FinanceTransferFactSchema, FinanceTransferLocatorSchema, SolanaPublicKeySchema, SolanaSignatureSchema } from './finance-provenance';

describe('provenance contracts', () => {
  it('round trips exact decoded identity including leading zeros and the pinned devnet tuple', () => {
    expect(FinancePhysicalAssetSchema.parse(FINANCE_DEVNET_ASSET)).toEqual(FINANCE_DEVNET_ASSET);
    for (const size of [32,64] as const) for (const fill of [0,1,127,255]) {
      const bytes = new Uint8Array(size).fill(fill); bytes[0]=0;
      expect(decodeSolanaBase58(encodeSolanaBase58(bytes),size)).toEqual(bytes);
    }
  });
  it.each(['', '0'.repeat(32), '1'.repeat(31), '1'.repeat(33), ' 11111111111111111111111111111111', 'z'.repeat(45)])('rejects noncanonical public identity %s', value => expect(SolanaPublicKeySchema.safeParse(value).success).toBe(false));
  it('separates signatures from public keys and rejects extra lookup authority fields', () => {
    expect(SolanaSignatureSchema.safeParse('1'.repeat(32)).success).toBe(false);
    expect(FinanceProvenanceLookupSchema.safeParse({sourceId:'source_a',accountKey:'a'.repeat(64),deliveryKey:'original',organizationId:'other'}).success).toBe(false);
  });
  it.each([0,-1,1.5,2_147_483_648,Number.MAX_SAFE_INTEGER])('rejects unsupported stored version %s', version => expect(FinanceProvenanceVersionSchema.safeParse(version).success).toBe(false));
  it('preserves null versus original inner ordinal zero and rejects unsupported positions', () => {
    const locator={genesis:FINANCE_DEVNET_ASSET.genesis,signature:'1'.repeat(64),outerInstructionIndex:0,innerInstructionOrdinal:null};
    expect(FinanceTransferLocatorSchema.parse(locator).innerInstructionOrdinal).toBeNull();
    expect(FinanceTransferLocatorSchema.parse({...locator,innerInstructionOrdinal:0}).innerInstructionOrdinal).toBe(0);
    expect(FinanceTransferLocatorSchema.safeParse({...locator,outerInstructionIndex:65_535}).success).toBe(false);
  });
  const fact={locator:{genesis:FINANCE_DEVNET_ASSET.genesis,signature:'1'.repeat(64),outerInstructionIndex:0,innerInstructionOrdinal:null},asset:FINANCE_DEVNET_ASSET,
    source:'1'.repeat(32),destination:'1'.repeat(32),amountBaseUnits:'18446744073709551615',instructionKind:'TransferChecked',checkedDecimals:6,instructionDataHash:'a'.repeat(64)};
  it('allows u64 boundary and self/zero facts as inert evidence', () => { expect(FinanceTransferFactSchema.safeParse(fact).success).toBe(true); expect(FinanceTransferFactSchema.safeParse({...fact,amountBaseUnits:'0'}).success).toBe(true); });
  it.each(['18446744073709551616','01','+1','1.0','1e6',' 1',1])('rejects lossy or noncanonical amount %s', amountBaseUnits => expect(FinanceTransferFactSchema.safeParse({...fact,amountBaseUnits}).success).toBe(false));
  it('requires exact checked-decimal semantics without financial qualification flags', () => {
    expect(FinanceTransferFactSchema.safeParse({...fact,checkedDecimals:null}).success).toBe(false);
    expect(FinanceTransferFactSchema.safeParse({...fact,verified:true}).success).toBe(false);
  });
  it('raw evidence cannot carry a claimed normalized transfer or balance',()=>{
    expect(FinanceRawObservationSchema.safeParse({kind:'raw',reason:'unsupported',detail:'Unknown transaction version'}).success).toBe(true);
    expect(FinanceRawObservationSchema.safeParse({kind:'raw',reason:'unsupported',detail:'',amountBaseUnits:'100'}).success).toBe(false);
    expect(FinanceRawObservationSchema.safeParse({kind:'raw',reason:null,detail:''}).success).toBe(false);
  });
});
