import { z } from 'zod';
import { EnvironmentSchema, IdSchema, InstantSchema, NativeSourceSchema } from '@pactwoven/contracts';

export const EvidenceDocumentSchema = z.strictObject({
  id: IdSchema,
  title: z.string().min(1).max(300),
  text: z.string().min(1).max(16_000),
  source: NativeSourceSchema.nullable(),
  origin: z.enum(['user_supplied', 'retrieved']),
  observedAt: InstantSchema,
  // Optional only for reading historical checkpoints. Missing validity is never
  // proof of a current observation.
  validUntil: InstantSchema.optional(),
});
export const EvidenceDocumentsSchema = z.array(EvidenceDocumentSchema).max(3).refine(
  documents => documents.reduce((length, document) => length + document.text.length, 0) <= 48_000 &&
    new TextEncoder().encode(JSON.stringify(documents)).byteLength <= 80_000 &&
    new Set(documents.map(document => document.id)).size === documents.length,
  'Evidence exceeds its size limit or contains duplicate references.',
);
export type EvidenceDocument = z.infer<typeof EvidenceDocumentSchema>;

/** A source observation is usable for at most 15 minutes and never across a
 * UTC date boundary. This bounds advisory reuse; it does not certify a page's
 * claims or authorize a purchase. Reader-supplied validity may shorten it. */
export const evidenceMaximumAgeMilliseconds = 15 * 60_000;
export function evidenceValidUntil(observedAt: string): string {
  const observed = Date.parse(observedAt);
  const day = new Date(observed);
  day.setUTCHours(24, 0, 0, 0);
  return new Date(Math.min(observed + evidenceMaximumAgeMilliseconds, day.getTime())).toISOString();
}
export function isCurrentEvidence(document: EvidenceDocument, now: number): boolean {
  if (document.origin !== 'retrieved' || !document.source || !document.validUntil || !Number.isFinite(now)) return false;
  const observed = Date.parse(document.observedAt);
  const expires = Math.min(Date.parse(document.validUntil), Date.parse(evidenceValidUntil(document.observedAt)));
  return observed <= now && now < expires;
}
/** The final publication precondition uses the same conservative policy as
 * current-evidence checks. Call only after validating all retrieved documents. */
export function currentEvidenceValidUntil(documents: EvidenceDocument[]): string | undefined {
  const retrieved = documents.filter(document => document.origin === 'retrieved');
  if (!retrieved.length) return undefined;
  return new Date(Math.min(...retrieved.map(document => Math.min(
    Date.parse(document.validUntil!), Date.parse(evidenceValidUntil(document.observedAt)),
  )))).toISOString();
}
export type EvidenceRequest = {
  environment: z.infer<typeof EnvironmentSchema>;
  organizationId: string;
  actorId: string;
  siteId: string;
  taskId: string;
  query: string;
  userInput: string;
  signal: AbortSignal;
};

// Only a server-side, independently authorized read tool may implement this port.
// No model-provided URL is fetched here. Page/document content remains untrusted.
export interface NativeEvidenceReader {
  read(request: EvidenceRequest): Promise<EvidenceDocument[]>;
  /** A new observation is required for refreshed public-source work. Ordinary
   * evidence readers cannot become refresh-capable by updating an old time. */
  readWithObservations?(request: EvidenceRequest): Promise<ObservedEvidenceRead>;
}

export type SourceReadObservation = {
  documentId: string;
  requestedUrl: string;
  finalUrl: string;
  /** commandDigest of the full normalized text actually returned by the reader,
   * distinct from the shorter excerpts retained in a cited advice artifact. */
  sourceDigest: string;
  observedAt: string;
  validUntil: string;
};
export type ObservedEvidenceRead = {
  documents: EvidenceDocument[];
  observations: SourceReadObservation[];
  unavailableUrls: string[];
};
