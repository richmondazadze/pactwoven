import { describe,expect,it } from 'vitest';
import { AccessRecoverySchema,readAccessRecovery,saveAccessRecovery,removeAccessRecovery,clearAccessRecovery,accessRecoveryStored,settleAccessRecovery,type AccessRecovery } from './access-recovery';
import type { RecoveryStorage } from './bootstrap-recovery';
class TabStorage implements RecoveryStorage {private entries=new Map<string,string>();get length(){return this.entries.size;}key(i:number){return [...this.entries.keys()][i]??null;}getItem(key:string){return this.entries.get(key)??null;}setItem(key:string,value:string){this.entries.set(key,value);}removeItem(key:string){this.entries.delete(key);}}
const record:AccessRecovery={version:2,key:'request_key_123456789',kind:'grant',userId:'user_one',organizationId:'org_one',apiBase:'https://api.example.test',environment:'development',internalOrganizationId:'internal_org_one',actorId:'actor_one'};
const legacy:AccessRecovery={version:1,key:record.key,kind:record.kind,userId:record.userId,organizationId:record.organizationId,apiBase:record.apiBase};
describe('member command recovery locator',()=>{
  it('retains only the scoped locator and rejects payloads, proof, session IDs and unknown fields',()=>{
    const storage=new TabStorage();expect(saveAccessRecovery(storage,record)).toBe(true);expect(readAccessRecovery(storage,record)).toEqual(record);
    for(const extra of [{token:'forbidden'},{code:'000000'},{password:'forbidden'},{payload:{roles:['owner']}},{sessionId:'old_session'},{mfaComplete:true},{commandHash:'not_a_payload'}])expect(AccessRecoverySchema.safeParse({...record,...extra}).success).toBe(false);
    expect(storage.getItem(storage.key(0)!)).not.toContain('sessionId');
  });
  it('cannot cross user, organization, API, environment, internal organization or actor scopes',()=>{
    const storage=new TabStorage();saveAccessRecovery(storage,record);
    for(const other of [{...record,userId:'user_two'},{...record,organizationId:'org_two'},{...record,apiBase:'https://other.example.test'},{...record,environment:'production' as const},{...record,internalOrganizationId:'internal_other'},{...record,actorId:'actor_other'}])expect(readAccessRecovery(storage,other)).toBeNull();
  });
  it('keeps unresolved minimal references across signout and tenant changes, hidden in each exact scope',()=>{
    const storage=new TabStorage();storage.setItem('unrelated','keep');saveAccessRecovery(storage,record);const other={...record,userId:'user_two'};saveAccessRecovery(storage,other);
    clearAccessRecovery(storage);expect(storage.length).toBe(3);expect(readAccessRecovery(storage,record)).toEqual(record);expect(readAccessRecovery(storage,other)).toEqual(other);expect(readAccessRecovery(storage,{...record,organizationId:'foreign_org'})).toBeNull();
    expect(storage.getItem('unrelated')).toBe('keep');
  });
  it('restores a scoped legacy reference for lookup without inventing a current capsule or session binding',()=>{
    const storage=new TabStorage();saveAccessRecovery(storage,legacy);expect(readAccessRecovery(storage,record)).toEqual(legacy);expect(readAccessRecovery(storage,{...record,userId:'foreign_user'})).toBeNull();
  });
  it('does not let a malformed v2 slot hide an existing legacy original or unreadable storage permit a new send',()=>{
    const storage=new TabStorage();saveAccessRecovery(storage,record);const currentKey=storage.key(0)!;storage.setItem(currentKey,'{');saveAccessRecovery(storage,legacy);expect(readAccessRecovery(storage,record)).toEqual(legacy);expect(saveAccessRecovery(storage,{...record,key:'replacement_123456789'})).toBe(false);
    let wrote=false;const unreadable={length:1,key:()=>currentKey,getItem:()=>{throw new Error('read denied');},setItem:()=>{wrote=true;},removeItem:()=>{}};expect(saveAccessRecovery(unreadable,record)).toBe(false);expect(wrote).toBe(false);
  });
  it('refuses to replace a prior unresolved key and only removes a matching terminal reference',()=>{
    const storage=new TabStorage();saveAccessRecovery(storage,record);const replacement={...record,key:'new_request_123456789'};expect(saveAccessRecovery(storage,replacement)).toBe(false);removeAccessRecovery(storage,replacement);expect(readAccessRecovery(storage,record)).toEqual(record);removeAccessRecovery(storage,{...record,kind:'revoke'});expect(readAccessRecovery(storage,record)).toEqual(record);removeAccessRecovery(storage,record);expect(readAccessRecovery(storage,record)).toBeNull();
    saveAccessRecovery(storage,legacy);expect(saveAccessRecovery(storage,replacement)).toBe(false);
  });
  it('reports unavailable storage and purges malformed or misplaced records without touching valid references',()=>{
    expect(saveAccessRecovery(null,record)).toBe(false);const storage=new TabStorage();saveAccessRecovery(storage,record);storage.setItem('pactwoven:access-recovery:v2:broken','{');storage.setItem('pactwoven:access-recovery:v2:misplaced',JSON.stringify(record));clearAccessRecovery(storage);expect(storage.length).toBe(1);expect(readAccessRecovery(storage,record)).toEqual(record);
    const denied={...storage,length:0,key:()=>null,getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');},removeItem:()=>{throw new Error('denied');}};expect(saveAccessRecovery(denied,record)).toBe(false);expect(readAccessRecovery(denied,record)).toBeNull();expect(()=>removeAccessRecovery(denied,record)).not.toThrow();
  });
});

describe('qualified terminal recovery settlement',()=>{
  it('removes only the canonical exact selected locator and verifies readback',()=>{
    const storage=new TabStorage();saveAccessRecovery(storage,record);
    expect(accessRecoveryStored(storage,record)).toBe(true);expect(accessRecoveryStored(storage,{...record,kind:'revoke'})).toBe(false);
    expect(settleAccessRecovery(storage,{...record,key:'wrong_key_123456789'},record)).toEqual({cleared:false,remaining:{...record,key:'wrong_key_123456789'}});
    expect(readAccessRecovery(storage,record)).toEqual(record);
    expect(settleAccessRecovery(storage,record,{...record,userId:'other'}).cleared).toBe(false);
    expect(settleAccessRecovery(storage,record,record)).toEqual({cleared:true,remaining:null});
  });
  it.each(['same','different'] as const)('keeps a %s legacy namespace after resolving the preferred v2 locator',kind=>{
    const storage=new TabStorage();saveAccessRecovery(storage,record);saveAccessRecovery(storage,legacy);
    const legacyKey=Array.from({length:storage.length},(_,i)=>storage.key(i)!).find(key=>key.includes(':v1:'))!;
    const sibling=kind==='same'?legacy:{...legacy,kind:'revoke' as const,key:'other_key_123456789'};storage.setItem(legacyKey,JSON.stringify(sibling));storage.setItem('unrelated','keep');
    expect(settleAccessRecovery(storage,record,record)).toEqual({cleared:true,remaining:sibling});expect(readAccessRecovery(storage,record)).toEqual(sibling);expect(storage.getItem('unrelated')).toBe('keep');
    expect(settleAccessRecovery(storage,sibling,record)).toEqual({cleared:true,remaining:null});
  });
  it('continues blocking for unavailable storage, failed removal, unreadable readback or canonical mismatch',()=>{
    const unavailable={length:1,key:()=>null,getItem:()=>{throw new Error('Denied');},setItem:()=>{},removeItem:()=>{}};
    expect(settleAccessRecovery(null,record,record)).toEqual({cleared:false,remaining:record});expect(settleAccessRecovery(unavailable,record,record)).toEqual({cleared:false,remaining:record});
    const storage=new TabStorage();saveAccessRecovery(storage,record);
    const retained={length:storage.length,key:(i:number)=>storage.key(i),getItem:(key:string)=>storage.getItem(key),setItem:()=>{},removeItem:()=>{}};
    expect(settleAccessRecovery(retained,record,record)).toEqual({cleared:false,remaining:record});
    storage.setItem(storage.key(0)!,JSON.stringify({...record,actorId:'other'}));expect(settleAccessRecovery(storage,record,record)).toEqual({cleared:false,remaining:record});
  });
  it('safely retries local cleanup after removal succeeded but readback was temporarily unavailable',()=>{
    const storage=new TabStorage();saveAccessRecovery(storage,record);saveAccessRecovery(storage,legacy);let failReadback=false;
    const temporary={get length(){return storage.length;},key:(i:number)=>storage.key(i),getItem:(key:string)=>{if(failReadback)throw new Error('Readback unavailable');return storage.getItem(key);},setItem:(key:string,value:string)=>storage.setItem(key,value),removeItem:(key:string)=>{storage.removeItem(key);failReadback=true;}};
    expect(settleAccessRecovery(temporary,record,record)).toEqual({cleared:false,remaining:record});failReadback=false;
    expect(settleAccessRecovery(temporary,record,record)).toEqual({cleared:true,remaining:legacy});expect(readAccessRecovery(storage,record)).toEqual(legacy);
  });
  it('does not let a second-slot read failure masquerade as successful clearance of all references',()=>{
    const storage=new TabStorage();saveAccessRecovery(storage,record);saveAccessRecovery(storage,legacy);
    const restricted={get length(){return storage.length;},key:(i:number)=>storage.key(i),getItem:(key:string)=>{if(key.includes(':v1:'))throw new Error('Legacy read denied');return storage.getItem(key);},setItem:()=>{},removeItem:(key:string)=>storage.removeItem(key)};
    expect(settleAccessRecovery(restricted,record,record)).toEqual({cleared:false,remaining:record});expect(readAccessRecovery(storage,record)).toEqual(legacy);
  });
});
