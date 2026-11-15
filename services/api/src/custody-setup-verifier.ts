import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CustodyConfirmationSchema,CustodyInstantSchema,CustodyOwnerSchema,CustodySignatureSchema,
  CustodyUuidSchema,CustodyWalletChallengeSchema,HashSchema,IdSchema} from '@pactwoven/contracts';
import {MandateIdentitySchema,CustodyIdentityEvidenceSchema,CustodyWalletEvidenceSchema,CustodyMfaEvidenceSchema,verifyCustodyWalletEvidence,type CustodyAuthEvidence,type VerifiedIdentity} from '@pactwoven/db';
import {canonicalJson,commandDigest,custodyRecordHash,DomainError} from '@pactwoven/domain';
import {createClerkFactorVerification,createClerkIdentityObservationVerifier,type ClerkIdentityConfig,type ClerkIdentityObservation} from './auth.js';

export const CustodyApiOwnerScopeSchema=z.strictObject({environment:z.literal('development'),organizationId:IdSchema,
 externalOrganizationId:IdSchema,responsibilityId:IdSchema,owner:CustodyOwnerSchema});
export type CustodyApiOwnerScope=z.infer<typeof CustodyApiOwnerScopeSchema>;
const ObservationSchema=z.strictObject({identity:MandateIdentitySchema,observation:z.strictObject({issuer:z.string().url().max(512),
 tokenHash:HashSchema,tokenIssuedAt:CustodyInstantSchema,observedAt:CustodyInstantSchema,expiresAt:CustodyInstantSchema})});
const FactorsSchema=z.strictObject({identity:MandateIdentitySchema,evidence:z.strictObject({id:CustodyUuidSchema,subject:IdSchema,
 externalOrganizationId:IdSchema,externalMembershipId:IdSchema,sessionId:z.string().min(1).max(256),issuer:z.string().url().max(512),tokenHash:HashSchema,
 tokenIssuedAt:CustodyInstantSchema,firstFactorAgeMinutes:z.number().int().min(0).max(1000000),secondFactorAgeMinutes:z.number().int().min(0).max(1000000),
 verifiedAt:CustodyInstantSchema,observedAt:CustodyInstantSchema,expiresAt:CustodyInstantSchema})});
export type CustodyApiIdentityEvidence=z.infer<typeof CustodyIdentityEvidenceSchema>;
export type CustodyApiWalletEvidence=z.infer<typeof CustodyWalletEvidenceSchema>;
export type CustodyApiMfaEvidence=z.infer<typeof CustodyMfaEvidenceSchema>;
export type CustodyApiEvidence=CustodyAuthEvidence;
type PrivateCommon=Pick<CustodyApiIdentityEvidence,'schemaVersion'|'id'|'environment'|'organizationId'|'owner'|'observedAt'|'expiresAt'>;
type PrivateIdentityFields=Pick<CustodyApiIdentityEvidence,'externalOrganizationId'|'externalRole'|'issuer'|'tokenHash'|'tokenIssuedAt'>;
export type CustodyApiObservation=z.infer<typeof ObservationSchema>;
export type CustodyApiVerifier={
 observe(token:string):Promise<CustodyApiObservation>;
 assertFresh(observation:CustodyApiObservation,scope:CustodyApiOwnerScope):void;
 identityEvidence(observation:CustodyApiObservation,scope:CustodyApiOwnerScope):CustodyApiIdentityEvidence;
 walletEvidence(observation:CustodyApiObservation,scope:CustodyApiOwnerScope,challenge:unknown,signature:string):Promise<CustodyApiWalletEvidence>;
 mfaEvidence(token:string,before:CustodyApiObservation,scope:CustodyApiOwnerScope,confirmation:unknown):Promise<CustodyApiMfaEvidence>;
};
export type CustodyApiVerifierDependencies={observe:(token:string)=>Promise<ClerkIdentityObservation>;
 verifyFactors:ReturnType<typeof createClerkFactorVerification>;now?:()=>number;newId?:()=>string};
