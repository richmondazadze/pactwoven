import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {describe,it,expect,vi} from 'vitest';
const source=await readFile(new URL('./ci-delegation-postgres.mjs',import.meta.url),'utf8');
const start=source.indexOf("  stage = 'paid forward upgrade baseline';"),end=source.indexOf('\n} catch {',start);
const paidStage=source.slice(start,end);
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
async function fixture(change=''){
 const original=[{oid:'10',relname:'native_roots',relowner:'owner',relacl:['owner'],relrowsecurity:true,relforcerowsecurity:true}],routine=[{oid:'20',proname:'ordinary',definition:'original',proacl:['owner']},{oid:'21',proname:'native_delegation_root_wait_ready',definition:'wait',proacl:['owner']}];
 const rows=[{name:'native_roots',count:'3',hash:'original'}],definition='CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_wait_ready(r pactwoven.native_delegation_root_runs) RETURNS boolean';
 let applied=false;const queries:string[]=[];
 const query=vi.fn(async(sql:string)=>{queries.push(sql);if(sql==='relations'){const after=[...structuredClone(original),{oid:'30',relname:change==='foreign-table'?'foreign':'paid_tool_roots',relowner:'owner',relacl:['owner'],relrowsecurity:change!=='rls',relforcerowsecurity:true}];if(change==='old-table-acl')after[0]!.relacl=['public'];return {rows:applied?after:original};}if(sql==='routines'){const after=structuredClone(routine);if(change==='old-routine')after[0]!.definition='changed';return {rows:applied?after:routine};}if(sql.includes('pg_get_functiondef'))return {rows:[{definition:sql.includes('before_paid')?(change==='wait-body'?'wrong':definition.replace('FUNCTION pactwoven.native_delegation_root_wait_ready(','FUNCTION pactwoven.native_delegation_root_wait_ready_before_paid(')):definition}]};if(sql.startsWith('apply:')){applied=true;return {rows:[]};}if(sql.includes('SELECT NOT EXISTS'))return {rows:[{safe:change!=='public-access'}]};throw Error('Unexpected query');});
 const rowFingerprints=vi.fn(async()=>applied&&change==='rows'?[{...rows[0],hash:'changed'}]:rows),files=Array.from({length:44},(_,i)=>String(i+1).padStart(4,'0')+'.sql'),read=vi.fn(async(url:URL)=>'apply:'+url.pathname.split('/').at(-1)),run=vi.fn(),log=vi.fn();
 const execute=new AsyncFunction('fixture','assert','relationQuery','routineQuery','rowFingerprints','files','readFile','directory','run','console','let stage;'+paidStage+';return stage;');
 const outcome=execute({query},assert,'relations','routines',rowFingerprints,files,read,new URL('file:///fixture/'),run,{log});
 return {outcome,queries,run,read,rowFingerprints};
}
describe('independent paid CI composition guards',()=>{
 it('places paid upgrade after old exact-role checks with44-file inventory',()=>{expect(source).toContain("files.length !== 44 || files.at(-1) !== '0044_paid_tool_dispatch.sql'");expect(start).toBeGreaterThan(source.indexOf("stage = 'paused instructions and revision fencing'"));expect(start).toBeGreaterThan(source.indexOf("stage = '0040_native_work_activity.sql'"));expect(paidStage).toContain('files.slice(40)');});
 it('executes only41through44 after capturing all original data/catalog evidence',async()=>{const f=await fixture();await f.outcome;expect(f.read.mock.calls.map(([url])=>url.pathname)).toEqual(['/fixture/0041.sql','/fixture/0042.sql','/fixture/0043.sql','/fixture/0044.sql']);expect(f.rowFingerprints).toHaveBeenCalledTimes(2);expect(f.run).toHaveBeenCalledOnce();expect(f.queries.indexOf('relations')).toBeLessThan(f.queries.indexOf('apply:0041.sql'));});
 it.each(['rows','old-table-acl','old-routine','wait-body','foreign-table','rls','public-access'])('fails qualification for%sregression',async change=>{const f=await fixture(change);await expect(f.outcome).rejects.toThrow();expect(f.run).not.toHaveBeenCalled();});
});
