import type{Hono}from'hono';import{z}from'zod';import{IdSchema,IdempotencyKeySchema}from'@pactwoven/contracts';import{DomainError}from'@pactwoven/domain';
import{NativeGoogleError}from'../../../packages/contracts/src/native-google';import type{ApiEnv}from'./app.js';import type{NativeGoogleGateway}from'./native-google-service.js';
const State=z.string().regex(/^[A-Za-z0-9_-]{43}$/),Version=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),Empty=z.strictObject({});
/** Register under the shared bounded JSON/auth middleware. Never accept code/state in URLs or redirect to request-host values. */
export function registerNativeGoogleRoutes(app:Hono<ApiEnv>,gateway?:NativeGoogleGateway){
 const invoke=async(c:any,work:(g:NativeGoogleGateway,bearer:string,signal:AbortSignal)=>Promise<unknown>)=>{
  if([...new URL(c.req.url).searchParams].length)throw new DomainError('VALIDATION_FAILED',422,'Use the private request body.');
  if(!gateway)throw new DomainError('SETUP_REQUIRED',503,'Google Calendar access is not connected yet.');
  if(c.req.header('Origin')!==gateway.publicWebOrigin)throw new DomainError('FORBIDDEN',403,'Use the approved workspace origin.');
  const auth=c.req.header('Authorization')??'';if(!/^Bearer [^\s]+$/.test(auth))throw new DomainError('AUTH_REQUIRED',401,'Sign in to continue.');
  c.header('Cache-Control','private, no-store');c.header('Referrer-Policy','no-referrer');
  try{return c.json(await work(gateway,auth.slice(7),c.req.raw.signal));}catch(e){if(e instanceof NativeGoogleError){const statuses={GOOGLE_DENIED:403,GOOGLE_CONFLICT:409,GOOGLE_NO_CHANGE:409,GOOGLE_UNAVAILABLE:503,GOOGLE_INTEGRATION_REQUIRED:503,GOOGLE_OUTCOME_UNKNOWN:503}as const;throw new DomainError(e.code,statuses[e.code],e.code==='GOOGLE_OUTCOME_UNKNOWN'?'The operation was not confirmed. Recover the original request before retrying.':e.message);}throw e;}
 };
 app.post('/v1/google/connect',c=>invoke(c,(g,b,s)=>{Empty.parse(c.get('requestBody'));return g.begin(b,s);}));
 app.post('/v1/google/callback',c=>invoke(c,(g,b,s)=>g.callback(b,z.strictObject({state:State,code:z.string().min(1).max(8192)}).parse(c.get('requestBody')),s)));
 app.post('/v1/google/recover',c=>invoke(c,(g,b,s)=>g.recover(b,z.strictObject({state:State}).parse(c.get('requestBody')).state,s)));
 app.post('/v1/google/revoke',c=>invoke(c,async(g,b,s)=>{const q=z.strictObject({connectionId:IdSchema,expectedVersion:Version}).parse(c.get('requestBody'));await g.revokeConnection(b,q.connectionId,q.expectedVersion,s);return{status:'revoked'};}));
 app.post('/v1/google/consent/prepare',c=>invoke(c,(g,b,s)=>g.prepare(b,IdempotencyKeySchema.parse(c.req.header('Idempotency-Key')),c.get('requestBody'),s)));
 app.post('/v1/google/consent/confirm',c=>invoke(c,(g,b,s)=>g.confirm(b,IdempotencyKeySchema.parse(c.req.header('Idempotency-Key')),c.get('requestBody'),s)));
 app.post('/v1/google/consent/recover',c=>invoke(c,(g,b,s)=>g.receipt(b,z.strictObject({reviewId:IdSchema}).parse(c.get('requestBody')).reviewId,s)));
 app.post('/v1/google/consent/revoke',c=>invoke(c,(g,b,s)=>{const q=z.strictObject({consentId:IdSchema,expectedVersion:Version}).parse(c.get('requestBody'));return g.revokeConsent(b,q.consentId,q.expectedVersion,s);}));
}
