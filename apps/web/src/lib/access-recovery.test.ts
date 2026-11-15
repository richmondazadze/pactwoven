import { describe,expect,it } from 'vitest';
import { AccessRecoverySchema,readAccessRecovery,saveAccessRecovery,removeAccessRecovery,clearAccessRecovery,type AccessRecovery } from './access-recovery';
import type { RecoveryStorage } from './bootstrap-recovery';
class TabStorage implements RecoveryStorage {private entries=new Map<string,string>();get length(){return this.entries.size;}key(i:number){return [...this.entries.keys()][i]??null;}getItem(key:string){return this.entries.get(key)??null;}setItem(key:string,value:string){this.entries.set(key,value);}removeItem(key:string){this.entries.delete(key);}}
const record:AccessRecovery={version:1,key:'request_key_123456789',kind:'grant',userId:'user_one',organizationId:'org_one',apiBase:'http://127.0.0.1:8787'};
describe('member command recovery locator',()=>{
  it('restores only the exact operation locator and never accepts credentials or command payloads',()=>{
    const storage=new TabStorage();expect(saveAccessRecovery(storage,record)).toBe(true);expect(readAccessRecovery(storage,record)).toEqual(record);
    for(const extra of [{token:'forbidden'},{code:'000000'},{password:'forbidden'},{payload:{roles:['owner']}}])expect(AccessRecoverySchema.safeParse({...record,...extra}).success).toBe(false);
  });
  it('cannot cross user, organization or API scopes',()=>{
    const storage=new TabStorage();saveAccessRecovery(storage,record);
    for(const other of [{...record,userId:'user_two'},{...record,organizationId:'org_two'},{...record,apiBase:'https://other.example.test'}])expect(readAccessRecovery(storage,other)).toBeNull();
  });
  it('clears foreign/private locators on organization change and signout while preserving unrelated data',()=>{
    const storage=new TabStorage();storage.setItem('unrelated','keep');saveAccessRecovery(storage,record);saveAccessRecovery(storage,{...record,userId:'user_two'});
    clearAccessRecovery(storage,{userId:'user_one',organizationId:'org_one'});expect(storage.length).toBe(2);expect(readAccessRecovery(storage,record)).toEqual(record);
    clearAccessRecovery(storage);expect(storage.length).toBe(1);expect(storage.getItem('unrelated')).toBe('keep');
  });
  it('reports unavailable storage and removes only a terminally resolved locator when requested',()=>{
    expect(saveAccessRecovery(null,record)).toBe(false);const storage=new TabStorage();saveAccessRecovery(storage,record);removeAccessRecovery(storage,record);expect(readAccessRecovery(storage,record)).toBeNull();
  });
});
