import { MandateDocumentReadSchema, type Environment, type MandateDocumentQuery } from '@pactwoven/contracts';
import { commandDigest, DomainError, validatePolicyDocumentVersion } from '@pactwoven/domain';

/** Public result qualification only. Access to the historical record is enforced by the repository. */
export async function qualifyMandateDocumentResult(value: unknown, responsibilityId: string, documentId: string,
  query: MandateDocumentQuery, environment?: Environment) {
  try {
    const result = MandateDocumentReadSchema.parse(value);
    if (result.responsibilityId !== responsibilityId || result.document.id !== documentId || result.document.version !== query.version ||
        (environment !== undefined && result.environment !== environment)) throw new Error('Document target mismatch');
    await validatePolicyDocumentVersion(result.document);
    if (await commandDigest(result.savedResponsibility) !== result.savedAgainst.responsibility.hash) throw new Error('Historical responsibility mismatch');
    return result;
  } catch {
    throw new DomainError('INTEGRITY_ERROR', 503, 'The exact saved policy document could not be verified.');
  }
}
