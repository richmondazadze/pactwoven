import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canonicalJson, commandDigest } from '../../../../packages/contracts/src/canonical';
import { NativeIncomingMessageSchema, NativeIncomingVerificationSchema } from '../../../../packages/contracts/src/native-communication';
import { GOOGLE_READ_SCOPES, NativeGoogleAttemptSchema, NativeGoogleConnectionSchema, NativeGoogleEventSchema, NativeGoogleError,
  NativeGoogleProvenanceSchema, NativeGoogleSessionSchema, NativeGoogleSnapshotSchema, NativeGoogleTokensSchema,
  type NativeGoogleAttempt, type NativeGoogleBinding, type NativeGoogleConnection, type NativeGoogleContentSource,
  type NativeGoogleRead, type NativeGoogleSession, type NativeGoogleSignedSessionSource, type NativeGoogleSnapshot, type NativeGoogleStore,
} from '../../../../packages/contracts/src/native-google';
import { GoogleCredentialVault } from './vault';
import { exactGoogleReadScopes, type GoogleReadTransport, type GoogleTokenResult } from './transport';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const at = (ms: number) => new Date(ms).toISOString();
const same = (a: unknown,b: unknown) => canonicalJson(a) === canonicalJson(b);
function fresh(session: NativeGoogleSession, now: number) {
  if (session.actor.principalKind !== 'human' || !session.actor.roles.some(r => ['owner','operations'].includes(r)) ||
    Date.parse(session.verifiedAt) > now || now-Date.parse(session.verifiedAt) > 20000 || Date.parse(session.expiresAt) <= now || Date.parse(session.actor.authenticatedAt) > now) throw new NativeGoogleError('GOOGLE_DENIED');
}
function sameSession(a: NativeGoogleSession, b: NativeGoogleSession) {
  if (a.subject !== b.subject || a.actor.actorId !== b.actor.actorId || a.actor.sessionId !== b.actor.sessionId || a.actor.organizationId !== b.actor.organizationId ||
    a.actor.environment !== b.actor.environment || a.actor.authenticatedAt !== b.actor.authenticatedAt) throw new NativeGoogleError('GOOGLE_DENIED');
}
/** Local-only service until the root mounts real signed sessions, SQL authority
 * bridges, protected keys and immutable content. It has no browser/task handler. */
