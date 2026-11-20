import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { memoryNoteFixture } from '../lib/native-memory.test-fixtures';
import { MemoryProvenance, localMemoryDate } from './native-memory-editor';
vi.mock('./workspace-provider', () => ({ useWorkspace: () => { throw Error('No synthetic identity in presentation tests.'); } }));
vi.mock('./ui', () => ({ StatusBadge: ({ children }: { children: unknown }) => createElement('span', null, children as never) }));
describe('saved note provenance', () => {
 it('uses returned source attribution without exposing internal references',()=>{
  const html=renderToStaticMarkup(createElement(MemoryProvenance,{note:memoryNoteFixture()}));
  expect(html).toContain('Supplied by Morgan Reed');expect(html).toContain('Human statement — not independently verified');expect(html).toContain('Prior records remain.');
  expect(html).not.toContain('note_internal_001');expect(html).not.toContain('a'.repeat(64));expect(html).not.toContain('You supplied');
 });
 it('makes unresolved attribution visible and never invents an author',()=>{
  const note={...memoryNoteFixture(),status:'needs_review' as const,suppliedBy:'Original author unavailable',sourceLabel:'Source attribution needs review' as const};
  const html=renderToStaticMarkup(createElement(MemoryProvenance,{note}));expect(html).toContain('Source attribution needs review');expect(html).toContain('Supplied by Original author unavailable');
 });
 it('escapes source display text',()=>{
  const html=renderToStaticMarkup(createElement(MemoryProvenance,{note:{...memoryNoteFixture(),suppliedBy:'<script>unsafe()</script>'}}));expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');
 });
 it('formats only the displayed local control without modifying the original timestamp',()=>{
  const note=memoryNoteFixture();expect(localMemoryDate(note.reviewBy!)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);expect(note.reviewBy).toBe('2026-12-18T14:03:23.123Z');expect(localMemoryDate('invalid')).toBe('');
 });
});
