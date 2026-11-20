import { describe, expect, it } from 'vitest';
import { currentEvidenceValidUntil, evidenceValidUntil, isCurrentEvidence, type EvidenceDocument } from './native-evidence.js';

const observedAt = '2026-11-18T23:55:00Z';
const document: EvidenceDocument = { id: 'source-one', title: 'Source', text: 'Observed text', origin: 'retrieved',
  source: { title: 'Source', url: 'https://example.com/source' }, observedAt, validUntil: evidenceValidUntil(observedAt) };
describe('advisory evidence validity policy', () => {
  it('limits reuse to fifteen minutes or the next UTC date, whichever occurs first', () => {
    expect(evidenceValidUntil('2026-11-18T12:00:00Z')).toBe('2026-11-18T12:15:00.000Z');
    expect(document.validUntil).toBe('2026-11-19T00:00:00.000Z');
    expect(evidenceValidUntil('2026-11-30T23:59:59Z')).toBe('2026-12-01T00:00:00.000Z');
    expect(isCurrentEvidence(document, Date.parse('2026-11-18T23:59:59.999Z'))).toBe(true);
    expect(isCurrentEvidence(document, Date.parse('2026-11-19T00:00:00.000Z'))).toBe(false);
  });
  it('honors shorter validity and never extends the server policy with a longer supplied expiry', () => {
    expect(isCurrentEvidence({ ...document, validUntil: '2026-11-18T23:56:00Z' }, Date.parse('2026-11-18T23:56:00Z'))).toBe(false);
    expect(isCurrentEvidence({ ...document, validUntil: '2027-01-01T00:00:00Z' }, Date.parse('2026-11-19T00:00:00Z'))).toBe(false);
  });
  it('does not accept future observations, missing validity, user assertions or untraceable sources as current', () => {
    const { validUntil: _validUntil, ...legacy } = document;
    expect(isCurrentEvidence(legacy, Date.parse(observedAt))).toBe(false);
    expect(isCurrentEvidence(document, Date.parse(observedAt) - 1)).toBe(false);
    expect(isCurrentEvidence({ ...document, origin: 'user_supplied' }, Date.parse(observedAt))).toBe(false);
    expect(isCurrentEvidence({ ...document, source: null }, Date.parse(observedAt))).toBe(false);
  });
  it('builds the final precondition from all retrieved sources under the effective policy', () => {
    expect(currentEvidenceValidUntil([])).toBeUndefined();
    expect(currentEvidenceValidUntil([{ ...document, origin: 'user_supplied' }])).toBeUndefined();
    expect(currentEvidenceValidUntil([{ ...document, validUntil: '2027-01-01T00:00:00Z' }])).toBe('2026-11-19T00:00:00.000Z');
    expect(currentEvidenceValidUntil([document, { ...document, id: 'earlier', validUntil: '2026-11-18T23:56:00Z' }])).toBe('2026-11-18T23:56:00.000Z');
  });
});
