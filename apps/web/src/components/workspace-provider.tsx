'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth, useClerk } from '@clerk/nextjs';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { SessionSchema, type Session } from '@pactwoven/contracts';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, useRef, useMemo, type ReactNode } from 'react';
import { apiRequest, RequestError, type TokenSource } from '@/lib/api';
import { getApiBase } from '@/lib/config';
import { SetupState } from './setup-state';
import { Alert, LoadingState } from './ui';
export type DraftMemory = Map<string, unknown>;
const WorkspaceContext = createContext<{ session: Session; getToken: TokenSource; drafts: DraftMemory } | null>(null);
export function useWorkspace() { const value = useContext(WorkspaceContext); if (!value) throw new Error('An authorized workspace is required'); return value; }
export function canCreate(session: Session) { return session.actor.roles.some(role => role === 'owner' || role === 'operations'); }
export function canReadResponsibilities(session: Session) { return session.actor.roles.some(role => ['owner','operations','finance','receiver','auditor'].includes(role)); }
function SessionContent({ children }: { children: ReactNode }) {
  const router = useRouter();
  const auth = useAuth(); const { signOut } = useClerk(); const client = useQueryClient();
  const getToken = useCallback(() => auth.getToken(auth.orgId ? { organizationId: auth.orgId } : undefined), [auth.getToken, auth.orgId]);
  const query = useQuery({ queryKey: ['session'], queryFn: ({ signal }) => apiRequest('/v1/session', SessionSchema.refine(value => value.actor.organizationId === value.organization.id, 'Organization context must match the authenticated actor'), getToken, { signal }), retry: false, staleTime: 15_000, refetchOnWindowFocus: true });
  const requiresSetup = query.error instanceof RequestError && query.error.status === 409 && query.error.code === 'ORGANIZATION_SETUP_REQUIRED';
  useEffect(() => { if (requiresSetup) router.replace('/app/onboarding'); }, [requiresSetup, router]);
  const authorizationScope = query.data ? JSON.stringify([query.data.actor.organizationId, query.data.actor.environment, query.data.actor.roles, query.data.actor.siteIds, query.data.organization.authorityEpoch]) : null;
  const drafts = useMemo<DraftMemory>(() => new Map(), [authorizationScope]);
  useEffect(() => { if (query.error instanceof RequestError && [401,403].includes(query.error.status)) { drafts.clear(); void client.cancelQueries({ predicate: q => q.queryKey[0] !== 'session' }); client.removeQueries({ predicate: q => q.queryKey[0] !== 'session' }); } }, [query.error, client, drafts]);
  const previousScope = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (authorizationScope && previousScope.current && authorizationScope !== previousScope.current) {
      drafts.clear();
      void client.cancelQueries({ predicate: q => q.queryKey[0] !== 'session' });
      client.removeQueries({ predicate: q => q.queryKey[0] !== 'session' });
    }
    previousScope.current = authorizationScope;
  }, [authorizationScope, client, drafts]);
  if (requiresSetup) return <main className="workspace-connection"><LoadingState label="Opening organization setup"/><Link href="/app/onboarding" className="button secondary">Continue setup</Link></main>;
  if (query.isPending) return <main className="workspace-connection"><LoadingState label="Verifying organization access"/></main>;
  if (query.isError) { const error = query.error; const denied = error instanceof RequestError && [401,403].includes(error.status); return <main className="workspace-connection"><Link href="/" className="brand-link"><img src="/brand/logo.svg" alt="Pactwoven" width="170" height="38"/></Link><h1>{denied ? 'Your workspace access needs attention.' : 'The workspace is temporarily unavailable.'}</h1><Alert title={denied ? 'Access not verified' : 'Unable to retrieve your organization'} tone="red"><p>{error.message}</p>{error instanceof RequestError && error.correlationId && <p className="fine">Reference: {error.correlationId}</p>}</Alert><div className="actions"><button className="button" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? 'Checking access…' : 'Check again'}</button><button className="button secondary" onClick={() => void signOut({ redirectUrl: '/sign-in' })}>Sign out</button></div></main>; }
  return <WorkspaceContext key={authorizationScope} value={{ session: query.data, getToken, drafts }}>{children}</WorkspaceContext>;
}
function ScopedQueries({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } }));
  useEffect(() => () => { void client.cancelQueries(); client.clear(); }, [client]);
  return <QueryClientProvider client={client}><SessionContent>{children}</SessionContent></QueryClientProvider>;
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, orgId, sessionId } = useAuth();
  if (!isLoaded) return <main className="workspace-connection"><LoadingState label="Checking your sign-in"/></main>;
  if (!isSignedIn) return <main className="workspace-connection"><h1>Sign in to your workspace.</h1><p>Your session has ended. Sign in again to verify organization access.</p><Link href="/sign-in" className="button">Sign in</Link></main>;
  if (!orgId) return <OrganizationRequired/>;
  if (!getApiBase()) return <SetupState kind="service"/>;
  return <ScopedQueries key={`${userId}:${orgId ?? 'none'}:${sessionId}`}>{children}</ScopedQueries>;
}

function OrganizationRequired() { const router = useRouter(); useEffect(() => { router.replace('/app/onboarding'); }, [router]); return <main className="workspace-connection"><LoadingState label="Choose an organization to continue"/><Link href="/app/onboarding" className="button secondary">Choose organization</Link></main>; }
