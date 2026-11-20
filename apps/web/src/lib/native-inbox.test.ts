import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inboxPageSchema, inboxPath, inboxRequestPath, inboxScanCopy } from './native-inbox';
import { agentWorkScope } from './native-agent-work';
import { nativeSessionFixture } from './native-tasks.test-fixtures';
const scope = () => agentWorkScope(nativeSessionFixture(), 'site_one');
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'http://localhost:3108'));
afterEach(() => vi.unstubAllEnvs());
function page() { const s = scope(); return { scope: { environment: s.environment, organizationId: s.organizationId, siteId: s.siteId },
  items: [], nextCursor: 'next_page', scannedCount: 20, scanComplete: false }; }
describe('attention inbox reads', () => {
  it('keeps the original cursor when a scanned page has no attention items', () => {
    const value = inboxPageSchema(scope()).parse(page()); expect(value.items).toEqual([]); expect(value.nextCursor).toBe('next_page'); expect(value.scanComplete).toBe(false);
    expect(inboxRequestPath('site_one', value.nextCursor!)).toContain('cursor=next_page');
  });
  it('does not claim that an incomplete empty scan clears all work', () => {
    expect(inboxScanCopy(0, false, true)).toContain('Continue checking older work');
    expect(inboxScanCopy(0, true, true)).toBe('No tasks needing review were found in your current work.');
    expect(inboxScanCopy(2, false, true)).toContain('More work remains');
  });
  it('requests only a scoped read with a fixed page size', () => {
    expect(inboxRequestPath('site_one')).toBe('/v1/agent-work/attention?siteId=site_one&limit=20');
    expect(inboxPath('site_one')).toBe('/app/inbox?site=site_one');
  });
  it('rejects other sites, repeated cursors and scan contradictions', () => {
    const p = page(), schema = inboxPageSchema(scope(), 'next_page'); expect(schema.safeParse(p).success).toBe(false);
    expect(inboxPageSchema(scope()).safeParse({ ...p, scope: { ...p.scope, siteId: 'site_other' } }).success).toBe(false);
    expect(inboxPageSchema(scope()).safeParse({ ...p, scanComplete: true }).success).toBe(false);
    expect(inboxPageSchema(scope()).safeParse({ ...p, scannedCount: 21 }).success).toBe(false);
  });
});
