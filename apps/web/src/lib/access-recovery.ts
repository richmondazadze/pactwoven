import { z } from 'zod';
import { EnvironmentSchema,IdSchema,IdempotencyKeySchema } from '@pactwoven/contracts';
import type { RecoveryStorage } from './bootstrap-recovery';
import type { AccessCapsule } from './access-capsule';
import { canonicalJson } from '@pactwoven/contracts/canonical';
const LEGACY_PREFIX='pactwoven:access-recovery:v1:',PREFIX='pactwoven:access-recovery:v2:';
const locator={key:IdempotencyKeySchema,kind:z.enum(['grant','revise','revoke']),userId:IdSchema,organizationId:IdSchema,apiBase:z.string().url()};
const LegacyAccessRecoverySchema=z.strictObject({version:z.literal(1),...locator});
export const CurrentAccessRecoverySchema=z.strictObject({version:z.literal(2),...locator,environment:EnvironmentSchema,internalOrganizationId:IdSchema,actorId:IdSchema});
// Only unresolved locators persist in tab storage. Exact input, session IDs, credentials and proof stay in memory.
export const AccessRecoverySchema=z.discriminatedUnion('version',[LegacyAccessRecoverySchema,CurrentAccessRecoverySchema]);
export type AccessRecovery=z.infer<typeof AccessRecoverySchema>;
export type AccessRecoveryScope=Pick<AccessRecovery,'userId'|'organizationId'|'apiBase'> & Partial<Pick<z.infer<typeof CurrentAccessRecoverySchema>,'environment'|'internalOrganizationId'|'actorId'>>;
function storageKey(value:AccessRecoveryScope & {version?:1|2}) {return value.version===1?LEGACY_PREFIX+encodeURIComponent(JSON.stringify([value.userId,value.organizationId,value.apiBase])):PREFIX+encodeURIComponent(JSON.stringify([value.userId,value.organizationId,value.apiBase,value.environment,value.internalOrganizationId,value.actorId]));}
export function recoveryFromCapsule(value:AccessCapsule):AccessRecovery {return CurrentAccessRecoverySchema.parse({version:2,key:value.key,kind:value.original.kind,userId:value.scope.userId,organizationId:value.scope.organizationId,apiBase:value.scope.apiBase,environment:value.scope.environment,internalOrganizationId:value.scope.internalOrganizationId,actorId:value.scope.actorId});}
export function recoveryMatchesScope(value:AccessRecovery,scope:AccessRecoveryScope) {return value.userId===scope.userId&&value.organizationId===scope.organizationId&&value.apiBase===scope.apiBase&&(value.version===1||(value.environment===scope.environment&&value.internalOrganizationId===scope.internalOrganizationId&&value.actorId===scope.actorId));}
function readStoredRecovery(storage:RecoveryStorage|null,scope:AccessRecoveryScope):AccessRecovery|null {
  for(const key of [storageKey({...scope,version:2}),storageKey({...scope,version:1})]){
    const raw=storage?.getItem(key)??'null';let input:unknown;
    try{input=JSON.parse(raw);}catch{continue;}
    const parsed=AccessRecoverySchema.safeParse(input);if(parsed.success&&storageKey(parsed.data)===key&&recoveryMatchesScope(parsed.data,scope))return parsed.data;
  }
  return null;
}
export function readAccessRecovery(storage:RecoveryStorage|null,scope:AccessRecoveryScope):AccessRecovery|null {try{return readStoredRecovery(storage,scope);}catch{return null;}}
export function saveAccessRecovery(storage:RecoveryStorage|null,input:AccessRecovery) {try{const value=AccessRecoverySchema.parse(input);const existing=readStoredRecovery(storage,value);if(existing&&(existing.key!==value.key||existing.kind!==value.kind))return false;storage?.setItem(storageKey(value),JSON.stringify(value));return Boolean(storage);}catch{return false;}}
export function accessRecoveryStored(storage:RecoveryStorage|null,value:AccessRecovery) {try{if(!storage)return false;const stored=AccessRecoverySchema.safeParse(JSON.parse(storage.getItem(storageKey(value))??'null'));return stored.success&&canonicalJson(stored.data)===canonicalJson(value);}catch{return false;}}
export function removeAccessRecovery(storage:RecoveryStorage|null,value:AccessRecovery) {try{if(!storage||!accessRecoveryStored(storage,value))return false;const key=storageKey(value);storage.removeItem(key);return storage.getItem(key)===null;}catch{return false;}}
// Call only after a qualified terminal operation/fence. Re-read both versions before unlocking new changes.
export function settleAccessRecovery(storage:RecoveryStorage|null,value:AccessRecovery,scope:AccessRecoveryScope):{cleared:boolean;remaining:AccessRecovery|null} {
  try{if(!storage||!recoveryMatchesScope(value,scope))return {cleared:false,remaining:value};const present=storage.getItem(storageKey(value));if(present!==null&&!removeAccessRecovery(storage,value))return {cleared:false,remaining:value};return {cleared:true,remaining:readStoredRecovery(storage,scope)};}catch{return {cleared:false,remaining:value};}
}
export function clearAccessRecovery(storage:RecoveryStorage|null) {
  // Authentication changes purge private memory elsewhere. Well-formed unresolved locators remain hidden
  // in their scope until a matching authorized owner observes a terminal result or tab storage ends.
  if(!storage)return;
  try{const keys=Array.from({length:storage.length},(_,i)=>storage.key(i)).filter((key):key is string=>Boolean(key&&(key.startsWith(PREFIX)||key.startsWith(LEGACY_PREFIX))));for(const key of keys){try{const parsed=AccessRecoverySchema.safeParse(JSON.parse(storage.getItem(key)??'null'));if(!parsed.success||storageKey(parsed.data)!==key)storage.removeItem(key);}catch{storage.removeItem(key);}}}catch{/* Storage restrictions do not close a request. */}
}
