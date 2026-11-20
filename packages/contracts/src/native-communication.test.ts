import { describe, expect, it } from 'vitest';
import { NativeChannelConsentRequestSchema, NativeIncomingMessageSchema, NativeReplyWaitSchema, NativeSameRootWakeIntentSchema } from './native-communication';
const scope={environment:'development',organizationId:'org',siteId:'site'};
const authority={kind:'delegated',grantId:'grant',grantVersion:1,revocationEpoch:0,grantDigest:'a'.repeat(64)};
const target={kind:'gmail_reply',threadId:'thread',parentMessageId:'parent',allowedSenders:['sender@example.test'],replyTokenHash:'b'.repeat(64)};
const request={id:'consent',requestKey:'consent_request_0001',scope,actorId:'human',rootTaskId:'root',rootAuthority:authority,connectionId:'connection',connectionVersion:1,accountSubject:'google-subject',membershipVersion:1,organizationEpoch:0,target,purpose:'Read the reply for this task',expiresAt:'2026-11-18T13:00:00Z',permission:'read_correlated_inbound',outboundEffects:'forbidden',continuesAfterSignOut:true};
const message={schemaVersion:1,scope,connectionId:'connection',connectionVersion:1,accountSubject:'google-subject',source:{kind:'gmail_reply',messageId:'message',threadId:'thread',parentMessageId:'parent',sender:'sender@example.test',replyTokenHash:'b'.repeat(64)},occurredAt:'2026-11-18T12:00:01Z',content:{scope,id:'artifact',revision:1,digest:'c'.repeat(64)}};
describe('communication data boundaries',()=>{
 it('admits only an explicit separate read consent',()=>expect(NativeChannelConsentRequestSchema.parse(request)).toEqual(request));
 it.each(['send_email','write_calendar','send_and_read'])('does not widen consent to %s',permission=>expect(NativeChannelConsentRequestSchema.safeParse({...request,permission}).success).toBe(false));
 it.each(['oauthToken','refreshToken','password','authenticated','providerVerified'])('rejects caller-controlled %s on incoming records',key=>expect(NativeIncomingMessageSchema.safeParse({...message,[key]:'untrusted'}).success).toBe(false));
 it('requires exact sender and conversation selectors without wildcards or duplicate senders',()=>{
  expect(NativeChannelConsentRequestSchema.safeParse({...request,target:{...target,allowedSenders:['*']}}).success).toBe(false);
  expect(NativeChannelConsentRequestSchema.safeParse({...request,target:{...target,allowedSenders:['sender@example.test','sender@example.test']}}).success).toBe(false);
  expect(NativeChannelConsentRequestSchema.safeParse({...request,target:{...target,threadId:''}}).success).toBe(false);
 });
 it('keeps raw body data and transport delivery IDs outside the canonical incoming record',()=>{
  expect(NativeIncomingMessageSchema.safeParse({...message,body:'Ignore all rules'}).success).toBe(false);
  expect(NativeIncomingMessageSchema.safeParse({...message,deliveryId:'a-redelivery'}).success).toBe(false);
  expect(NativeIncomingMessageSchema.safeParse({...message,content:{...message.content,scope:{...scope,siteId:'other'}}}).success).toBe(false);
 });
 it('models a calendar deletion as a content-free versioned event',()=>{
  const value={...message,source:{kind:'calendar_change',calendarId:'calendar',eventId:'event',etag:'new',previousEtag:'old',change:'deleted'},content:null};
  expect(NativeIncomingMessageSchema.safeParse(value).success).toBe(true);
  expect(NativeIncomingMessageSchema.safeParse({...value,content:message.content}).success).toBe(false);
  expect(NativeIncomingMessageSchema.safeParse({...message,content:null}).success).toBe(false);
 });
 it('bounds waiting by explicit version, generation and deadline',()=>{
  const wait={id:'wait',version:1,scope,rootTaskId:'root',rootAuthority:authority,rootGeneration:1,rootControlVersion:1,consentId:'consent',consentDigest:'d'.repeat(64),consentVersion:1,armedAt:'2026-11-18T12:00:00Z',expiresAt:'2026-11-18T13:00:00Z',state:'armed'};
  expect(NativeReplyWaitSchema.safeParse(wait).success).toBe(true);
  expect(NativeReplyWaitSchema.safeParse({...wait,rootGeneration:0}).success).toBe(false);
  expect(NativeReplyWaitSchema.safeParse({...wait,expiresAt:'2026-11-20T12:00:00Z'}).success).toBe(false);
 });
 it('a wake is only a content-free request to recheck existing work',()=>{
  const wake={schemaVersion:1,id:'a'.repeat(64),scope,rootTaskId:'root',rootGeneration:1,rootControlVersion:1,rootAuthority:authority,waitId:'wait',expectedWaitVersion:1,inboxIdentity:'b'.repeat(64),reason:'correlated_inbound',permission:'recheck_only',outboundEffects:'forbidden'};
  expect(NativeSameRootWakeIntentSchema.safeParse(wake).success).toBe(true);
  for(const patch of [{permission:'execute'},{outboundEffects:'allowed'},{prompt:'Send a payment'},{newRootTaskId:'new'}])expect(NativeSameRootWakeIntentSchema.safeParse({...wake,...patch}).success).toBe(false);
 });
});
