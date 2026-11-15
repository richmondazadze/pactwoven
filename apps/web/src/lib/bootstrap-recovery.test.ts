import { describe, expect, it } from 'vitest';
import { RequestError } from './api';
import { bootstrapFailureKind, clearBootstrapRecovery, createBootstrapRecovery, readBootstrapRecovery, recoveryKey, removeBootstrapRecovery, storeBootstrapRecovery, type RecoveryStorage } from './bootstrap-recovery';
class TabStorage implements RecoveryStorage {
  private entries = new Map<string,string>();
  get length() { return this.entries.size; }
  key(index:number) { return [...this.entries.keys()][index] ?? null; }
  getItem(key:string) { return this.entries.get(key) ?? null; }
  setItem(key:string,value:string) { this.entries.set(key,value); }
  removeItem(key:string) { this.entries.delete(key); }
}
const scope = {userId:'user_one',organizationId:'org_one',apiBase:'http://127.0.0.1:8787'};
const payload = {initialSite:{name:'Test coordination site',timeZone:'America/Chicago'}};
const make = () => createBootstrapRecovery(scope,payload,'request_key_123456789');
describe('organization bootstrap recovery',()=>{
  it('restores the exact command and idempotency reference after a lost response and reload',()=>{
    const storage=new TabStorage(), attempt=make();
    expect(storeBootstrapRecovery(storage,attempt)).toBe(true);
    const resumed=readBootstrapRecovery(storage,scope);
    expect(resumed?.key).toBe(attempt.key);
    expect(resumed?.command).toEqual({expectedVersion:0,mandateVersion:null,authorityEpoch:null,payload});
  });
  it('cannot load a private site draft under another user, organization or API origin',()=>{
    const storage=new TabStorage(); storeBootstrapRecovery(storage,make());
    for(const other of [{...scope,userId:'user_two'},{...scope,organizationId:'org_two'},{...scope,apiBase:'https://other.example.test'}]) expect(readBootstrapRecovery(storage,other)).toBeNull();
  });
  it('rejects a stored scope substitution and unknown authority fields',()=>{
    const storage=new TabStorage(); const attempt=make();
    storage.setItem(recoveryKey(scope),JSON.stringify({...attempt,scope:{...scope,organizationId:'org_other'}}));
    expect(readBootstrapRecovery(storage,scope)).toBeNull();
    storage.setItem(recoveryKey(scope),JSON.stringify({...attempt,command:{...attempt.command,payload:{...payload,role:'owner'}}}));
    expect(readBootstrapRecovery(storage,scope)).toBeNull();
  });
  it('explicit sign-out clears all private recovery records without deleting unrelated storage',()=>{
    const storage=new TabStorage(); storeBootstrapRecovery(storage,make()); storage.setItem('unrelated','keep');
    clearBootstrapRecovery(storage);expect(readBootstrapRecovery(storage,scope)).toBeNull();expect(storage.getItem('unrelated')).toBe('keep');
  });
  it('clears another identity or organization while retaining the current authorized context',()=>{
    const storage=new TabStorage();storeBootstrapRecovery(storage,make());
    storeBootstrapRecovery(storage,createBootstrapRecovery({...scope,organizationId:'org_two'},payload,'another_request_123456'));
    clearBootstrapRecovery(storage,{userId:scope.userId,organizationId:scope.organizationId});
    expect(storage.length).toBe(1);expect(readBootstrapRecovery(storage,scope)?.key).toBe('request_key_123456789');
  });
  it('removes the recovery record only when confirmation or an explicit new attempt permits it',()=>{
    const storage=new TabStorage();storeBootstrapRecovery(storage,make());removeBootstrapRecovery(storage,scope);expect(storage.length).toBe(0);
  });
  it('reports storage restrictions without claiming durable recovery',()=>{
    expect(storeBootstrapRecovery(null,make())).toBe(false);expect(readBootstrapRecovery(null,scope)).toBeNull();
  });
  it('retains a confirmed setup outcome across reload so the client cannot resend it',()=>{
    const storage=new TabStorage(), attempt=make();
    expect(attempt.outcome).toBe('unresolved');
    storeBootstrapRecovery(storage,{...attempt,outcome:'confirmed'});
    expect(readBootstrapRecovery(storage,scope)).toMatchObject({key:attempt.key,outcome:'confirmed',command:attempt.command});
  });
  it('removes malformed private storage without stopping cleanup of another identity',()=>{
    const storage=new TabStorage();storage.setItem(recoveryKey({...scope,userId:'malformed'}),'{invalid json');
    storeBootstrapRecovery(storage,createBootstrapRecovery({...scope,userId:'user_two'},payload,'another_request_123456'));
    storeBootstrapRecovery(storage,make());
    clearBootstrapRecovery(storage,{userId:scope.userId,organizationId:scope.organizationId});
    expect(storage.length).toBe(1);expect(readBootstrapRecovery(storage,scope)?.key).toBe(make().key);
  });
  it('keeps401 reauthentication and ambiguous408/503/transport outcomes distinct from rejection',()=>{
    expect(bootstrapFailureKind(new RequestError('AUTH_REQUIRED','Sign in',401))).toBe('reauthenticate');
    for(const [code,status] of [['REQUEST_TIMEOUT',408],['IDENTITY_UNAVAILABLE',503],['DURABLE_SERVICE_UNAVAILABLE',503],['NETWORK_UNAVAILABLE',0]] as const) expect(bootstrapFailureKind(new RequestError(code,'Unconfirmed',status))).toBe('unresolved');
    expect(bootstrapFailureKind(new Error('unknown'))).toBe('unresolved');
  });
  it('offers a new attempt only after explicit rejection and probes session for existing setup',()=>{
    expect(bootstrapFailureKind(new RequestError('VALIDATION_FAILED','Invalid',422))).toBe('rejected');
    expect(bootstrapFailureKind(new RequestError('IDEMPOTENCY_CONFLICT','Changed input',409))).toBe('rejected');
    expect(bootstrapFailureKind(new RequestError('FORBIDDEN','Revoked',403))).toBe('rejected');
    expect(bootstrapFailureKind(new RequestError('ORGANIZATION_ALREADY_CONFIGURED','Exists',409))).toBe('already-configured');
  });
  it('a deliberate changed-payload attempt has a new identity and preserves the shared command envelope',()=>{
    const first=make(),next=createBootstrapRecovery(scope,{initialSite:{name:'Second site proposal',timeZone:'UTC'}},'new_request_123456789');
    expect(next.key).not.toBe(first.key);expect(first.command.payload).toEqual(payload);expect(next.command.expectedVersion).toBe(0);expect(next.command.mandateVersion).toBeNull();expect(next.command.authorityEpoch).toBeNull();
  });
});
