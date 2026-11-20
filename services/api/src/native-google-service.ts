import{randomUUID}from'node:crypto';import{z}from'zod';
import type{FoundationRepository}from'@pactwoven/db';
import{NativeGoogleError,NativeGoogleSessionSchema,type NativeGoogleSignedSessionSource}from'../../../packages/contracts/src/native-google';
import{NativeGoogleConsentPrepareSchema,NativeGoogleConsentConfirmSchema}from'../../../packages/contracts/src/native-google-access';
import{PostgresNativeGoogleAccessRepository}from'../../../packages/db/src/native-google-access-repository';
import type{PostgresNativeCommunicationReviewRepository,PostgresNativeCommunicationRepository}from'../../../packages/db/src/native-communication-repository';
interface GoogleConnections {readonly binding:Readonly<{clientId:string;redirectUri:string;expectedEmail:string}>;begin(bearer:string,signal:AbortSignal):Promise<{authorizationUrl:string}>;callback(bearer:string,input:{state:string;code:string},signal:AbortSignal):Promise<{connectionId:string}>;recover(bearer:string,state:string,signal:AbortSignal):Promise<unknown>;revoke(bearer:string,id:string,version:number,signal:AbortSignal):Promise<void>}
import{createClerkIdentityObservationVerifier,type ClerkIdentityConfig,type ClerkIdentityObservation}from'./auth.js';
export const GOOGLE_CALLBACK_PATH='/app/settings/connections/google/callback';
export function googleOAuthConfiguration(input:unknown){
 const q=z.strictObject({publicWebOrigin:z.url(),clientId:z.string().regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/),clientSecret:z.string().min(1).max(8192),expectedEmail:z.literal('richverseecotech@gmail.com')}).safeParse(input);
 if(!q.success)throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');const u=new URL(q.data.publicWebOrigin);
 if(u.protocol!=='https:'||u.origin!==q.data.publicWebOrigin||u.username||u.password)throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');
 return Object.freeze({clientId:q.data.clientId,clientSecret:q.data.clientSecret,redirectUri:u.origin+GOOGLE_CALLBACK_PATH,expectedEmail:q.data.expectedEmail,publicWebOrigin:u.origin});
}
/** All identity fields originate from signature verification plus current Clerk session and membership lookup. */
export class NativeGoogleClerkSessionSource implements NativeGoogleSignedSessionSource{
 constructor(private readonly verify:(bearer:string)=>Promise<ClerkIdentityObservation>,private readonly foundation:Pick<FoundationRepository,'getSession'>,private readonly access:Pick<PostgresNativeGoogleAccessRepository,'retainSession'>){}
 async resolve(bearer:string,signal:AbortSignal){signal.throwIfAborted();const v=await this.verify(bearer);signal.throwIfAborted();const current=await this.foundation.getSession(v.identity,randomUUID());
  const s=NativeGoogleSessionSchema.parse({actor:current.actor,subject:v.identity.subject,proofId:randomUUID(),verifiedAt:v.observation.observedAt,expiresAt:v.observation.expiresAt}),now=Date.now();
  if(s.actor.sessionId!==v.identity.sessionId||s.actor.authenticatedAt!==v.identity.authenticatedAt||s.actor.principalKind!=='human'||!s.actor.roles.some(r=>r==='owner'||r==='operations')||Date.parse(s.verifiedAt)>now||Date.parse(s.verifiedAt)<=now-20000||Date.parse(s.expiresAt)<=now)throw new NativeGoogleError('GOOGLE_DENIED');
  signal.throwIfAborted();return this.access.retainSession({session:s,issuer:v.observation.issuer,externalOrganizationId:v.identity.externalOrganizationId,externalMembershipId:v.identity.externalMembershipId,externalRole:v.identity.externalRole,tokenHash:v.observation.tokenHash,tokenIssuedAt:v.observation.tokenIssuedAt});
 }
}
export function createNativeGoogleClerkSessions(config:ClerkIdentityConfig,foundation:Pick<FoundationRepository,'getSession'>,access:PostgresNativeGoogleAccessRepository){return new NativeGoogleClerkSessionSource(createClerkIdentityObservationVerifier(config),foundation,access);}
/** Composition is unavailable unless the exact reviewed OAuth configuration and all protected adapters exist. */
export class NativeGoogleGateway{
 constructor(readonly publicWebOrigin:string,private readonly sessions:NativeGoogleSignedSessionSource,private readonly connections:GoogleConnections,private readonly access:PostgresNativeGoogleAccessRepository,private readonly reviews:Pick<PostgresNativeCommunicationReviewRepository,'retain'>,private readonly communication:Pick<PostgresNativeCommunicationRepository,'issue'|'revoke'>){const u=new URL(publicWebOrigin);if(u.protocol!=='https:'||u.origin!==publicWebOrigin||connections.binding?.redirectUri!==publicWebOrigin+GOOGLE_CALLBACK_PATH||connections.binding?.expectedEmail!=='richverseecotech@gmail.com'||!Object.isFrozen(connections.binding))throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');}
 async begin(b:string,s:AbortSignal){const answer=await this.connections.begin(b,s);s.throwIfAborted();const u=new URL(answer.authorizationUrl);if(u.origin!=='https://accounts.google.com'||u.pathname!=='/o/oauth2/v2/auth'||u.username||u.password||u.hash||u.searchParams.getAll('client_id').length!==1||u.searchParams.get('client_id')!==this.connections.binding.clientId||u.searchParams.getAll('redirect_uri').length!==1||u.searchParams.get('redirect_uri')!==this.publicWebOrigin+GOOGLE_CALLBACK_PATH)throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');return answer;}callback(b:string,q:{state:string;code:string},s:AbortSignal){return this.connections.callback(b,q,s);}recover(b:string,state:string,s:AbortSignal){return this.connections.recover(b,state,s);}revokeConnection(b:string,id:string,version:number,s:AbortSignal){return this.connections.revoke(b,id,version,s);}
 async prepare(b:string,key:string,input:unknown,signal:AbortSignal){const q=NativeGoogleConsentPrepareSchema.parse(input);return this.access.prepare(await this.sessions.resolve(b,signal),key,q);}
 async confirm(b:string,key:string,input:unknown,signal:AbortSignal){const q=NativeGoogleConsentConfirmSchema.parse(input),s=await this.sessions.resolve(b,signal);const retained=await this.access.confirm(s,key,q);if(retained.status==='active'||retained.status==='revoked')return retained;const proof=await this.reviews.retain(q.reviewId,signal);signal.throwIfAborted();await this.communication.issue(s.actor,proof);return this.access.receipt(s,q.reviewId);}
 async receipt(b:string,id:string,signal:AbortSignal){return this.access.receipt(await this.sessions.resolve(b,signal),id);}
 async revokeConsent(b:string,id:string,version:number,signal:AbortSignal){const s=await this.sessions.resolve(b,signal);return this.access.revokeConsent(s,id,version);}
}
