import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerificationView } from '../lib/mfa';
import { MfaVerification } from './mfa-verification';

// Real factor component and status classifier; simulated React commits and Clerk
// responses. These are interaction regressions, not genuine provider evidence.
const h = vi.hoisted(() => ({ active: null as any, auth: { userId: 'user_a', orgId: 'org_a' }, session: null as any, user: null as any, profile: vi.fn(), focuses: [] as unknown[], nextId: 0 }));
vi.mock('react', async original => ({ ...(await original<any>()), useId: () => { const f = h.active, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = `factor_${h.nextId++}`); }, useState: (initial: any) => { const f = h.active, i = f.cursor++; if (!(i in f.cells)) f.cells[i] = typeof initial === 'function' ? initial() : initial; return [f.cells[i], (next: any) => { const value = typeof next === 'function' ? next(f.cells[i]) : next; if (!Object.is(value, f.cells[i])) { f.cells[i] = value; f.dirty = true; } }]; }, useRef: (initial: any) => { const f = h.active, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = { current: initial }); }, useEffect: (effect: any, deps: any[]) => h.active.effect(effect, deps) }));
vi.mock('@clerk/nextjs', () => ({ useAuth: () => h.auth, useSession: () => ({ session: h.session }), useUser: () => ({ user: h.user }), useClerk: () => ({ openUserProfile: h.profile }) }));
vi.mock('./motion', () => ({ useArrival: () => ({ current: null }) }));
vi.mock('./icon', () => ({ Icon: 'Icon' }));
vi.mock('./ui', () => ({ ActionLabel: 'ActionLabel', Alert: 'Alert' }));
function nodes(node: any): any[] { if (node == null || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
function text(node: any): string { if (node == null || typeof node === 'boolean') return ''; if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(' '); return `${node.props?.title ?? ''} ${node.props?.label ?? ''} ${text(node.props?.children)}`.replace(/\s+/g, ' ').trim(); }
class Hooks {
  cells: any[] = []; effects: any[] = []; queued: (() => void)[] = []; cursor = 0; dirty = false; tree: any;
  constructor(public component: () => any) {}
  effect(callback: any, deps: any[]) { const i = this.cursor++, old = this.effects[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) this.queued.push(() => { old?.cleanup?.(); this.effects[i] = { deps, cleanup: callback() }; }); }
  render() { for (let i = 0; i < 20; i++) { this.cursor = 0; this.dirty = false; h.active = this; this.tree = this.component(); for (const node of nodes(this.tree)) if (node.type === 'input' && node.props.ref) node.props.ref.current = { focus: (options: unknown) => h.focuses.push(options) }; for (const effect of this.queued.splice(0)) effect(); if (!this.dirty) return this.tree; } throw new Error('Unstable factor host'); }
  unmount() { for (const effect of this.effects) effect?.cleanup?.(); }
}
const first: VerificationView = { level: 'multi_factor', status: 'needs_first_factor', supportedFirstFactors: [{ strategy: 'password' }], supportedSecondFactors: [{ strategy: 'totp' }], firstFactorVerification: { status: 'unverified' }, secondFactorVerification: { status: 'unverified' } };
const second: VerificationView = { ...first, status: 'needs_second_factor', firstFactorVerification: { status: 'verified' } };
const complete: VerificationView = { ...second, status: 'complete', secondFactorVerification: { status: 'verified' } };
const purposes = ['access-change', 'account-check', 'mandate-authorization', 'mandate-resume', 'access-recovery-close'] as const;
let view: Hooks, props: Parameters<typeof MfaVerification>[0];
function fixture(purpose: typeof purposes[number] = 'mandate-resume') { props = { purpose, onComplete: vi.fn(), onInvalidated: vi.fn() }; view = new Hooks(() => MfaVerification(props)); view.render(); return props; }
function button(label: string) { return nodes(view.tree).find(node => node.type === 'button' && text(node) === label); }
function click(label: string) { const node = button(label); expect(node).toBeDefined(); expect(node.props.disabled).not.toBe(true); node.props.onClick(); }
function input() { const node = nodes(view.tree).find(node => node.type === 'input'); expect(node).toBeDefined(); return node; }
function enter(value: string) { input().props.onChange({ target: { value } }); view.render(); }
function submit() { nodes(view.tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); }
async function eventually(check: () => void) { await vi.waitFor(() => { view.render(); check(); }, { interval: 5, timeout: 1000 }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => { vi.clearAllMocks(); h.auth = { userId: 'user_a', orgId: 'org_a' }; h.user = { totpEnabled: true }; h.session = { id: 'session_a', startVerification: vi.fn().mockResolvedValue(first), attemptFirstFactorVerification: vi.fn().mockResolvedValue(second), attemptSecondFactorVerification: vi.fn().mockResolvedValue(complete) }; h.focuses = []; h.nextId = 0; });
afterEach(() => { view?.unmount(); });
describe('purpose-aware native factor interaction', () => {
  it.each(purposes)('retains password then authenticator interaction for %s and never submits a domain action', async purpose => {
    const callbacks = fixture(purpose); expect(callbacks.onInvalidated).toHaveBeenCalledOnce(); click('Verify identity'); click('Verify identity'); await eventually(() => expect(input().props.type).toBe('password')); expect(h.session.startVerification).toHaveBeenCalledExactlyOnceWith({ level: 'multi_factor' });
    expect(input().props.autoComplete).toBe('current-password'); enter('synthetic_password'); submit(); view.render(); expect(input().props.value).toBe(''); await eventually(() => expect(input().props.inputMode).toBe('numeric')); expect(h.session.attemptFirstFactorVerification).toHaveBeenCalledExactlyOnceWith({ strategy: 'password', password: 'synthetic_password' }); expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(input().props.autoComplete).toBe('one-time-code'); enter('12-3a456789'); expect(input().props.value).toBe('123456'); submit(); view.render(); expect(input().props.value).toBe(''); await eventually(() => expect(callbacks.onComplete).toHaveBeenCalledOnce()); expect(h.session.attemptSecondFactorVerification).toHaveBeenCalledExactlyOnceWith({ strategy: 'totp', code: '123456' }); expect(text(view.tree)).toContain('Factors checked by your sign-in provider');
    const expected = purpose === 'mandate-resume' ? 'No resume has been submitted.' : purpose === 'mandate-authorization' ? 'No mandate decision has been submitted.' : purpose === 'account-check' ? 'No access change was submitted or authorized.' : purpose === 'access-recovery-close' ? 'No request key has been closed.' : 'No access change has been submitted.'; expect(text(view.tree)).toContain(expected); expect(h.focuses.every(value => JSON.stringify(value) === '{"preventScroll":true}')).toBe(true);
  });
  it('uses resume purpose text for unavailable sign-in, setup and exact submit evidence', () => {
    fixture(); expect(text(view.tree)).toContain('fresh resume-specific verification when you submit'); h.user.totpEnabled = false; view.render(); expect(text(view.tree)).toContain('before it can resume accepted authority'); click('Manage account security'); expect(h.profile).toHaveBeenCalledOnce(); expect(h.session.startVerification).not.toHaveBeenCalled(); h.session = null; view.render(); expect(text(view.tree)).toContain('Sign in again before resuming this accepted mandate. No resume has been sent.');
  });
  it.each(['level', 'missing-first', 'missing-second', 'unsupported-first', 'unsupported-second'] as const)('never calls completion for %s factor results', async kind => {
    fixture(); const result = kind === 'level' ? { ...complete, level: 'first_factor' } : kind === 'missing-first' ? { ...complete, firstFactorVerification: { status: 'unverified' } } : kind === 'missing-second' ? { ...complete, secondFactorVerification: { status: 'unverified' } } : kind === 'unsupported-first' ? { ...first, supportedFirstFactors: [{ strategy: 'email_code' }] } : { ...second, supportedSecondFactors: [{ strategy: 'phone_code' }] };
    h.session.startVerification.mockResolvedValueOnce(result); click('Verify identity'); await eventually(() => expect(text(view.tree)).toContain('This verification method is not supported')); expect(props.onComplete).not.toHaveBeenCalled(); expect(h.session.attemptFirstFactorVerification).not.toHaveBeenCalled(); expect(h.session.attemptSecondFactorVerification).not.toHaveBeenCalled();
  });
  it('cancel revokes an in-flight factor completion and clears private entry', async () => {
    fixture(); click('Verify identity'); await eventually(() => expect(input().props.type).toBe('password')); const pending = deferred<VerificationView>(); h.session.attemptFirstFactorVerification.mockReturnValueOnce(pending.promise); enter('synthetic_password'); submit(); view.render(); click('Cancel verification'); view.render(); pending.resolve(complete); await Promise.resolve(); view.render(); expect(button('Verify identity')).toBeDefined(); expect(props.onComplete).not.toHaveBeenCalled(); expect(nodes(view.tree).some(node => node.type === 'input')).toBe(false);
  });
  it.each(['session', 'user', 'organization', 'unmount'] as const)('%s change prevents old factor completion from unlocking its parent', async kind => {
    fixture(); const pending = deferred<VerificationView>(); h.session.startVerification.mockReturnValueOnce(pending.promise); click('Verify identity'); if (kind === 'session') h.session = { ...h.session, id: 'session_b' }; else if (kind === 'user') h.auth.userId = 'user_b'; else if (kind === 'organization') h.auth.orgId = 'org_b'; else view.unmount(); if (kind !== 'unmount') view.render(); pending.resolve(complete); await Promise.resolve(); expect(props.onComplete).not.toHaveBeenCalled(); if (kind !== 'unmount') expect(props.onInvalidated).toHaveBeenCalledTimes(2);
  });
  it('uses distinct fields and error descriptions across simultaneous instances', async () => {
    fixture(); click('Verify identity'); await eventually(() => expect(input().props.type).toBe('password')); const firstId = input().props.id, old = view; fixture(); click('Verify identity'); await eventually(() => expect(input().props.type).toBe('password')); expect(input().props.id).not.toBe(firstId); expect(nodes(view.tree).find(node => node.type === 'label').props.htmlFor).toBe(input().props.id);
    h.session.attemptFirstFactorVerification.mockRejectedValueOnce(new Error('Provider rejected test value')); enter('synthetic_password'); submit(); await eventually(() => expect(text(view.tree)).toContain('Verification needs attention')); expect(input().props['aria-invalid']).toBe(true); const description = input().props['aria-describedby']; expect(nodes(view.tree).some(node => node.props?.id === description)).toBe(true); expect(input().props.value).toBe(''); expect(props.onComplete).not.toHaveBeenCalled(); old.unmount();
  });
});
