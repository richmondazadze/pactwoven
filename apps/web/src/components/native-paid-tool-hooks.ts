'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativePaidToolView } from '../../../../packages/contracts/src/native-paid-tool';
import { RequestError } from '../lib/api';
import { agentWorkResponseScope, canStartAgentWork } from '../lib/native-agent-work';
import { clearPaidToolAttempt, createPaidToolAttempt, paidToolListSchema, paidToolPath, paidToolReadSchema, paidToolRequest, readPaidToolAttempt, recoverPaidToolControl, sendPaidToolControl, storePaidToolAttempt } from '../lib/native-paid-tool';
import { canObserveAgentWork, useAgentWorkBinding } from './native-agent-work-hooks';

function usePurchaseObservation(siteId: string, rootTaskId: string, operationId?: string, enabled = true) {
  const binding = useAgentWorkBinding(siteId), client = useQueryClient(), [visible, setVisible] = useState(canObserveAgentWork);
  const key = ['native-paid-tools', binding.identity, rootTaskId, operationId ? 'detail' : 'list', operationId ?? null] as const;
  const current = () => { if (!canObserveAgentWork()) throw new RequestError('OBSERVATION_PAUSED', 'Return to this tab and reconnect.'); return binding.current(); };
  const query = useQuery({ queryKey: key, enabled: enabled && visible,
    queryFn: async ({ signal }) => {
      const options = { signal: AbortSignal.any([signal, binding.controller.current.signal, AbortSignal.timeout(15000)]) };
      if (operationId) { const response = await paidToolRequest(paidToolPath(rootTaskId, siteId, operationId), paidToolReadSchema(binding.scope, rootTaskId, operationId), binding.scope, binding.getToken, current, options); return [response.purchase]; }
      return (await paidToolRequest(paidToolPath(rootTaskId, siteId), paidToolListSchema(binding.scope, rootTaskId), binding.scope, binding.getToken, current, options)).purchases;
    },
    refetchInterval: query => visible && enabled && !query.state.error && query.state.data?.some(p => !['completed','cancelled'].includes(p.state)) ? 3500 : false,
    retry: false, staleTime: 0, gcTime: 0, refetchIntervalInBackground: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  useEffect(() => {
    const changed = () => { const shown = canObserveAgentWork(); if (shown) void client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' }); else void client.cancelQueries({ queryKey: key, exact: true }); setVisible(shown); };
    document.addEventListener('visibilitychange', changed); window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { document.removeEventListener('visibilitychange', changed); window.removeEventListener('online', changed); window.removeEventListener('offline', changed); void client.cancelQueries({ queryKey: key, exact: true }); client.removeQueries({ queryKey: key, exact: true }); };
  }, [binding.identity, rootTaskId, operationId, client]);
  const purchases = !enabled || query.error ? undefined : query.data;
  return { ...query, data: purchases, purchases, observing: visible && enabled };
}
export function useNativePaidToolList(siteId: string, rootTaskId: string, enabled = true) { return usePurchaseObservation(siteId, rootTaskId, undefined, enabled); }
export function useNativePaidToolRead(siteId: string, rootTaskId: string, operationId: string, enabled = true) {
  const query = usePurchaseObservation(siteId, rootTaskId, operationId, enabled); return { ...query, purchase: query.purchases?.[0] };
}

/** Retains only command metadata before dispatch. Recovery and replay are explicit; neither runs on mount. */
export function useNativePaidToolControl(siteId: string, rootTaskId: string, operationId: string) {
  const binding = useAgentWorkBinding(siteId), client = useQueryClient();
  const [state, setState] = useState<{ identity: string; hasPending: boolean; busy: boolean; error: unknown; recoveryNotFound: boolean }>({ identity: '', hasPending: false, busy: false, error: null, recoveryNotFound: false });
  const lock = useRef<symbol | null>(null), controller = useRef<AbortController | null>(null);
  const identity = `${binding.identity}:${rootTaskId}:${operationId}`;
  const latestIdentity = useRef(identity); latestIdentity.current = identity;
  useEffect(() => {
    try { setState({ identity, hasPending: Boolean(readPaidToolAttempt(sessionStorage, binding.scope, rootTaskId, operationId)), busy: false, error: null, recoveryNotFound: false }); }
    catch (error) { setState({ identity, hasPending: true, busy: false, error, recoveryNotFound: false }); }
    const stop = () => { if (!canObserveAgentWork()) controller.current?.abort(); };
    document.addEventListener('visibilitychange', stop); window.addEventListener('offline', stop);
    return () => { controller.current?.abort(); lock.current = null; document.removeEventListener('visibilitychange', stop); window.removeEventListener('offline', stop); };
  }, [identity]);
  const current = () => { if (latestIdentity.current !== identity) throw new RequestError('SCOPE_CHANGED', 'Your purchase changed.'); if (!canObserveAgentWork()) throw new RequestError('OBSERVATION_PAUSED', 'Return to this tab and reconnect.'); return binding.current(); };
  async function run(mode: 'new' | 'recover' | 'retry', view?: NativePaidToolView, action?: 'cancel' | 'revoke') {
    if (lock.current) throw new RequestError('ACTION_PENDING', 'Check the current purchase action first.');
    const token = Symbol(); lock.current = token; controller.current = new AbortController();
    const signal = AbortSignal.any([controller.current.signal, binding.controller.current.signal, AbortSignal.timeout(15000)]);
    try {
      current(); setState(s => ({ ...s, identity, busy: true, error: null, recoveryNotFound: false }));
      let attempt = readPaidToolAttempt(sessionStorage, binding.scope, rootTaskId, operationId);
      if (mode === 'new') {
        if (attempt) throw new RequestError('ACTION_PENDING', 'Recover the original action before choosing another.');
        if (!view || !action || !canStartAgentWork(binding.session, siteId) || !agentWorkResponseScope(binding.scope, view) || view.rootTaskId !== rootTaskId || view.operationId !== operationId || !view.actions.includes(action)) throw new RequestError('FORBIDDEN', 'This purchase action is not currently available.');
        attempt = await createPaidToolAttempt(binding.scope, rootTaskId, operationId, view.version, action === 'cancel' ? 'cancel_before_signing' : 'revoke');
        current(); signal.throwIfAborted(); storePaidToolAttempt(sessionStorage, attempt);
      }
      if (!attempt) throw new RequestError('NO_PENDING_ACTION', 'There is no original action to check.');
      setState(s => ({ ...s, hasPending: true }));
      const response = mode === 'recover' ? await recoverPaidToolControl(attempt, binding.getToken, current, { signal }) : await sendPaidToolControl(attempt, binding.getToken, current, { signal });
      current(); signal.throwIfAborted();
      const found = !('recovery' in response) || response.recovery !== null;
      if (found) clearPaidToolAttempt(sessionStorage, attempt);
      setState({ identity, hasPending: !found, busy: false, error: null, recoveryNotFound: !found });
      await client.invalidateQueries({ queryKey: ['native-paid-tools', binding.identity, rootTaskId] });
      return response;
    } catch (error) {
      try { binding.current(); if (latestIdentity.current === identity) setState(s => ({ ...s, identity, busy: false, error })); } catch { /* An old scope must not update the new workspace. */ }
      throw error;
    } finally { if (lock.current === token) lock.current = null; }
  }
  const displayed = state.identity === identity ? state : { hasPending: false, busy: false, error: null, recoveryNotFound: false };
  return { ...displayed, act: (view: NativePaidToolView, action: 'cancel' | 'revoke') => run('new', view, action), recover: () => run('recover'), retryOriginal: () => run('retry') };
}