export class NativeGoogleConnectionService {
  private readonly config: Readonly<{ clientId: string; redirectUri: string; expectedEmail: string }>;
  /** Public configuration identity only; never includes credentials. */
  get binding() { return this.config; }
  constructor(config: { clientId: string; redirectUri: string; expectedEmail: string }, private readonly sessions: NativeGoogleSignedSessionSource,
    private readonly store: NativeGoogleStore, private readonly vault: GoogleCredentialVault, private readonly transport: GoogleReadTransport, private readonly now = Date.now) {
    const uri = new URL(config.redirectUri);
    if (!config.clientId || !config.expectedEmail || uri.username || uri.password || uri.hash || uri.search ||
      (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && uri.hostname === '127.0.0.1')) || !sessions || !store || !vault || !transport || transport.binding.clientId !== config.clientId || transport.binding.redirectUri !== config.redirectUri) throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');
    this.config = Object.freeze({ clientId: config.clientId, redirectUri: config.redirectUri, expectedEmail: config.expectedEmail.toLowerCase() });
  }
  private async session(bearer: string, signal: AbortSignal) {
    signal.throwIfAborted(); const session = NativeGoogleSessionSchema.parse(await this.sessions.resolve(bearer, signal)); signal.throwIfAborted(); fresh(session,this.now()); return session;
  }
  async begin(bearer: string, signal: AbortSignal): Promise<{ authorizationUrl: string }> {
    const session = await this.session(bearer,signal), state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url'), now=this.now();
    const binding: NativeGoogleBinding = { environment: session.actor.environment, organizationId: session.actor.organizationId, actorId: session.actor.actorId, connectionId: randomUUID(), connectionVersion: 1, credentialVersion: 1 };
    const attempt = NativeGoogleAttemptSchema.parse({ id: randomUUID(), stateHash:hash(state), session, binding, ...this.config,
      createdAt:at(now), expiresAt:at(Math.min(now+300000,Date.parse(session.expiresAt))), verifier:this.vault.seal({ verifier },binding,'oauth_pkce') });
    await this.store.createAttempt(attempt); signal.throwIfAborted();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id:this.config.clientId, redirect_uri:this.config.redirectUri, response_type:'code', scope:GOOGLE_READ_SCOPES.join(' '),
      state, code_challenge:createHash('sha256').update(verifier).digest('base64url'), code_challenge_method:'S256', access_type:'offline', prompt:'consent', include_granted_scopes:'false', login_hint:this.config.expectedEmail }).toString();
    return { authorizationUrl:url.href };
  }
  async callback(bearer: string, input: { state: string; code: string }, signal: AbortSignal): Promise<{ connectionId: string }> {
    if (!input || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || !input.code || input.code.length > 8192) throw new NativeGoogleError('GOOGLE_DENIED');
    let session = await this.session(bearer,signal); const operationId=randomUUID();
    const attempt=NativeGoogleAttemptSchema.parse(await this.store.reserveAttempt(hash(input.state),session,operationId));
    try {
      sameSession(attempt.session,session); fresh(session,this.now());
      if (attempt.clientId!==this.config.clientId || attempt.redirectUri!==this.config.redirectUri || attempt.expectedEmail!==this.config.expectedEmail || Date.parse(attempt.expiresAt)<=this.now()) throw new NativeGoogleError('GOOGLE_DENIED');
      const payload=this.vault.open(attempt.verifier,attempt.binding,'oauth_pkce') as {verifier?:unknown};
      if (!payload || Object.keys(payload).length!==1 || typeof payload.verifier!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.verifier)) throw new NativeGoogleError('GOOGLE_DENIED');
      const requestedAt=this.now(),result=await this.transport.exchange(input.code,payload.verifier,signal); exactGoogleReadScopes(result.scopes.join(' '));
      if(!result.refreshToken)throw new NativeGoogleError('GOOGLE_DENIED');
      const account=await this.transport.account(result.accessToken,signal);
      if(account.email!==attempt.expectedEmail)throw new NativeGoogleError('GOOGLE_DENIED');
      session=await this.session(bearer,signal);sameSession(attempt.session,session);
      const tokens=this.tokens(result,result.refreshToken,requestedAt);
      const connection=NativeGoogleConnectionSchema.parse({binding:attempt.binding,accountSubject:account.subject,accountEmail:account.email,clientId:attempt.clientId,
        scopes:[...GOOGLE_READ_SCOPES],status:'connected',tokens:this.vault.seal(tokens,attempt.binding,'oauth_tokens')});
      signal.throwIfAborted();await this.store.completeAttempt(attempt.id,session,operationId,connection);
      return { connectionId:connection.binding.connectionId };
    } catch (error) {
      await this.store.failAttempt(attempt.id,operationId).catch(()=>{});
      if(error instanceof NativeGoogleError && error.code==='GOOGLE_DENIED')throw error;
      throw new NativeGoogleError('GOOGLE_OUTCOME_UNKNOWN');
    }
  }
  /** Recover original callback outcome without resubmitting its one-use code. */
  async recover(bearer:string,state:string,signal:AbortSignal){
    if(!/^[A-Za-z0-9_-]{43}$/.test(state))throw new NativeGoogleError('GOOGLE_DENIED');
    return this.store.recoverAttempt(hash(state),await this.session(bearer,signal));
  }
  private tokens(result: GoogleTokenResult, refreshToken: string, requestedAt: number) {
    if(!Number.isInteger(result.expiresIn)||result.expiresIn<60||result.expiresIn>86400)throw new NativeGoogleError('GOOGLE_DENIED');
    return NativeGoogleTokensSchema.parse({ accessToken:result.accessToken,refreshToken,expiresAt:at(requestedAt+result.expiresIn*1000) });
  }
  async revoke(bearer:string,connectionId:string,expectedVersion:number,signal:AbortSignal):Promise<void>{
    const session=await this.session(bearer,signal);await this.store.revoke(connectionId,session,expectedVersion);
  }
  /** Rechecks account identity on every read, even when the access token is fresh. */
  async access(snapshot:NativeGoogleSnapshot,signal:AbortSignal):Promise<{snapshot:NativeGoogleSnapshot;accessToken:string}>{
    let current=NativeGoogleSnapshotSchema.parse(snapshot),connection=current.connection;
    this.checkRead(current);
    let tokens=NativeGoogleTokensSchema.parse(this.vault.open(connection.tokens,connection.binding,'oauth_tokens'));
    if(Date.parse(tokens.expiresAt)<=this.now()+30000){
      const operationId=randomUUID();
      const reserved=NativeGoogleConnectionSchema.parse(await this.store.reserveRefresh(current.read,connection.binding.credentialVersion,operationId));
      if(!same(reserved.binding,connection.binding)||reserved.status!=='refreshing')throw new NativeGoogleError('GOOGLE_CONFLICT');
      try{
        const requestedAt=this.now(),result=await this.transport.refresh(tokens.refreshToken,signal);exactGoogleReadScopes(result.scopes.join(' '));
        const account=await this.transport.account(result.accessToken,signal);
        if(account.subject!==connection.accountSubject||account.email!==connection.accountEmail)throw new NativeGoogleError('GOOGLE_DENIED');
        tokens=this.tokens(result,result.refreshToken??tokens.refreshToken,requestedAt);
        const binding={...connection.binding,credentialVersion:connection.binding.credentialVersion+1};
        connection=NativeGoogleConnectionSchema.parse({...connection,binding,status:'connected',tokens:this.vault.seal(tokens,binding,'oauth_tokens')});
        signal.throwIfAborted();await this.store.completeRefresh(current.read,operationId,connection);
      }catch{
        await this.store.failRefresh(connection.binding.connectionId,operationId).catch(()=>{});throw new NativeGoogleError('GOOGLE_OUTCOME_UNKNOWN');
      }
    }else{
      const account=await this.transport.account(tokens.accessToken,signal);
      if(account.subject!==connection.accountSubject||account.email!==connection.accountEmail)throw new NativeGoogleError('GOOGLE_DENIED');
    }
    current=NativeGoogleSnapshotSchema.parse(await this.store.resolveRead(connection.binding.connectionId,current.read.providerReference));this.checkRead(current);
    if(!same(current.connection.binding,connection.binding)||current.connection.status!=='connected')throw new NativeGoogleError('GOOGLE_CONFLICT');
    signal.throwIfAborted();return {snapshot:current,accessToken:tokens.accessToken};
  }
  checkRead(snapshot:NativeGoogleSnapshot){
    const {read,connection}=snapshot,request=read.request,binding=connection.binding,now=this.now();
    if(connection.status!=='connected'||request.target.kind!=='calendar_change'||request.connectionId!==binding.connectionId||request.connectionVersion!==binding.connectionVersion||
      request.accountSubject!==connection.accountSubject||request.actorId!==binding.actorId||request.scope.environment!==binding.environment||request.scope.organizationId!==binding.organizationId||
      connection.clientId!==this.config.clientId||connection.accountEmail!==this.config.expectedEmail||Date.parse(read.observedAt)>now||Date.parse(read.validUntil)<=now||
      Date.parse(read.validUntil)-Date.parse(read.observedAt)>20000||Date.parse(request.expiresAt)<=now)throw new NativeGoogleError('GOOGLE_DENIED');
  }
}
/** Structurally implements NativeCommunicationProviderSource without a forbidden
 * connectors -> DB import. Gmail sender proof is deliberately unsupported. */
