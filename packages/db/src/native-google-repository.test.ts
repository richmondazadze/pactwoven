import {describe,it,expect,vi}from'vitest';
import type {Pool}from'pg';
import {PostgresNativeGoogleStore}from'./native-google-repository';
describe('private Google repository boundary',()=>{
 it('sanitizes unknown storage errors without returning private database text',async()=>{const query=vi.fn(async()=>{throw Object.assign(Error('secret_token_and_private_row'),{code:'XX000'});}),pool={query}as unknown as Pool,store=new PostgresNativeGoogleStore(pool,pool,'simulation');const error=await store.resolveRead('connection','reference').catch(e=>e);expect(error.code).toBe('GOOGLE_OUTCOME_UNKNOWN');expect(String(error)).not.toContain('secret_token');});
 it.each(['NG001','NG003','NG008','NG010'])('maps explicit SQL boundary %s',async code=>{const pool={query:vi.fn(async()=>{throw{code};})}as unknown as Pool,store=new PostgresNativeGoogleStore(pool,pool,'simulation');const error=await store.resolveRead('connection','reference').catch(e=>e);expect(error.code).toBe(({NG001:'GOOGLE_DENIED',NG003:'GOOGLE_CONFLICT',NG008:'GOOGLE_DENIED',NG010:'GOOGLE_INTEGRATION_REQUIRED'}as Record<string,string>)[code]);});
});
