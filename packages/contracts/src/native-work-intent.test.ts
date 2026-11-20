import { describe, expect, it } from 'vitest';
import { NativeWorkIntentPrepareSchema, NativeWorkIntentConfirmSchema, NativeWorkIntentPrepareResponseSchema, NativeWorkIntentRecoveryResponseSchema,
  NativeWorkIntentSessionObservationSchema, NativeWorkIntentProvenanceQuerySchema } from './native-work-intent';
const input={siteId:'site_one',title:'Compare chairs',prompt:'Compare chair options.',selections:[],continuesAfterSignOut:true};
const scope={environment:'development',organizationId:'org_one',siteId:'site_one'};
const review={id:'review_one',token:'a'.repeat(64),preparedAt:'2026-11-18T12:00:00.000Z',confirmBy:'2026-11-18T12:05:00.000Z',expiresAt:'2026-11-19T12:00:00.000Z',
 body:{title:input.title,prompt:input.prompt,siteName:'Main office',selectedNotes:[],allowedWork:['Research public sources','Draft advice'],continuesAfterSignOut:true,externalEffects:'forbidden'}};
const operation={scope,id:'operation_one',reviewId:review.id,rootTaskId:'root_one',title:input.title,committedAt:'2026-11-18T12:01:00.000Z',expiresAt:review.expiresAt,continuesAfterSignOut:true,kind:'delegated_advice'};
describe('human work intent public boundary',()=>{
 it('admits explicit no-memory background advice without authority input',()=>expect(NativeWorkIntentPrepareSchema.parse(input)).toEqual(input));
 it.each(['scope','service','issuer','limits','role','providerIssuer','sessionVerifiedAt'])('rejects caller-controlled %s',key=>expect(NativeWorkIntentPrepareSchema.safeParse({...input,[key]:{}}).success).toBe(false));
 it('requires explicit continuation consent and explicit selections',()=>{
  expect(NativeWorkIntentPrepareSchema.safeParse({...input,continuesAfterSignOut:false}).success).toBe(false);
  const {selections,...missing}=input;expect(NativeWorkIntentPrepareSchema.safeParse(missing).success).toBe(false);
  expect(NativeWorkIntentConfirmSchema.safeParse({reviewId:review.id,reviewToken:review.token}).success).toBe(false);
 });
 it('rejects duplicate notes, unbounded note selections and oversized text',()=>{
  const note={noteId:'note_one',expected:'a'.repeat(64)};
  expect(NativeWorkIntentPrepareSchema.safeParse({...input,selections:[note,note]}).success).toBe(false);
  expect(NativeWorkIntentPrepareSchema.safeParse({...input,selections:Array.from({length:33},(_,i)=>({...note,noteId:'note_'+i}))}).success).toBe(false);
  expect(NativeWorkIntentPrepareSchema.safeParse({...input,prompt:'x'.repeat(12001)}).success).toBe(false);
 });
 it('keeps observer evidence out of confirmation bodies',()=>{
  const confirmation={reviewId:review.id,reviewToken:review.token,continuesAfterSignOut:true};expect(NativeWorkIntentConfirmSchema.parse(confirmation)).toEqual(confirmation);
  expect(NativeWorkIntentConfirmSchema.safeParse({...confirmation,sessionVerifiedAt:review.preparedAt}).success).toBe(false);
  expect(NativeWorkIntentSessionObservationSchema.safeParse({providerIssuer:'https://test.clerk.accounts.dev',sessionVerifiedAt:review.preparedAt,sessionExpiresAt:review.expiresAt}).success).toBe(true);
 });
 it('rejects invented memory capability, mismatched operation and renewed review lifetime',()=>{
  expect(NativeWorkIntentPrepareResponseSchema.safeParse({scope,review,operation}).success).toBe(true);
  expect(NativeWorkIntentPrepareResponseSchema.safeParse({scope,review:{...review,body:{...review.body,allowedWork:['Research public sources','Read selected notes','Draft advice']}},operation:null}).success).toBe(false);
  expect(NativeWorkIntentPrepareResponseSchema.safeParse({scope,review,operation:{...operation,reviewId:'other'}}).success).toBe(false);
  expect(NativeWorkIntentPrepareResponseSchema.safeParse({scope,review:{...review,expiresAt:'2026-11-20T12:00:00.000Z'},operation:null}).success).toBe(false);
 });
 it('keeps unknown recovery distinct from operation recovery',()=>{
  expect(NativeWorkIntentRecoveryResponseSchema.safeParse({scope,review:null,operation:null,reviewUnavailable:false}).success).toBe(true);
  expect(NativeWorkIntentRecoveryResponseSchema.safeParse({scope,review:null,operation,reviewUnavailable:false}).success).toBe(false);
  expect(NativeWorkIntentRecoveryResponseSchema.safeParse({scope,review,operation:{...operation,scope:{...scope,siteId:'other'}},reviewUnavailable:false}).success).toBe(false);
 });
 it('recovers committed work with an explicitly withheld review and rejects inconsistent redaction',()=>{
  expect(NativeWorkIntentRecoveryResponseSchema.safeParse({scope,review:null,operation,reviewUnavailable:true}).success).toBe(true);
  expect(NativeWorkIntentRecoveryResponseSchema.safeParse({scope,review,operation,reviewUnavailable:true}).success).toBe(false);
  expect(NativeWorkIntentRecoveryResponseSchema.safeParse({scope,review:null,operation:null,reviewUnavailable:true}).success).toBe(false);
  expect(NativeWorkIntentRecoveryResponseSchema.safeParse({scope,review:null,operation:{...operation,scope:{...scope,siteId:'other'}},reviewUnavailable:true}).success).toBe(false);
 });
 it('bounds internal provenance lookups and rejects duplicate IDs',()=>{
  expect(NativeWorkIntentProvenanceQuerySchema.safeParse({siteId:'site_one',ids:['one','one']}).success).toBe(false);
  expect(NativeWorkIntentProvenanceQuerySchema.safeParse({siteId:'site_one',ids:Array.from({length:101},(_,i)=>'id_'+i)}).success).toBe(false);
 });
});
