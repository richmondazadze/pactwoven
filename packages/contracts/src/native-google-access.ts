import {z} from 'zod';
import {IdSchema,InstantSchema} from './core';
import {NativeChannelConsentRequestSchema,NativeChannelConsentApprovalSchema} from './native-communication';
import {NativeGoogleSessionSchema} from './native-google';
const Digest=z.string().regex(/^[a-f0-9]{64}$/),Opaque=z.string().min(1).max(512).regex(/^[^\s\u0000-\u001f\u007f]+$/);
export const NativeGoogleCalendarTargetSchema=z.strictObject({kind:z.literal('calendar_change'),calendarId:Opaque,eventId:Opaque,expectedEtag:Opaque});
export const NativeGoogleConsentPrepareSchema=z.strictObject({siteId:IdSchema,rootTaskId:IdSchema,connectionId:IdSchema,target:NativeGoogleCalendarTargetSchema,purpose:z.string().trim().min(1).max(1000),expiresAt:InstantSchema});
export const NativeGoogleConsentConfirmSchema=z.strictObject({reviewId:IdSchema,reviewToken:Digest,continuesAfterSignOut:z.literal(true)});
export const NativeGoogleConsentReviewSchema=z.strictObject({id:IdSchema,token:Digest,rootTitle:z.string().min(1).max(300),siteName:z.string().min(1).max(180),accountEmail:z.email().max(254),target:NativeGoogleCalendarTargetSchema,purpose:z.string().min(1).max(1000),preparedAt:InstantSchema,confirmBy:InstantSchema,expiresAt:InstantSchema,permission:z.literal('read_single_calendar_event'),outboundEffects:z.literal('forbidden'),continuesAfterSignOut:z.literal(true)});
export const NativeGoogleConsentReceiptSchema=z.strictObject({id:IdSchema,rootTitle:z.string().min(1).max(300),accountEmail:z.email().max(254),target:NativeGoogleCalendarTargetSchema,expiresAt:InstantSchema,status:z.enum(['prepared','approved','active','revoked'])});
// Server-only observer payload. No signed token, authorization code or OAuth token is retained here.
export const NativeGoogleIdentityEvidenceSchema=z.strictObject({session:NativeGoogleSessionSchema,issuer:z.url().max(261),externalOrganizationId:IdSchema,externalMembershipId:IdSchema,externalRole:z.string().min(1).max(100),tokenHash:Digest,tokenIssuedAt:InstantSchema});
export const NativeGoogleApprovedReviewSchema=z.strictObject({request:NativeChannelConsentRequestSchema,approval:NativeChannelConsentApprovalSchema});
export type NativeGoogleConsentPrepare=z.infer<typeof NativeGoogleConsentPrepareSchema>;
export type NativeGoogleConsentConfirm=z.infer<typeof NativeGoogleConsentConfirmSchema>;
export type NativeGoogleIdentityEvidence=z.infer<typeof NativeGoogleIdentityEvidenceSchema>;
