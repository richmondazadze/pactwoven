import { describe, expect, it } from 'vitest';
import { workspaceAuthPath, workspaceOnboardingPath, workspaceReturnPath } from './workspace-return';

describe('workspace sign-in return paths', () => {
  it('retains task and recovery destinations including query and fragment', () => {
    const path = '/app/work/task_123?request=original-request#conversation';
    expect(workspaceReturnPath(path)).toBe(path);
    expect(new URL(workspaceAuthPath('/sign-in', path), 'https://pactwoven.test').searchParams.get('redirect_url')).toBe(path);
    expect(new URL(workspaceOnboardingPath(path), 'https://pactwoven.test').searchParams.get('returnTo')).toBe(path);
    expect(workspaceReturnPath('https://pactwoven.test' + path)).toBe(path);
  });
  it('never returns an external origin, a protocol-relative path or executable scheme', () => {
    for (const input of ['//evil.test/app', 'javascript:alert(1)', 'data:text/html,test', '/sign-in', '/application', '/app/../../evil', '/app\\evil', '/app/%2f%2fevil', '/app/%252f%252fevil', '/app/%0aevil', ' /app', '/app\n', ['a', 'b'], null, '/app/' + 'a'.repeat(4096)]) expect(workspaceReturnPath(input)).toBe('/app');
    expect(workspaceReturnPath('https://evil.test/app/work/local-task')).toBe('/app/work/local-task');
    expect(workspaceReturnPath('https://name:password@evil.test/app/work/a')).toBe('/app');
  });
  it('drops Next transport query and prevents onboarding loops', () => {
    expect(workspaceReturnPath('/app/work/a?_rsc=123&request=abc')).toBe('/app/work/a?request=abc');
    expect(workspaceOnboardingPath('/app')).toBe('/app/onboarding');
    expect(workspaceOnboardingPath('/app/onboarding?returnTo=%2Fapp')).toBe('/app/onboarding');
  });
});
