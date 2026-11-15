import { z } from 'zod';
import { EnvironmentSchema, IdSchema, IdempotencyKeySchema, InstantSchema, GrantAccessCommandSchema, ReviseAccessCommandSchema, RevokeAccessCommandSchema, MemberAccessPageSchema, MemberCandidatePageSchema, type MemberAccess, type MemberCandidate, type Session } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from '@pactwoven/contracts/canonical';
import { apiRequest, RequestError, type TokenSource } from './api';
import { isAccessOwner, type AccessIntent, type AccessSelection } from './access-review';
export const AccessCapsuleScopeSchema=z.strictObject({userId:IdSchema,organizationId:IdSchema,sessionId:z.string().min(1).max(256),apiBase:z.string().url(),environment:EnvironmentSchema,internalOrganizationId:IdSchema,actorId:IdSchema,requesterMembershipId:IdSchema});
export type AccessCapsuleScope=z.infer<typeof AccessCapsuleScopeSchema>;
const targetIdentity=z.strictObject({externalSubject:IdSchema,externalMembershipId:IdSchema});
const original=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('grant'),targetActorId:z.null(),path:z.literal('/v1/members/grant'),command:GrantAccessCommandSchema}),
  z.strictObject({kind:z.literal('revise'),targetActorId:IdSchema,path:z.string(),command:ReviseAccessCommandSchema}),
  z.strictObject({kind:z.literal('revoke'),targetActorId:IdSchema,path:z.string(),command:RevokeAccessCommandSchema}),
]);
export const AccessCapsuleSchema=z.strictObject({schemaVersion:z.literal(1),digestSchemaVersion:z.literal(1),key:IdempotencyKeySchema,createdAt:InstantSchema,scope:AccessCapsuleScopeSchema,targetIdentity,original,commandHash:z.string().regex(/^[a-f0-9]{64}$/),integrityHash:z.string().regex(/^[a-f0-9]{64}$/)});
export type AccessCapsule=z.infer<typeof AccessCapsuleSchema>;
export function originalAccessPath(kind:AccessCapsule['original']['kind'],actorId:string|null) {
  if(kind==='grant'){if(actorId!==null)throw new Error('Grant target must be a membership.');return '/v1/members/grant';}
  const id=IdSchema.parse(actorId);return `/v1/members/${id}/${kind==='revise'?'revise-access':'revoke'}`;
}
function envelope(value:Pick<AccessCapsule,'scope'|'original'>) {return {schemaVersion:1,kind:`member.${value.original.kind}`,environment:value.scope.environment,externalOrganizationId:value.scope.organizationId,subject:value.scope.userId,actorId:value.original.targetActorId,command:value.original.command};}
function immutable<T>(value:T):T {if(value&&typeof value==='object'){for(const item of Object.values(value))immutable(item);Object.freeze(value);}return value;}
export function sameCapsuleScope(a:AccessCapsuleScope,b:AccessCapsuleScope) {return canonicalJson(a)===canonicalJson(b);}
export type CapsuleAuth={userId:string|null|undefined;orgId:string|null|undefined;sessionId:string|null|undefined};
export function capsuleMatchesSession(value:AccessCapsule,session:Session,auth:CapsuleAuth,apiBase:string|null) {return isAccessOwner(session)&&session.actor.organizationId===session.organization.id&&value.scope.userId===auth.userId&&value.scope.organizationId===auth.orgId&&value.scope.sessionId===auth.sessionId&&value.scope.apiBase===apiBase&&value.scope.environment===session.actor.environment&&value.scope.internalOrganizationId===session.organization.id&&value.scope.actorId===session.actor.actorId;}
export async function createAccessCapsule(scope:AccessCapsuleScope,selection:AccessSelection,intent:AccessIntent,key:string):Promise<AccessCapsule> {
  const target=selection.kind==='grant'?selection.candidate:selection.member;
  if(selection.kind!==intent.kind || (selection.kind==='grant'&&selection.candidate.externalOrganizationId!==scope.organizationId))throw new RequestError('RECOVERY_BINDING_INVALID','The original identity does not match this request.');
  const targetActorId=selection.kind==='grant'?null:selection.member.actorId;
  const originalValue={kind:intent.kind,targetActorId,path:intent.path,command:intent.command};
  const body={schemaVersion:1 as const,digestSchemaVersion:1 as const,key,createdAt:new Date().toISOString(),scope:AccessCapsuleScopeSchema.parse(scope),targetIdentity:{externalSubject:target.externalSubject,externalMembershipId:target.externalMembershipId},original:original.parse(originalValue)};
  if(body.original.path!==originalAccessPath(body.original.kind,body.original.targetActorId))throw new RequestError('RECOVERY_BINDING_INVALID','The original endpoint is not supported.');
  if(body.original.kind==='grant'&&(body.original.command.payload.externalSubject!==target.externalSubject||body.original.command.payload.externalMembershipId!==target.externalMembershipId))throw new RequestError('RECOVERY_BINDING_INVALID','The grant identity changed.');
  const commandHash=await commandDigest(envelope(body));
  const copied=AccessCapsuleSchema.parse({...body,commandHash,integrityHash:await commandDigest({...body,commandHash})});
  return immutable(copied);
}
export async function verifyAccessCapsule(input:AccessCapsule,scope:AccessCapsuleScope):Promise<AccessCapsule> {
  const value=AccessCapsuleSchema.parse(input);
  if(canonicalJson(input)!==canonicalJson(value))throw new RequestError('RECOVERY_BINDING_INVALID','The original request changed during validation.');
  if(!sameCapsuleScope(value.scope,scope)||value.original.path!==originalAccessPath(value.original.kind,value.original.targetActorId))throw new RequestError('RECOVERY_BINDING_INVALID','The original request does not match this authenticated scope.');
  if(value.original.kind==='grant'&&(value.original.command.payload.externalSubject!==value.targetIdentity.externalSubject||value.original.command.payload.externalMembershipId!==value.targetIdentity.externalMembershipId))throw new RequestError('RECOVERY_BINDING_INVALID','The original target identity changed.');
  const {integrityHash,...body}=value;
  if(await commandDigest(envelope(value))!==value.commandHash||await commandDigest(body)!==integrityHash)throw new RequestError('RECOVERY_BINDING_INVALID','The retained original request failed its integrity check.');
  return immutable(value);
}
async function findPageRecord<T>(read:(cursor:string)=>Promise<{items:T[];nextCursor:string|null}>,matches:(value:T)=>boolean):Promise<T|null> {
  let cursor='';const seen=new Set<string>();
  for(let page=0;page<100;page++){if(seen.has(cursor))throw new RequestError('RESPONSE_UNVERIFIED','Membership pagination could not be verified.');seen.add(cursor);const result=await read(cursor);const found=result.items.find(matches);if(found)return found;if(result.nextCursor===null)return null;cursor=result.nextCursor;}
  throw new RequestError('IDENTITY_UNAVAILABLE','The current membership could not be located within this review.');
}
export function readCurrentAccessMember(actorId:string,getToken:TokenSource,signal?:AbortSignal):Promise<MemberAccess|null> {return findPageRecord(cursor=>apiRequest(`/v1/members?limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,MemberAccessPageSchema,getToken,signal?{signal}:{}),member=>member.actorId===actorId);}
export function readCurrentAccessCandidate(membershipId:string,getToken:TokenSource,signal?:AbortSignal):Promise<MemberCandidate|null> {return findPageRecord(cursor=>apiRequest(`/v1/members/candidates?limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,MemberCandidatePageSchema,getToken,signal?{signal}:{}),candidate=>candidate.externalMembershipId===membershipId);}
export function requesterMatches(scope:AccessCapsuleScope,member:MemberAccess|null):member is MemberAccess {return Boolean(member&&member.actorId===scope.actorId&&member.externalSubject===scope.userId&&member.externalMembershipId===scope.requesterMembershipId&&member.status==='active'&&member.roles.includes('owner'));}
export type OriginalObservation={requester:MemberAccess;target:MemberAccess|MemberCandidate;observedAt:string};
export async function observeOriginalIdentity(value:AccessCapsule,getToken:TokenSource,signal?:AbortSignal):Promise<OriginalObservation> {
  const requester=await readCurrentAccessMember(value.scope.actorId,getToken,signal);
  if(!requesterMatches(value.scope,requester))throw new RequestError('RECOVERY_IDENTITY_CHANGED','Current owner membership no longer matches the original requester.',403);
  const target=value.original.kind==='grant'?await readCurrentAccessCandidate(value.targetIdentity.externalMembershipId,getToken,signal):await readCurrentAccessMember(value.original.targetActorId,getToken,signal);
  if(!target||target.externalSubject!==value.targetIdentity.externalSubject||target.externalMembershipId!==value.targetIdentity.externalMembershipId||('externalOrganizationId'in target&&target.externalOrganizationId!==value.scope.organizationId))throw new RequestError('RECOVERY_TARGET_CHANGED','The original target membership cannot be verified. Check the original result again; no identity will be substituted.');
  return {requester,target,observedAt:new Date().toISOString()};
}