const denied=()=>new DomainError('CUSTODY_ACCESS_DENIED',403,'Review the setup with the current organization owner.');
const expired=()=>new DomainError('CUSTODY_EXPIRED',409,'The setup verification expired. Check the original request before continuing.');
const instant=(n:number)=>new Date(n).toISOString();
function sameIdentity(a:VerifiedIdentity,b:VerifiedIdentity){return a.subject===b.subject&&a.externalOrganizationId===b.externalOrganizationId&&
 a.externalMembershipId===b.externalMembershipId&&a.externalRole===b.externalRole&&a.sessionId===b.sessionId;}
export function custodyApiSignatureHash(signatureInput:string):string{return createHash('sha256').update(Buffer.from(CustodySignatureSchema.parse(signatureInput),'base64')).digest('hex');}

/** Injected functions are private, root-approved authenticators. Their output never comes from public JSON. */
export function createCustodyApiVerifier(dependencies:CustodyApiVerifierDependencies):CustodyApiVerifier {
 const observe=dependencies.observe,verifyFactors=dependencies.verifyFactors,now=dependencies.now??Date.now,newId=dependencies.newId??(()=>crypto.randomUUID());
 function oldestObservation(values:string[],at:number):number {
  const instants=values.map(Date.parse);
  if(!Number.isFinite(at)||instants.some(value=>!Number.isFinite(value)||value>at))throw expired();
  return Math.min(...instants);
 }
 function checked(input:CustodyApiObservation):CustodyApiObservation {
  const v=ObservationSchema.parse(input),at=now(),observed=oldestObservation([v.observation.observedAt,v.identity.membershipObservedAt],at);
  if(observed<at-20000||Date.parse(v.observation.expiresAt)<=at)throw expired();
  if(Date.parse(v.observation.tokenIssuedAt)>observed)throw denied();
  return {...v,observation:{...v.observation,observedAt:instant(observed)}};
 }
 function bound(input:CustodyApiObservation,scopeInput:CustodyApiOwnerScope){const v=checked(input),scope=CustodyApiOwnerScopeSchema.parse(scopeInput);
  if(scope.externalOrganizationId!==v.identity.externalOrganizationId||scope.owner.subject!==v.identity.subject||scope.owner.externalMembershipId!==v.identity.externalMembershipId||scope.owner.sessionId!==v.identity.sessionId)throw denied();
  return {v,scope};
 }
 function common(v:CustodyApiObservation,scope:CustodyApiOwnerScope,expiresAt=Date.parse(v.observation.expiresAt)):PrivateCommon {
  return {schemaVersion:1,id:CustodyUuidSchema.parse(newId()),environment:'development',organizationId:scope.organizationId,owner:{...scope.owner},
   observedAt:v.observation.observedAt,expiresAt:instant(Math.min(expiresAt,Date.parse(v.observation.expiresAt),Date.parse(v.observation.observedAt)+300000))};
 }
 const identityFields=(v:CustodyApiObservation):PrivateIdentityFields=>({externalOrganizationId:v.identity.externalOrganizationId,externalRole:v.identity.externalRole,
  issuer:v.observation.issuer,tokenHash:v.observation.tokenHash,tokenIssuedAt:v.observation.tokenIssuedAt});
 return {
  async observe(token){return checked(ObservationSchema.parse(await observe(token)));},
  assertFresh(observation,scope){bound(observation,scope);},
  identityEvidence(observation,scopeInput){const {v,scope}=bound(observation,scopeInput);return CustodyIdentityEvidenceSchema.parse({...common(v,scope),...identityFields(v),kind:'identity',purpose:'custody_setup_observation'});},
  async walletEvidence(observation,scopeInput,challengeInput,signatureInput){
   const challenge=CustodyWalletChallengeSchema.parse(challengeInput),signature=CustodySignatureSchema.parse(signatureInput),{v,scope}=bound(observation,scopeInput);
   if(challenge.organizationId!==scope.organizationId||challenge.responsibilityId!==scope.responsibilityId||challenge.actorId!==scope.owner.actorId||canonicalJson(challenge.owner)!==canonicalJson(scope.owner))throw denied();
   if(Date.parse(challenge.expiresAt)<=now()||Date.parse(challenge.issuedAt)>now())throw expired();
   const signatureHash=custodyApiSignatureHash(signature),recordHash=await custodyRecordHash(challenge);
   bound(v,scope);if(Date.parse(challenge.expiresAt)<=now())throw expired();
   const evidence=CustodyWalletEvidenceSchema.parse({...common(v,scope,Date.parse(challenge.expiresAt)),kind:'wallet',purpose:'custody_setup_wallet',setupId:challenge.setupId,
    challenge:{id:challenge.id,version:challenge.version,recordHash},signature,signatureHash});
   let verified:CustodyApiWalletEvidence;
   try{verified=CustodyWalletEvidenceSchema.parse(await verifyCustodyWalletEvidence(evidence,challenge));}
   catch{throw new DomainError('CUSTODY_INPUT_INVALID',422,'The wallet signature does not match this setup challenge.');}
   bound(v,scope);if(Date.parse(challenge.expiresAt)<=now())throw expired();return verified;
  },
  async mfaEvidence(token,beforeInput,scopeInput,confirmationInput){
   const before=ObservationSchema.parse(beforeInput),scope=CustodyApiOwnerScopeSchema.parse(scopeInput),confirmation=CustodyConfirmationSchema.parse(confirmationInput);
   bound(before,scope);const intent=confirmation.intent;
   if(confirmation.organizationId!==scope.organizationId||confirmation.responsibilityId!==scope.responsibilityId||confirmation.actorId!==scope.owner.actorId||
    intent.setupId!==confirmation.setupId||intent.organizationId!==scope.organizationId||intent.responsibilityId!==scope.responsibilityId||canonicalJson(intent.owner)!==canonicalJson(scope.owner))throw denied();
   if(confirmation.intentHash!==await commandDigest(intent)||confirmation.requestHash!==await commandDigest({schemaVersion:1,purpose:'custody_setup_owner_binding',request:{nonce:intent.nonce,key:intent.key,intent}}))throw denied();
   if(Date.parse(confirmation.expiresAt)<=now()||Date.parse(confirmation.issuedAt)>now())throw expired();
   const current=FactorsSchema.parse(await verifyFactors(token)),e=current.evidence;
   if(!sameIdentity(before.identity,current.identity)||e.subject!==current.identity.subject||e.externalOrganizationId!==current.identity.externalOrganizationId||
    e.externalMembershipId!==current.identity.externalMembershipId||e.sessionId!==current.identity.sessionId||e.issuer!==before.observation.issuer||
    e.tokenHash!==before.observation.tokenHash||e.tokenIssuedAt!==before.observation.tokenIssuedAt)throw denied();
   const oldest=oldestObservation([before.observation.observedAt,before.identity.membershipObservedAt,current.identity.membershipObservedAt,e.observedAt],now());
   const verified=Date.parse(e.tokenIssuedAt)-(Math.max(e.firstFactorAgeMinutes,e.secondFactorAgeMinutes)+1)*60000;
   if(Date.parse(e.verifiedAt)!==verified||Date.parse(e.expiresAt)>verified+300000)throw denied();
   const expiry=Math.min(Date.parse(e.expiresAt),Date.parse(before.observation.expiresAt),Date.parse(confirmation.expiresAt),oldest+300000);
   const combined=checked({identity:{...current.identity,membershipObservedAt:instant(oldest)},observation:{...before.observation,observedAt:instant(oldest),expiresAt:instant(expiry)}});
   bound(combined,scope);
   return CustodyMfaEvidenceSchema.parse({...common(combined,scope,expiry),...identityFields(combined),kind:'mfa',purpose:'custody_setup_owner_binding',confirmationId:confirmation.id,
    intentHash:confirmation.intentHash,requestHash:confirmation.requestHash,nonce:intent.nonce,key:intent.key,firstFactorAgeMinutes:e.firstFactorAgeMinutes,
    secondFactorAgeMinutes:e.secondFactorAgeMinutes,verifiedAt:e.verifiedAt});
  },
 };
}
/** Production construction reuses the independently accepted Clerk extraction exactly. */
export function createClerkCustodySetupVerifier(config:ClerkIdentityConfig):CustodyApiVerifier {
 const snapshot={...config,authorizedParties:[...config.authorizedParties]};
 return createCustodyApiVerifier({observe:createClerkIdentityObservationVerifier(snapshot),verifyFactors:createClerkFactorVerification(snapshot)});
}
