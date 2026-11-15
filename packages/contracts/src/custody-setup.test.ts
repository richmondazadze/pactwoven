import {describe,expect,it} from 'vitest';
import {CustodyAmountSchema,CustodyUuidSchema,CustodyInstantSchema,CustodyNonceSchema,CustodySignatureSchema,CustodyPrepareCommandSchema,CustodyCommandSchema} from './custody-setup';
const hash='a'.repeat(64);
const prepare={schemaVersion:1,kind:'prepare',key:'original_setup_key_001',responsibilityId:'responsibility_a',reviewedSpecificationRef:{id:'spec_a',version:1,recordHash:hash},
 ownerWalletPublicKey:'5UaivPxV8oQypy5mxmQCzvZXHVSMkPsZ2TKJvszyebVG',previousDraft:null,expectedScope:{responsibilityVersion:1,responsibilityHash:hash,siteGeneration:0,siteRecordHash:hash,canonicalGeneration:0,canonicalHash:hash}};
describe('custody strict public domain contracts',()=>{
 it('retains exact explicit predecessors and rejects unknown authority claims',()=>{expect(CustodyPrepareCommandSchema.parse(prepare)).toEqual(prepare);for(const key of ['actorId','verified','ownerBindingHash','financialState','transaction'])expect(CustodyCommandSchema.safeParse({...prepare,[key]:true}).success).toBe(false);});
 it.each(['-1','01','1.0','1e6','18446744073709551616'])('rejects noncanonical or overflowing amounts %s',v=>expect(CustodyAmountSchema.safeParse(v).success).toBe(false));
 it('keeps full u64 precision',()=>expect(CustodyAmountSchema.parse('18446744073709551615')).toBe('18446744073709551615'));
 it.each(['00000000-0000-0000-0000-000000000000','ORG_A','123E4567-e89b-12d3-a456-426614174000'])('rejects unstable registration identity %s',v=>expect(CustodyUuidSchema.safeParse(v).success).toBe(false));
 it.each(['2026-02-30T00:00:00.000Z','2026-11-15T24:00:00.000Z','2026-11-15T00:00:00Z'])('requires canonical millisecond instants %s',v=>expect(CustodyInstantSchema.safeParse(v).success).toBe(false));
 it('rejects defaults, exhausted versions and absent predecessor semantics',()=>{expect(CustodyCommandSchema.safeParse({...prepare,ownerWalletPublicKey:'11111111111111111111111111111111'}).success).toBe(false);
  expect(CustodyCommandSchema.safeParse({...prepare,expectedScope:{...prepare.expectedScope,canonicalGeneration:2147483648}}).success).toBe(false);const {previousDraft:_,...missing}=prepare;expect(CustodyCommandSchema.safeParse(missing).success).toBe(false);});
 it('enforces canonical fixed-sized nonce and signature encodings',()=>{expect(CustodyNonceSchema.safeParse('A'.repeat(43)).success).toBe(true);expect(CustodyNonceSchema.safeParse('A'.repeat(42)+'B').success).toBe(false);expect(CustodySignatureSchema.safeParse('A'.repeat(86)+'==').success).toBe(true);expect(CustodySignatureSchema.safeParse('A'.repeat(85)+'B==').success).toBe(false);});
});
