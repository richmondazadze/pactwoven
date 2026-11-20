import { z } from 'zod';
import { IdSchema, InstantSchema } from './core';
import { NativeMemoryReferenceSchema } from './native-memory';
import { NativeServiceIdentitySchema } from './native-delegation';

const text = (maximum: number) => z.string().min(1).max(maximum);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DelegatedSpecialistRoleSchema = z.enum(['research', 'planning', 'escalation']);
export const DelegatedModelUsageSchema = z.strictObject({ inputTokens: counter, outputTokens: counter, totalTokens: counter });
/** API-resolved references, never a browser/model substitute for note access. */
export const DelegatedOperatorIntentSchema = z.strictObject({ schemaVersion: z.literal(1), title: text(180), prompt: text(12000),
  memoryReferences: z.array(NativeMemoryReferenceSchema).max(32) });
export const DelegatedAssignmentSchema = z.strictObject({ schemaVersion: z.literal(1), stepId: IdSchema,
  title: text(180), brief: text(2400), role: DelegatedSpecialistRoleSchema,
  memoryReferences: z.array(NativeMemoryReferenceSchema).max(32) });

// Models suggest readable work only. Scope, service identities, operation IDs,
// capabilities, references, deadlines and attempt budgets are assigned in code.
export const DelegatedPlanOutputSchema = z.strictObject({ objective: text(1200),
  steps: z.array(z.strictObject({ title: text(180), brief: text(2400), role: DelegatedSpecialistRoleSchema })).max(6),
  limitations: z.array(text(500)).max(6), question: text(600).nullable() });
export const DelegatedEvidenceCitationSchema = z.strictObject({ id: IdSchema, quote: text(600) });
export const DelegatedAdviceOutputSchema = z.strictObject({ title: text(180), summary: text(1600),
  findings: z.array(z.strictObject({ text: text(1200), kind: z.enum(['source_statement', 'inference', 'unknown']),
    citations: z.array(DelegatedEvidenceCitationSchema).max(4) })).max(8),
  recommendations: z.array(text(1600)).max(6), limitations: z.array(text(600)).max(8), question: text(600).nullable() });
export const DelegatedEvidenceSchema = z.strictObject({ id: IdSchema, title: text(300), text: text(16000),
  kind: z.enum(['saved_memory', 'public_source']), url: z.url().nullable(), observedAt: InstantSchema, validUntil: InstantSchema });
/** This envelope is assembled from validated output plus observed runtime data. */
export const DelegatedAdviceArtifactSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('delegated_advice_v1'),
  advisoryOnly: z.literal(true), domainCompletion: z.literal(false), stepId: IdSchema, role: DelegatedSpecialistRoleSchema,
  advice: DelegatedAdviceOutputSchema, evidence: z.array(DelegatedEvidenceSchema).max(35),
  deployment: z.enum(['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra']), usage: DelegatedModelUsageSchema });
export const DelegatedServiceRosterSchema = z.strictObject({ coordinator: NativeServiceIdentitySchema,
  research: NativeServiceIdentitySchema, planning: NativeServiceIdentitySchema, escalation: NativeServiceIdentitySchema });

export type DelegatedOperatorIntent = z.infer<typeof DelegatedOperatorIntentSchema>;
export type DelegatedAssignment = z.infer<typeof DelegatedAssignmentSchema>;
export type DelegatedPlanOutput = z.infer<typeof DelegatedPlanOutputSchema>;
export type DelegatedAdviceOutput = z.infer<typeof DelegatedAdviceOutputSchema>;
export type DelegatedEvidence = z.infer<typeof DelegatedEvidenceSchema>;
export type DelegatedAdviceArtifact = z.infer<typeof DelegatedAdviceArtifactSchema>;
export type DelegatedModelUsage = z.infer<typeof DelegatedModelUsageSchema>;
export type DelegatedServiceRoster = z.infer<typeof DelegatedServiceRosterSchema>;
