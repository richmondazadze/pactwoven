import { getVercelOidcToken } from '@vercel/functions/oidc';
import { nativeExecutionOrigin } from './config.js';

type NudgeDependencies = { token: () => Promise<string>; fetch: typeof fetch; now: () => number };
const defaults: NudgeDependencies = { token: () => getVercelOidcToken(), fetch: (...args) => fetch(...args), now: () => Date.now() };
const unavailable = () => Error('The saved work wake-up was not confirmed.');

/** Wake the execution service's outbox scanner; never send task or user data. */
export async function sendNativeExecutionNudge(origin: string, deadlineAt: number, dependencies: NudgeDependencies = defaults): Promise<void> {
  const target = new URL('/internal/nudge', nativeExecutionOrigin(origin));
  const milliseconds = Math.min(4_000, deadlineAt - dependencies.now() - 100);
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(milliseconds) || milliseconds <= 0) throw unavailable();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const token = await dependencies.token();
      // Never start a late request after a timed-out OIDC read/exchange.
      if (controller.signal.aborted || dependencies.now() >= deadlineAt - 100 ||
          token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw unavailable();
      const response = await dependencies.fetch(target, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'x-vercel-trusted-oidc-idp-token': token },
      });
      // Acknowledgement is only a nudge receipt; no response body is trusted.
      void response.body?.cancel().catch(() => undefined);
      if (response.status !== 202) throw unavailable();
    })();
    await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, milliseconds);
    })]);
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Retry only the bodyless, idempotent outbox wake-up, never task/payment commands.
 * Three attempts share the original invocation deadline. The durable schedule
 * remains the fallback for sustained outages; it does not extend task authority.
 */
export async function sendNativeExecutionNudgeWithRecovery(origin: string, deadlineAt: number,
  dependencies: NudgeDependencies = defaults): Promise<void> {
  nativeExecutionOrigin(origin);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay = attempt === 1 ? 250 : 750;
      if (!Number.isFinite(deadlineAt) || dependencies.now() + delay + 100 >= deadlineAt) throw unavailable();
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    try { await sendNativeExecutionNudge(origin, deadlineAt, dependencies); return; }
    catch { if (attempt === 2 || dependencies.now() >= deadlineAt - 100) throw unavailable(); }
  }
  throw unavailable();
}

export function nudgeNativeExecution(deadlineAt: number): Promise<void> {
  return sendNativeExecutionNudgeWithRecovery(nativeExecutionOrigin(process.env.NATIVE_EXECUTION_ORIGIN), deadlineAt);
}
