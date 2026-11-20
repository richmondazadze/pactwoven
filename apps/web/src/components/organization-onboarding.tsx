'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CreateOrganization, OrganizationSwitcher, useAuth, useClerk } from '@clerk/nextjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { OrganizationBootstrapPayloadSchema, OperationSchema, SessionSchema, type OrganizationBootstrapPayload, type Session } from '@pactwoven/contracts';
import { apiRequest, RequestError } from '@/lib/api';
import { getApiBase } from '@/lib/config';
import { bootstrapFailureKind, browserRecoveryStorage, clearBootstrapRecovery, createBootstrapRecovery, readBootstrapRecovery, removeBootstrapRecovery, storeBootstrapRecovery, type BootstrapRecovery, type BootstrapScope } from '@/lib/bootstrap-recovery';
import { Alert, ButtonLink, LoadingState, Panel } from './ui';
import { Icon } from './icon';
import { authAppearance } from './auth-shell';
import { readableRequestFailure } from '../lib/presentation';
import { SupportDetails } from './support-details';
import { workspaceAuthPath, workspaceOnboardingPath } from '../lib/workspace-return';

type SessionCheck = { status: 'checking' } | { status: 'setup' } | { status: 'ready'; session: Session } | { status: 'error'; error: RequestError };
const orgDestinations = (destination: string) => { const path = workspaceOnboardingPath(destination); return { afterCreateOrganizationUrl: path, afterSelectOrganizationUrl: path, afterSelectPersonalUrl: path, afterLeaveOrganizationUrl: path }; };
export function OrganizationOnboarding({ destination = '/app' }: { destination?: string }) {
  const { isLoaded, isSignedIn, userId, orgId, orgRole } = useAuth();
  const { signOut } = useClerk();
  const [createAnother, setCreateAnother] = useState(false);
  const apiBase = getApiBase();
  const scope = useMemo(() => userId && orgId && apiBase ? { userId, organizationId: orgId, apiBase } : null, [userId, orgId, apiBase]);
  useEffect(() => { setCreateAnother(false); }, [orgId]);
  const signOutSafely = () => { clearBootstrapRecovery(browserRecoveryStorage()); void signOut({ redirectUrl: '/sign-in' }); };
  if (!isLoaded) return <main className="workspace-connection"><LoadingState label="Checking your account"/></main>;
  if (!isSignedIn || !userId) return <main className="workspace-connection"><h1>Sign in to set up your workspace.</h1><p>Organization access must be verified before setup can continue.</p><ButtonLink href={workspaceAuthPath('/sign-in', workspaceOnboardingPath(destination))}>Sign in</ButtonLink></main>;
  return <div className="onboarding-page"><a href="#onboarding-main" className="skip-link">Skip to setup</a><header className="onboarding-header"><Link href="/" className="brand-link"><img src="/brand/logo.svg" alt="Pactwoven" width="170" height="38"/></Link><div className="actions"><button type="button" className="text-action signout-action" onClick={signOutSafely}>Sign out<Icon name="arrow-right" size={16}/></button></div></header><main id="onboarding-main" className="onboarding-main"><div className="onboarding-progress" aria-label="Workspace setup progress"><span><Icon name="circle-check"/>Account verified</span><span className={orgId && !createAnother ? 'complete' : 'current'}><Icon name="building"/>{orgId && !createAnother ? 'Organization selected' : 'Choose organization'}</span><span className={orgId && !createAnother ? 'current' : ''}><Icon name="map-pin"/>First site</span></div>{!orgId || createAnother ? <ChooseOrganization destination={destination} key={`choose:${orgId ?? 'none'}`} onReturn={orgId ? () => setCreateAnother(false) : undefined}/> : scope ? <BootstrapOrganization destination={destination} key={`${userId}:${orgId}:${orgRole}`} scope={scope} isAdmin={orgRole === 'org:admin'} onCreateAnother={() => setCreateAnother(true)}/> : <Panel title="Your workspace service is not connected"><p className="body-copy">Service setup must finish before organization access or site creation can be verified.</p><ButtonLink href="/" secondary>Back to Pactwoven</ButtonLink></Panel>}</main></div>;
}
function ChooseOrganization({ onReturn, destination }: { onReturn: (() => void) | undefined; destination: string }) {
  return <div className="onboarding-grid"><section className="onboarding-intro"><div className="onboarding-intro-copy"><p className="eyebrow">Your work belongs together</p><h1>A home for<br/>your organization.</h1><p>Create the organization that owns the work, or select one you already belong to. Your current membership determines access.</p></div><div className="onboarding-explainer"><span><Icon name="building" size={24}/></span><div><strong>One organization. Clear boundaries.</strong><p>Responsibilities and sites stay within their verified organization. Creating an organization does not authorize supplier orders or funds.</p></div></div><div className="existing-organization"><span>Already a member?</span><OrganizationSwitcher hidePersonal skipInvitationScreen {...orgDestinations(destination)} createOrganizationMode="modal" fallback={<span className="fine">Loading your organizations…</span>}/></div>{onReturn && <button type="button" className="button secondary" onClick={onReturn}><Icon name="arrow-left"/>Return to selected organization</button>}</section><section className="clerk-organization-card" aria-label="Create organization"><CreateOrganization appearance={authAppearance} routing="hash" afterCreateOrganizationUrl={workspaceOnboardingPath(destination)} skipInvitationScreen fallback={<LoadingState label="Loading organization setup"/>}/><p className="fine">Invitations are skipped here. No messages are sent during this first setup step.</p></section></div>;
}
function BootstrapOrganization({ scope, isAdmin, onCreateAnother, destination }: { scope: BootstrapScope; isAdmin: boolean; onCreateAnother: () => void; destination: string }) {
  const router = useRouter(); const auth = useAuth();
  const getToken = useCallback(() => auth.getToken({ skipCache: true, organizationId: scope.organizationId }), [auth.getToken, scope.organizationId]);
  const [check, setCheck] = useState<SessionCheck>({ status: 'checking' });
  const [attempt, setAttempt] = useState<BootstrapRecovery | null>(null);
  const [attemptReady, setAttemptReady] = useState(false);
  const [failure, setFailure] = useState<RequestError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [durableRecovery, setDurableRecovery] = useState(true);
  const sending = useRef(false), mounted = useRef(true), observation = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null), focusNextAttempt = useRef(false);
  const form = useForm<OrganizationBootstrapPayload>({ resolver: zodResolver(OrganizationBootstrapPayloadSchema), defaultValues: { initialSite: { name: '', timeZone: 'UTC' } } });
  const ref = useRef<HTMLDivElement>(null);
  const zones = ['UTC', ...Intl.supportedValuesOf('timeZone')];
  const probeSession = useCallback(async () => {
    observation.current?.abort(); const controller = new AbortController(); observation.current = controller;
    setCheck({ status: 'checking' });
    try {
      const session = await apiRequest('/v1/session', SessionSchema.refine(value => value.actor.organizationId === value.organization.id), getToken, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      removeBootstrapRecovery(browserRecoveryStorage(), scope); setAttempt(null); setCheck({ status: 'ready', session }); router.replace(destination);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      const issue = error instanceof RequestError ? error : new RequestError('SESSION_UNAVAILABLE', 'Your workspace access could not be verified.');
      if (issue.status === 409 && issue.code === 'ORGANIZATION_SETUP_REQUIRED') setCheck({ status: 'setup' });
      else setCheck({ status: 'error', error: issue });
    }
  }, [getToken, router, scope, destination]);
  useEffect(() => { mounted.current = true; const saved = readBootstrapRecovery(browserRecoveryStorage(), scope); if (saved) { setAttempt(saved); setConfirmed(saved.outcome === 'confirmed'); form.reset(saved.command.payload); } else { const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; if (zone) form.setValue('initialSite.timeZone', zone); } setAttemptReady(true); void probeSession(); return () => { mounted.current = false; observation.current?.abort(); mutation.current?.abort(); }; }, [scope, probeSession, form]);
  useEffect(() => { if (!attempt && focusNextAttempt.current) { focusNextAttempt.current = false; form.setFocus('initialSite.name'); } }, [attempt, form]);
  const failureKind = failure ? bootstrapFailureKind(failure) : null;
  const locked = submitting || confirmed || Boolean(attempt);
  async function execute(candidate: BootstrapRecovery) {
    if (sending.current || !isAdmin || !attemptReady || confirmed || candidate.outcome === 'confirmed') return;
    sending.current = true; setSubmitting(true); setFailure(null);
    const controller = new AbortController(); mutation.current = controller;
    setAttempt(candidate); setDurableRecovery(storeBootstrapRecovery(browserRecoveryStorage(), candidate));
    try {
      const operation = await apiRequest('/v1/organizations/bootstrap', OperationSchema, getToken, { body: candidate.command, idempotencyKey: candidate.key, signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      if (operation.status === 'succeeded') { confirmSetup(candidate); await probeSession(); }
      else if (operation.status === 'failed') setFailure(new RequestError('BOOTSTRAP_REJECTED', 'The service rejected this setup operation. Its reference is retained for review.', 422));
      else setFailure(new RequestError('OUTCOME_UNKNOWN', `The setup result is ${operation.status}. Keep the existing request while its result is checked.`));
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      const issue = error instanceof RequestError ? error : new RequestError('OUTCOME_UNKNOWN', 'The setup response could not be confirmed.'); setFailure(issue);
      if (issue.status === 403) setCheck({ status: 'error', error: issue });
      if (bootstrapFailureKind(issue) === 'already-configured') { confirmSetup(candidate); await probeSession(); }
      if (issue.fields) { for (const [field] of Object.entries(issue.fields)) { const name = field.replace(/^payload\./,''); if (name === 'initialSite.name' || name === 'initialSite.timeZone') form.setError(name, { message: name === 'initialSite.name' ? 'Check the site name and try again.' : 'Choose a valid time zone for the site.' }); } }
    } finally { sending.current = false; if (mounted.current) setSubmitting(false); }
  }
  function confirmSetup(candidate: BootstrapRecovery) { const completed: BootstrapRecovery = { ...candidate, outcome: 'confirmed' }; setConfirmed(true); setAttempt(completed); setDurableRecovery(storeBootstrapRecovery(browserRecoveryStorage(), completed)); }
  const begin = (payload: OrganizationBootstrapPayload) => { if (attempt || confirmed) return; void execute(createBootstrapRecovery(scope, payload, crypto.randomUUID())); };
  const newAttempt = () => { if (failureKind !== 'rejected') return; removeBootstrapRecovery(browserRecoveryStorage(), scope); setAttempt(null); setFailure(null); setConfirmed(false); focusNextAttempt.current = true; };
  return <div ref={ref} className="onboarding-grid"><section className="onboarding-intro"><div className="onboarding-intro-copy"><p className="eyebrow">A place for the work</p><h1>Start with<br/>your first site.</h1><p>A site gives responsibilities a shared location and time zone. Name the place where your team will coordinate work.</p></div><div className="selected-organization"><span>Current organization</span><OrganizationSwitcher hidePersonal skipInvitationScreen {...orgDestinations(destination)} fallback={<span className="fine">Loading organization…</span>}/></div><div className="onboarding-explainer"><span><Icon name="clock" size={24}/></span><div><strong>Everyone works from the same time.</strong><p>Service windows use the site’s time zone, including daylight-saving changes. Your device’s time zone does not silently replace it.</p></div></div><button type="button" className="text-action" onClick={onCreateAnother}>Create a different organization<Icon name="arrow-right" size={16}/></button></section><div className="onboarding-form-column">{check.status === 'checking' || !attemptReady ? <Panel title={confirmed ? 'Verifying your workspace' : 'Checking organization access'}><LoadingState label={confirmed ? 'Setup confirmed. Loading your workspace…' : 'Checking the selected organization…'}/></Panel> : check.status === 'ready' ? <Panel title="Your workspace is ready"><p className="body-copy">Organization access has been verified. Opening your workspace.</p><ButtonLink href={destination}>Open workspace<Icon name="arrow-right"/></ButtonLink></Panel> : check.status === 'error' ? <Panel title="Access needs attention"><Alert title="Organization access could not be verified" tone="red"><p>{readableRequestFailure(check.error, 'access')}</p><SupportDetails context="workspace-access" error={check.error} /></Alert><div className="actions"><button type="button" className="button" onClick={() => void probeSession()}>Check access again</button>{check.error.status === 401 && <ButtonLink href={workspaceAuthPath('/sign-in', workspaceOnboardingPath(destination))} secondary>Verify sign-in</ButtonLink>}</div>{attempt && <p className="recovery-note">The earlier setup request remains recorded in this tab. It has not been resent.</p>}</Panel> : !isAdmin ? <Panel title="An organization admin needs to finish setup"><Alert title="Admin access is required" tone="blue"><p>Your current organization membership does not permit this setup step. Ask an existing organization admin to add the first site, or choose another organization above.</p></Alert><button type="button" className="button secondary" onClick={() => void probeSession()}>Check setup again</button><p className="fine">This page does not change your role or grant ownership.</p></Panel> : <Panel title="First site"><form onSubmit={form.handleSubmit(begin)} noValidate><fieldset disabled={locked} className="form-grid"><label className="field form-wide">Site name<input {...form.register('initialSite.name')} autoComplete="off" maxLength={180} placeholder="For example, the main office or event venue" aria-invalid={Boolean(form.formState.errors.initialSite?.name)} aria-describedby="site-name-error"/><span className="field-error" id="site-name-error">{form.formState.errors.initialSite?.name?.message}</span></label><label className="field form-wide">Site time zone<select {...form.register('initialSite.timeZone')} aria-invalid={Boolean(form.formState.errors.initialSite?.timeZone)} aria-describedby="site-zone-hint site-zone-error">{zones.map(zone => <option key={zone} value={zone}>{zone.replaceAll('_',' ')}</option>)}</select><small id="site-zone-hint">Choose the time zone of the site, even if you are working elsewhere.</small><span className="field-error" id="site-zone-error">{form.formState.errors.initialSite?.timeZone?.message}</span></label></fieldset><div className="onboarding-form-note"><Icon name="shield-lock"/><p>Only an organization administrator can finish setup.</p></div>{!attempt && <button type="submit" className="button onboarding-submit" disabled={submitting || confirmed} aria-busy={submitting}>{submitting ? 'Setting up workspace…' : 'Create site & open workspace'}<Icon name="arrow-right"/></button>}</form>
  {attempt && !confirmed && <div className="bootstrap-recovery"><Alert title={failureKind === 'rejected' ? 'This attempt was rejected' : submitting ? 'Setting up your workspace' : 'Workspace setup is awaiting confirmation'} tone={failureKind === 'rejected' ? 'red' : 'amber'}><p>{failure ? readableRequestFailure(failure, 'setup') : submitting ? 'Waiting for the service to confirm setup. Your submitted site details are kept together while the result is checked.' : 'Your original site details are retained. Check setup status to recover the result without starting a second setup.'}</p><SupportDetails context="workspace-setup" error={failure} references={{ requestId: attempt.key }} label="Setup recovery details" /></Alert><div className="actions">{failureKind === 'rejected' ? <button type="button" className="button secondary" onClick={newAttempt}>Review a new attempt</button> : <button type="button" className="button" disabled={submitting} onClick={() => void execute(attempt)}>{submitting ? 'Waiting for confirmation…' : 'Check setup status'}</button>}<button type="button" className="button secondary" disabled={submitting} onClick={() => void probeSession()}>Check workspace access</button></div>{failureKind === 'reauthenticate' && <p className="recovery-note">Verify your sign-in, then return to check the same request. Signing out explicitly clears this tab’s private setup draft.</p>}{!durableRecovery && <p className="recovery-note">Browser storage is unavailable. Keep this page open to retain the unresolved request.</p>}</div>}
  {confirmed && <Alert title="Setup confirmed; access verification pending" tone="blue"><p>The service has confirmed that this organization is configured. Another setup request will not be sent while workspace access is checked.</p><button type="button" className="button secondary" onClick={() => void probeSession()}>Check workspace access</button></Alert>}
  <p className="onboarding-footer-note">Creating a site does not authorize payments or supplier orders.</p></Panel>}</div></div>;
}
