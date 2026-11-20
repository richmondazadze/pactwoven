import { publishPaidHostWork, recoverPaidHostWork } from './paid-runtime';
import { publishNativeWork, recoverNativeWork } from './dispatch-runtime';
import { publishDelegatedHostWork, recoverDelegatedHostWork } from './delegated-host-runtime';

// Each queue has its own transactional outbox and pool. Start the scans within
// the same invocation budget so a busy or unavailable queue cannot starve the
// other. A failed scan stays recoverable in its original outbox.
async function dispatchBoth(deadlineAt: number, actions: ((deadlineAt: number) => Promise<unknown>)[]) {
  const unavailable = () => Error('Background dispatch remains pending.');
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) throw unavailable();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A stalled legacy pool must not hold the combined handler indefinitely.
    // allSettled observes any late result; timeout never means rollback.
    const outcomes = await Promise.race([
      Promise.allSettled(actions.map(action => Promise.resolve().then(() => action(deadlineAt)))),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), Math.max(0, deadlineAt - Date.now())); }),
    ]);
    if (Date.now() >= deadlineAt || outcomes.some(outcome => outcome.status === 'rejected')) throw unavailable();
  } finally { clearTimeout(timer); }
}

export const publishWorkspaceWork = (deadlineAt: number) => dispatchBoth(deadlineAt, [publishNativeWork, publishDelegatedHostWork, publishPaidHostWork]);
export const recoverWorkspaceWork = (deadlineAt: number) => dispatchBoth(deadlineAt, [recoverNativeWork, recoverDelegatedHostWork, recoverPaidHostWork]);
