import { commandDigest } from '@pactwoven/contracts/canonical';
import { userSourceUrls } from '@pactwoven/connectors';
import type { NativeAdvisoryHandoff } from '../../../packages/contracts/src/native-delegation';
import type { DelegatedAdviceArtifact } from '../../../packages/contracts/src/delegated-execution';
import { NativePublicSourceObservationSchema } from '../../../packages/db/src/native-root-refresh-schema';
import { EvidenceDocumentsSchema, evidenceValidUntil, isCurrentEvidence, type ObservedEvidenceRead } from './native-evidence';
import { DelegatedOutputRejected } from './delegated-output';

/** The sidecar retains a digest of actually retrieved full normalized text.
 * Cited artifact excerpts remain separately bound by their existing digest.
 * SQL authenticates this workload attestation; it cannot verify the network. */
export async function freshPublicObservations(input: {
  originalPrompt: string;
  handoff: NativeAdvisoryHandoff;
  read: ObservedEvidenceRead;
  artifact: DelegatedAdviceArtifact;
  now: number;
}) {
  const { handoff, read, artifact, now } = input;
  const documents = EvidenceDocumentsSchema.parse(read.documents);
  const allowed = userSourceUrls(JSON.stringify({ objective: input.originalPrompt, conversation: [] }));
  if (!Number.isSafeInteger(now) || handoff.capability !== 'research_public_sources' ||
      !documents.length || documents.length !== read.observations.length || documents.length > 3 ||
      read.unavailableUrls.length > 3 || Date.parse(handoff.deadlineAt) <= now) throw new DelegatedOutputRejected();
  const requested = read.observations.map(item => item.requestedUrl);
  const accounted = [...requested, ...read.unavailableUrls];
  if (new Set(accounted).size !== accounted.length || accounted.length !== allowed.length ||
      accounted.some(url => !allowed.includes(url)) ||
      new Set(read.observations.map(item => item.documentId)).size !== documents.length) throw new DelegatedOutputRejected();
  const publicEvidence = artifact.evidence.filter(item => item.kind === 'public_source');
  if (publicEvidence.some(item => !documents.some(document => document.id === item.id))) throw new DelegatedOutputRejected();
  const observations = [];
  for (const [index, document] of documents.entries()) {
    const observation = read.observations[index]!;
    if (document.id !== `source-${index + 1}` || observation.documentId !== document.id ||
        !isCurrentEvidence(document, now) || !document.source || !document.validUntil ||
        observation.finalUrl !== document.source.url || observation.observedAt !== document.observedAt ||
        observation.validUntil !== document.validUntil || observation.validUntil !== evidenceValidUntil(observation.observedAt) ||
        Date.parse(observation.observedAt) < Date.parse(handoff.issuedAt) ||
        observation.sourceDigest !== await commandDigest(document.text)) throw new DelegatedOutputRejected();
    const cited = publicEvidence.filter(item => item.id === document.id);
    if (cited.length > 1 || cited.some(item => item.url !== observation.finalUrl || item.observedAt !== observation.observedAt ||
        item.validUntil !== observation.validUntil)) throw new DelegatedOutputRejected();
    const quotes = [...new Set(artifact.advice.findings.flatMap(finding => finding.citations
      .filter(citation => citation.id === document.id).map(citation => citation.quote)))];
    if (quotes.some(quote => !document.text.slice(0, 4000).includes(quote)) ||
        cited.some(item => !quotes.length || item.text !== quotes.join('\n…\n')) ||
        quotes.length > 0 && cited.length !== 1) throw new DelegatedOutputRejected();
    observations.push(NativePublicSourceObservationSchema.parse({ requestedUrl: observation.requestedUrl, finalUrl: observation.finalUrl,
      sourceDigest: observation.sourceDigest, observedAt: observation.observedAt, validUntil: observation.validUntil,
      evidenceIds: cited.map(item => item.id) }));
  }
  return observations;
}
