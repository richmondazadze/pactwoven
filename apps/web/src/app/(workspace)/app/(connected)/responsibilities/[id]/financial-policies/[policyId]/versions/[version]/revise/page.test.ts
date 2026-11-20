import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinancialPolicyAuthoringWorkspace } from '../../../../../../../../../../../components/financial-policy-authoring-workspace';
import { Alert } from '../../../../../../../../../../../components/ui';
import ReviseFinancialPolicyPage from './page';

vi.mock('../../../../../../../../../../../components/financial-policy-authoring-workspace', () => ({ FinancialPolicyAuthoringWorkspace: vi.fn(() => null) }));
vi.mock('../../../../../../../../../../../components/ui', () => ({ Alert: vi.fn(() => null) }));
const route = { id: 'responsibility_a', policyId: 'document_a', version: '3' };
afterEach(() => {
  expect(FinancialPolicyAuthoringWorkspace).not.toHaveBeenCalled();
  expect(Alert).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
describe('financial policy revision server route kind hint', () => {
  it.each([
    { search: {}, kind: 'draft' },
    { search: { kind: 'draft' }, kind: 'draft' },
    { search: { kind: 'document' }, kind: 'document' },
  ])('passes only the validated $kind entry choice and exact route params', async ({ search, kind }) => {
    const element = await ReviseFinancialPolicyPage({ params: Promise.resolve(route), searchParams: Promise.resolve(search) });
    expect(element.type).toBe(FinancialPolicyAuthoringWorkspace);
    expect(element.props).toEqual({ ...route, revisionKind: kind }); expect(element.key).toBeNull();
  });
  it.each(['', 'Document', 'governance', ' document', [], ['document'], ['document', 'document'], ['document', 'draft']].map(kind => ({ kind })))('rejects a malformed or duplicated hint $kind without mounting native authoring', async ({ kind }) => {
    const element = await ReviseFinancialPolicyPage({ params: Promise.resolve(route), searchParams: Promise.resolve({ kind }) });
    expect(element.type).toBe(Alert); expect(element.props.title).toBe('Configuration preparation unavailable');
    expect(element.props).not.toHaveProperty('revisionKind'); expect(element.props).not.toHaveProperty('policyId');
  });
  it('does not pass unrelated query data into the native view or replace the exact version', async () => {
    const element = await ReviseFinancialPolicyPage({ params: Promise.resolve(route),
      searchParams: Promise.resolve({ kind: 'document', version: '99', text: 'Untrusted query material', authority: 'allowed' }) });
    expect(element.type).toBe(FinancialPolicyAuthoringWorkspace);
    expect(element.props).toEqual({ ...route, revisionKind: 'document' }); expect(element.key).toBeNull();
  });
});
