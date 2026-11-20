import { createPublicSourceReader, userSourceUrls, PublicSourceError } from '@pactwoven/connectors';
import type { PublicSource } from '@pactwoven/connectors';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { evidenceValidUntil, type EvidenceDocument, type EvidenceRequest, type NativeEvidenceReader, type ObservedEvidenceRead } from './native-evidence.js';

/** Scoped caller supplies only operator URLs; pages cannot extend this authority. */
export function createSourceEvidenceReader(readSource: (url: string, signal: AbortSignal) => Promise<PublicSource> = createPublicSourceReader()): NativeEvidenceReader {
  const load = async (request: EvidenceRequest, recordObservations: boolean): Promise<ObservedEvidenceRead> => {
    const documents: EvidenceDocument[] = [], observations: ObservedEvidenceRead['observations'] = [], unavailableUrls: string[] = [];
    for (const url of userSourceUrls(request.userInput)) {
      request.signal.throwIfAborted();
      try {
        const source = await readSource(url, request.signal);
        request.signal.throwIfAborted();
        const document: EvidenceDocument = { id: `source-${documents.length + 1}`, title: source.title, text: source.text,
          source: { title: source.title, url: source.url }, origin: 'retrieved', observedAt: source.observedAt,
          validUntil: evidenceValidUntil(source.observedAt) };
        if (recordObservations) {
          const sourceDigest = await commandDigest(source.text);
          request.signal.throwIfAborted();
          observations.push({ documentId: document.id, requestedUrl: url, finalUrl: source.url, sourceDigest,
            observedAt: source.observedAt, validUntil: document.validUntil! });
        }
        documents.push(document);
      } catch (error) {
        if (request.signal.aborted) request.signal.throwIfAborted();
        // Source failures cannot authorize stale text or silently successful
        // refresh. The caller receives which original sources were unavailable.
        if (!(error instanceof PublicSourceError)) throw error;
        unavailableUrls.push(url);
      }
    }
    return { documents, observations, unavailableUrls };
  };
  return {
    async read(request) {
      return (await load(request, false)).documents;
    },
    readWithObservations: request => load(request, true),
  };
}
