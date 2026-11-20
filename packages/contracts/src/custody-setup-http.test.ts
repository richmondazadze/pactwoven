import {describe,expect,it} from 'vitest';
import {CustodyConfirmHttpSchema,CustodyConfirmationHttpSchema,custodyHttpBodyLimits} from './custody-setup-http';
const base={schemaVersion:1,key:'original_setup_key_001',expectedSetupVersion:1,expectedSetupHash:'a'.repeat(64),challengeId:'123e4567-e89b-12d3-a456-426614174000',challengeHash:'b'.repeat(64),walletSignature:'A'.repeat(86)+'=='};
describe('custody transport shapes',()=>{
 it('excludes private verifier fields and signing APIs',()=>{const v={...base,confirmationId:base.challengeId,confirmationNonce:'A'.repeat(43)};expect(CustodyConfirmHttpSchema.safeParse(v).success).toBe(true);
  for(const key of ['mfaEvidenceId','identityEvidenceId','walletEvidenceId','actorId','verified','transactionBytes','privateKey'])expect(CustodyConfirmHttpSchema.safeParse({...v,[key]:'anything'}).success).toBe(false);});
 it('binds the intended original confirmation key before MFA',()=>{expect(CustodyConfirmationHttpSchema.safeParse({...base,confirmationKey:'exact_confirm_key_001'}).success).toBe(true);expect(CustodyConfirmationHttpSchema.safeParse(base).success).toBe(false);});
 it('sets bounded transport byte ceilings for later API enforcement',()=>expect(custodyHttpBodyLimits).toEqual({prepare:8192,challenge:2048,confirmation:4096,confirm:4096,cancel:2048}));
});
