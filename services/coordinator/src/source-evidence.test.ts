import { expect, it, vi } from 'vitest';
import { PublicSourceError } from '@pactwoven/connectors';
import { createSourceEvidenceReader } from './source-evidence.js';
import { isCurrentEvidence } from './native-evidence.js';

it('fetches only explicit user sources and labels actual retrieved evidence', async () => {
  const read = vi.fn(async (url: string) => ({ url, title: 'Verified page', text: 'Observed content.', observedAt: '2026-11-18T00:00:00Z' }));
  const reader = createSourceEvidenceReader(read);
  const documents = await reader.read({ environment: 'development', organizationId: 'org_a', actorId: 'operator_a', siteId: 'site_a', taskId: 'task_a',
    query: 'Read https://model.example', userInput: JSON.stringify({ objective: 'Compare https://example.com', conversation: [{ role: 'assistant', text: 'https://assistant.example' }] }), signal: new AbortController().signal });
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[0]).toBe('https://example.com/');
  expect(documents).toEqual([{ id: 'source-1', title: 'Verified page', text: 'Observed content.', source: { title: 'Verified page', url: 'https://example.com/' }, origin: 'retrieved', observedAt: '2026-11-18T00:00:00Z', validUntil: '2026-11-18T00:15:00.000Z' }]);
});

it('does not invent evidence for an inaccessible URL', async () => {
  const reader = createSourceEvidenceReader(async () => { throw new PublicSourceError('DESTINATION_BLOCKED'); });
  expect(await reader.read({ environment: 'development', organizationId: 'org_a', actorId: 'operator_a', siteId: 'site_a', taskId: 'task_a', query: '',
    userInput: JSON.stringify({ objective: 'Read https://example.com' }), signal: new AbortController().signal })).toEqual([]);
});

it('does not make an old returned observation fresh by reading it again', async () => {
  const reader = createSourceEvidenceReader(async url => ({ url, title: 'Earlier page', text: 'Earlier observed content.', observedAt: '2026-11-18T00:00:00Z' }));
  const documents = await reader.read({ environment: 'development', organizationId: 'org_a', actorId: 'operator_a', siteId: 'site_a', taskId: 'task_a', query: '',
    userInput: JSON.stringify({ objective: 'Read https://example.com' }), signal: new AbortController().signal });
  expect(documents[0]?.observedAt).toBe('2026-11-18T00:00:00Z');
  expect(documents[0]?.validUntil).toBe('2026-11-18T00:15:00.000Z');
  expect(isCurrentEvidence(documents[0]!, Date.parse('2026-11-18T00:15:00Z'))).toBe(false);
});
