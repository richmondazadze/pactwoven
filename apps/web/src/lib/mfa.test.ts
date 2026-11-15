import { describe,expect,it } from 'vitest';
import { verificationStage,type VerificationView } from './mfa';
const view:VerificationView={level:'multi_factor',status:'needs_first_factor',supportedFirstFactors:[{strategy:'password'}],supportedSecondFactors:[{strategy:'totp'}],firstFactorVerification:{status:'unverified'},secondFactorVerification:{status:'unverified'}};
describe('explicit MFA presentation flow',()=>{
  it('requests password then authenticator without accepting a factor downgrade',()=>{
    expect(verificationStage(view)).toBe('password');
    expect(verificationStage({...view,status:'needs_second_factor'})).toBe('totp');
    expect(verificationStage({...view,level:'first_factor',status:'complete',firstFactorVerification:{status:'verified'},secondFactorVerification:{status:'verified'}})).toBe('unsupported');
  });
  it('rejects unsupported/no-factor choices and complete with absent second-factor verification',()=>{
    expect(verificationStage({...view,supportedFirstFactors:[{strategy:'email_code'}]})).toBe('unsupported');
    expect(verificationStage({...view,status:'needs_second_factor',supportedSecondFactors:null})).toBe('unsupported');
    expect(verificationStage({...view,status:'needs_second_factor',supportedSecondFactors:[{strategy:'phone_code'}]})).toBe('unsupported');
    expect(verificationStage({...view,status:'complete',firstFactorVerification:{status:'verified'}})).toBe('unsupported');
  });
  it('presents provider completion only when both statuses are verified at the required level',()=>{
    expect(verificationStage({...view,status:'complete',firstFactorVerification:{status:'verified'},secondFactorVerification:{status:'verified'}})).toBe('complete');
  });
});
