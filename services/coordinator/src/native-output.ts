import { z } from 'zod';
import type { NativeSource } from '@pactwoven/contracts';
import type { EvidenceDocument } from './native-evidence.js';

const shortText = z.string().min(1).max(800);
const detail = z.string().min(1).max(400);
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const question = z.string().min(1).max(600).nullable();
const referenceIds = z.array(z.string().min(1).max(128)).max(3);
export const NativePlanSchema = z.strictObject({
  title: z.string().min(1).max(180),
  objective: shortText,
  constraints: z.array(detail).max(8),
  researchBrief: shortText,
  planningBrief: shortText,
  requiresFreshEvidence: z.boolean(),
  question,
}).refine(value => jsonBytes(value) <= 20_000, 'The plan exceeds its working size.');
export const ResearchFindingSchema = z.strictObject({
  text: shortText,
  kind: z.enum(['quoted_fact', 'inference', 'unknown']),
  quotes: z.array(z.strictObject({ documentId: z.string().min(1).max(128), text: z.string().min(1).max(400) })).max(2),
});
export const NativeResearchSchema = z.strictObject({
  summary: shortText,
  findings: z.array(ResearchFindingSchema).max(6),
  uncertainties: z.array(detail).max(4),
}).refine(value => jsonBytes(value) <= 48_000, 'The evidence review exceeds its working size.');
export const NativePlanningSchema = z.strictObject({
  summary: shortText,
  recommendations: z.array(z.strictObject({ title: z.string().min(1).max(180), explanation: shortText,
    documentIds: referenceIds, conditions: z.array(z.string().min(1).max(240)).max(3) })).min(1).max(4),
  unresolved: z.array(detail).max(4),
  escalationReason: z.string().min(1).max(600).nullable(),
}).refine(value => jsonBytes(value) <= 40_000, 'The comparison exceeds its working size.');
export const NativeSynthesisSchema = z.strictObject({
  title: z.string().min(1).max(180),
  summary: shortText,
  recommendation: z.string().min(1).max(5_000),
  documentIds: referenceIds,
  limitations: z.array(detail).max(4),
  question,
}).refine(value => jsonBytes(value) <= 32_000, 'The recommendation exceeds its working size.');
export type NativePlan = z.infer<typeof NativePlanSchema>;
export type NativeResearch = z.infer<typeof NativeResearchSchema>;
export type NativePlanning = z.infer<typeof NativePlanningSchema>;
export type NativeSynthesis = z.infer<typeof NativeSynthesisSchema>;

export function verifyResearchQuotes(research: NativeResearch, documents: EvidenceDocument[]): boolean {
  const indexed = new Map(documents.map(document => [document.id, document]));
  return research.findings.every(finding => {
    if (finding.kind === 'quoted_fact' && finding.quotes.length === 0) return false;
    return finding.quotes.every(quote => indexed.get(quote.documentId)?.text.includes(quote.text) === true);
  });
}
export function verifyDocumentReferences(ids: string[], documents: EvidenceDocument[]): boolean {
  return new Set(ids).size === ids.length && ids.every(id => documents.some(document => document.id === id));
}
export function sourceReferences(ids: string[], documents: EvidenceDocument[]): NativeSource[] {
  const sources = new Map<string, NativeSource>();
  for (const document of documents) {
    if (ids.includes(document.id) && document.source) sources.set(document.source.url, document.source);
  }
  return [...sources.values()];
}
export function displayReferences(text: string, documents: EvidenceDocument[]): string {
  let result = text;
  documents.forEach((document, index) => {
    // Short labels are already readable; longer internal references are replaced
    // with stable source numbers, without changing the recorded source excerpts.
    if (document.id.length < 6) return;
    const escaped = document.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'g'), `Source ${index + 1}`);
  });
  return result;
}
export function renderResearch(research: NativeResearch, documents: EvidenceDocument[]): string {
  const indexed = new Map(documents.map(document => [document.id, document]));
  return [displayReferences(research.summary, documents), ...research.findings.map(finding => [
    `${finding.kind === 'inference' ? 'Inference' : finding.kind === 'unknown' ? 'Unverified' : 'Source excerpt'}: ${displayReferences(finding.text, documents)}`,
    ...finding.quotes.map(quote => `“${quote.text}” — ${indexed.get(quote.documentId)?.title ?? 'Provided source'}`),
  ].join('\n')), ...research.uncertainties.map(text => `Uncertainty: ${displayReferences(text, documents)}`)].join('\n\n');
}
export function renderPlanning(plan: NativePlanning, documents: EvidenceDocument[] = []): string {
  return displayReferences([plan.summary, ...plan.recommendations.map(item => [item.title, item.explanation,
    ...item.conditions.map(condition => `Condition: ${condition}`)].join('\n')),
  ...plan.unresolved.map(text => `Unresolved: ${text}`)].join('\n\n'), documents);
}
export function renderSynthesis(result: NativeSynthesis, documents: EvidenceDocument[] = []): string {
  const text = [result.summary, result.recommendation, ...result.limitations.map(text => `Limitation: ${text}`),
    result.question ? `Next question: ${result.question}` : ''].filter(Boolean).join('\n\n');
  const used = documents.map((document, index) => ({ document, index })).filter(({ document }) => document.id.length >= 6 && text.includes(document.id));
  return [displayReferences(text, documents), ...used.map(({ document, index }) => `Source ${index + 1}: ${document.title}`)].join('\n\n');
}