export class NativeGoogleCalendarProviderSource {
  constructor(private readonly service:NativeGoogleConnectionService,private readonly store:NativeGoogleStore,private readonly transport:GoogleReadTransport,
    private readonly content:NativeGoogleContentSource,private readonly now=Date.now){
    if(!service||!store||!transport||!content)throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');
  }
  async fetchVerified(selector:Readonly<{connectionId:string;providerReference:string}>,signal:AbortSignal){
    const initial=NativeGoogleSnapshotSchema.parse(await this.store.resolveRead(selector.connectionId,selector.providerReference));
    if(initial.read.providerReference!==selector.providerReference||initial.connection.binding.connectionId!==selector.connectionId)throw new NativeGoogleError('GOOGLE_DENIED');
    const {snapshot,accessToken}=await this.service.access(initial,signal),read=snapshot.read,target=read.request.target;
    if(target.kind!=='calendar_change')throw new NativeGoogleError('GOOGLE_DENIED');
    const event=NativeGoogleEventSchema.parse(await this.transport.event(accessToken,target.calendarId,target.eventId,signal));
    // Provider observation time is fixed before private artifact persistence;
    // slow storage or a renewed read grant cannot make an old fetch fresh.
    const eventObservedAt=this.now();
    if(event.id!==target.eventId||Date.parse(event.updated)>eventObservedAt)throw new NativeGoogleError('GOOGLE_DENIED');
    if(event.etag===target.expectedEtag)throw new NativeGoogleError('GOOGLE_NO_CHANGE');
    const eventDigest=await commandDigest({namespace:'pactwoven/google-calendar-event/v1',event});
    const content=event.status==='cancelled'?null:await this.content.retain(read,event,eventDigest,signal);
    if(this.now()>=eventObservedAt+15000)throw new NativeGoogleError('GOOGLE_DENIED');
    const message=NativeIncomingMessageSchema.parse({schemaVersion:1,scope:read.request.scope,connectionId:selector.connectionId,connectionVersion:read.request.connectionVersion,
      accountSubject:read.request.accountSubject,source:{kind:'calendar_change',calendarId:target.calendarId,eventId:target.eventId,etag:event.etag,previousEtag:target.expectedEtag,change:event.status==='cancelled'?'deleted':'updated'},occurredAt:event.updated,content});
    const identityDigest=await commandDigest({namespace:'pactwoven/incoming-identity/v1',environment:message.scope.environment,organizationId:message.scope.organizationId,
      connectionId:message.connectionId,accountSubject:message.accountSubject,identity:{kind:'calendar_change',calendarId:target.calendarId,eventId:target.eventId,etag:event.etag}});
    const verification=NativeIncomingVerificationSchema.parse({messageDigest:await commandDigest({namespace:'pactwoven/incoming-message/v1',message}),identityDigest,
      connectionId:message.connectionId,connectionVersion:message.connectionVersion,accountSubject:message.accountSubject,authenticatedSender:null,observedAt:at(eventObservedAt),validUntil:at(eventObservedAt+15000)});
    const latest=NativeGoogleSnapshotSchema.parse(await this.store.resolveRead(selector.connectionId,selector.providerReference));this.service.checkRead(latest);
    if(!same(latest.read.request,read.request)||!same(latest.connection.binding,snapshot.connection.binding))throw new NativeGoogleError('GOOGLE_CONFLICT');
    signal.throwIfAborted();
    return NativeGoogleProvenanceSchema.parse(await this.store.retainObservation(latest.read,{provenanceId:randomUUID(),providerReference:selector.providerReference,eventDigest,message,verification}));
  }
}
