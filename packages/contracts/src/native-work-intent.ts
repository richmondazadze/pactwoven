import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdSchema, InstantSchema } from './core';
import { NativeProviderIssuerSchema } from './native-authority';

const text = (maximum: number) => z.string().min(1).max(maximum).regex(/\S/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeWorkIntentSelectionSchema = z.strictObject({ noteId: IdSchema, expected: Digest });
export const NativeWorkIntentPrepareSchema = z.strictObject({
  siteId: IdSchema, title: text(180), prompt: text(12000),
  selections: z.array(NativeWorkIntentSelectionSchema).max(32).refine(value => new Set(value.map(note => note.noteId)).size === value.length, 'Select each note once.'),
  continuesAfterSignOut: z.literal(true),
});
export const NativeWorkIntentConfirmSchema = z.strictObject({ reviewId: IdSchema, reviewToken: Digest, continuesAfterSignOut: z.literal(true) });
export const NativeWorkIntentScopeSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, siteId: IdSchema });
export const NativeWorkIntentSelectedNoteSchema = z.strictObject({
  noteId: IdSchema, title: text(180), text: text(8000), purpose: text(1000), reviewBy: InstantSchema,
  suppliedBy: text(180), sourceLabel: z.literal('Human statement — not independently verified'),
});
export const NativeWorkIntentReviewBodySchema = z.strictObject({
  title: text(180), prompt: text(12000), siteName: text(180), selectedNotes: z.array(NativeWorkIntentSelectedNoteSchema).max(32),
  allowedWork: z.array(z.enum(['Research public sources', 'Read selected notes', 'Draft advice'])).min(2).max(3),
  continuesAfterSignOut: z.literal(true), externalEffects: z.literal('forbidden'),
}).refine(value => JSON.stringify(value.allowedWork) === JSON.stringify(value.selectedNotes.length
  ? ['Research public sources', 'Read selected notes', 'Draft advice'] : ['Research public sources', 'Draft advice']), 'Capabilities must match the selected context.');
export const NativeWorkIntentReviewSchema = z.strictObject({
  id: IdSchema, token: Digest, preparedAt: InstantSchema, confirmBy: InstantSchema, expiresAt: InstantSchema,
  body: NativeWorkIntentReviewBodySchema,
}).refine(value => Date.parse(value.confirmBy) > Date.parse(value.preparedAt) && Date.parse(value.confirmBy) - Date.parse(value.preparedAt) <= 300000 &&
  Date.parse(value.expiresAt) - Date.parse(value.preparedAt) === 86400000, 'Review and fixed work deadlines must agree.');
export const NativeWorkIntentOperationSchema = z.strictObject({
  scope: NativeWorkIntentScopeSchema, id: IdSchema, reviewId: IdSchema, rootTaskId: IdSchema, title: text(180),
  committedAt: InstantSchema, expiresAt: InstantSchema, continuesAfterSignOut: z.literal(true), kind: z.literal('delegated_advice'),
});
export const NativeWorkIntentPrepareResponseSchema = z.strictObject({
  scope: NativeWorkIntentScopeSchema, review: NativeWorkIntentReviewSchema, operation: NativeWorkIntentOperationSchema.nullable(),
}).refine(value => !value.operation || (JSON.stringify(value.operation.scope) === JSON.stringify(value.scope) && value.operation.reviewId === value.review.id &&
  value.operation.expiresAt === value.review.expiresAt && value.operation.title === value.review.body.title), 'Operation must match its reviewed request.');
export const NativeWorkIntentRecoveryResponseSchema = z.strictObject({
  scope: NativeWorkIntentScopeSchema, review: NativeWorkIntentReviewSchema.nullable(), operation: NativeWorkIntentOperationSchema.nullable(),
  reviewUnavailable: z.boolean(),
}).refine(value => value.reviewUnavailable
  ? value.review === null && value.operation !== null && JSON.stringify(value.operation.scope) === JSON.stringify(value.scope)
  : !value.operation || (value.review !== null && JSON.stringify(value.operation.scope) === JSON.stringify(value.scope) &&
    value.operation.reviewId === value.review.id && value.operation.expiresAt === value.review.expiresAt && value.operation.title === value.review.body.title),
  'Recover the original operation without disclosing an unavailable review.');
// Trusted server observer input. Never accept this object from a public body.
export const NativeWorkIntentSessionObservationSchema = z.strictObject({
  providerIssuer: NativeProviderIssuerSchema, sessionVerifiedAt: InstantSchema, sessionExpiresAt: InstantSchema,
});
export const NativeWorkIntentProvenanceQuerySchema = z.strictObject({ siteId: IdSchema, ids: z.array(IdSchema).max(100).refine(ids => new Set(ids).size === ids.length) });
export const NativeWorkIntentProvenanceResponseSchema = z.strictObject({ scope: NativeWorkIntentScopeSchema,
  items: z.array(z.strictObject({ provenanceId: IdSchema, rootTaskId: IdSchema })).max(100) });
export type NativeWorkIntentPrepare = z.infer<typeof NativeWorkIntentPrepareSchema>;
export type NativeWorkIntentConfirm = z.infer<typeof NativeWorkIntentConfirmSchema>;
export type NativeWorkIntentScope = z.infer<typeof NativeWorkIntentScopeSchema>;
export type NativeWorkIntentReview = z.infer<typeof NativeWorkIntentReviewSchema>;
export type NativeWorkIntentOperation = z.infer<typeof NativeWorkIntentOperationSchema>;
export type NativeWorkIntentPrepareResponse = z.infer<typeof NativeWorkIntentPrepareResponseSchema>;
export type NativeWorkIntentRecoveryResponse = z.infer<typeof NativeWorkIntentRecoveryResponseSchema>;
export type NativeWorkIntentSessionObservation = z.infer<typeof NativeWorkIntentSessionObservationSchema>;
export type NativeWorkIntentProvenanceResponse = z.infer<typeof NativeWorkIntentProvenanceResponseSchema>;
export interface NativeWorkIntentRepository {
  prepare(actor: z.infer<typeof ActorContextSchema>, key: string, input: NativeWorkIntentPrepare): Promise<NativeWorkIntentPrepareResponse>;
  confirm(actor: z.infer<typeof ActorContextSchema>, key: string, input: NativeWorkIntentConfirm, observation: NativeWorkIntentSessionObservation): Promise<NativeWorkIntentOperation>;
  recover(actor: z.infer<typeof ActorContextSchema>, siteId: string, key: string): Promise<NativeWorkIntentRecoveryResponse>;
  provenance(actor: z.infer<typeof ActorContextSchema>, siteId: string, ids: string[]): Promise<NativeWorkIntentProvenanceResponse>;
}
