import { describe, expect, it } from 'vitest';
import { RequestError } from './api';
import { recoveryFailureKind, recoveryFlow } from './access-retry';

describe('recovery after an already uncertain command',()=>{
  it('retains exact input after expired step-up while requiring the full explicit retry sequence again',()=>{
    expect(recoveryFailureKind(new RequestError('STEP_UP_REQUIRED','Verify again.',403))).toBe('verification-expired');
    const reset=recoveryFlow({phase:'retrying',reviewedHash:'original',verifiedAt:Date.now()},{type:'reset'});
    expect(reset).toEqual({phase:'check',reviewedHash:null,verifiedAt:null});
    expect(recoveryFlow(reset,{type:'retry-click',now:Date.now()})).toEqual(reset);
    expect(recoveryFlow(reset,{type:'verified',at:Date.now()})).toEqual(reset);
  });
  it('purges private input on true identity/scope denial without treating every 403 as lost authority',()=>{
    for(const [code,status] of [['AUTH_REQUIRED',401],['SESSION_REQUIRED',401],['FORBIDDEN',403],['RECOVERY_SCOPE_CHANGED',403],['REQUEST_FAILED',403],['STEP_UP_REQUIRED',401]] as const){
      expect(recoveryFailureKind(new RequestError(code,'Denied.',status))).toBe('scope-denied');
    }
    for(const error of [new RequestError('VERSION_CONFLICT','Changed.',409),new RequestError('DURABLE_SERVICE_UNAVAILABLE','Unavailable.',503),new Error('Connection lost')]){
      expect(recoveryFailureKind(error)).toBe('unconfirmed');
    }
  });
});
