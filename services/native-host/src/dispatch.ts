import { NativeDispatchPublicationSchema, type NativeDispatchMessage, type NativeDispatchPublisherRepository } from '@pactwoven/contracts';

export type QueueSend = (message: NativeDispatchMessage, options: { idempotencyKey: string; retentionSeconds: number; delaySeconds: number }) => Promise<unknown>;
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('Dispatch response was not confirmed.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** A timeout is unknown acceptance. The same saved idempotency key is retried. */
export async function publishNativeDispatch(dependencies: {
  repository: NativeDispatchPublisherRepository; send: QueueSend; deadlineAt: number; now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  if (!Number.isFinite(dependencies.deadlineAt)) throw Error('A dispatch deadline is required.');
  const result = { accepted: 0, unconfirmed: 0 };
  const publisherId = `publisher-${crypto.randomUUID()}`;
  for (let index = 0; index < 5 && dependencies.deadlineAt - now() >= 20_000; index++) {
    const publications = await dependencies.repository.claimPublications(publisherId, 1, 45_000);
    if (publications.length === 0) break;
    if (publications.length !== 1) throw Error('Invalid dispatch publication response.');
    const publication = NativeDispatchPublicationSchema.parse(publications[0]);
    const remaining = dependencies.deadlineAt - now();
    if (remaining < 15_000) {
      // Claiming can consume the connection/statement budget. Never begin an
      // external send using the pre-claim clock. With no settlement time left,
      // let the fenced publication lease expire for the recovery scanner.
      if (remaining >= 6_000) await dependencies.repository.retryPublication(publication, 30_000);
      break;
    }
    const delaySeconds = Math.max(0, Math.ceil((Date.parse(publication.notBefore) - now()) / 1_000));
    if (delaySeconds > 86_000) throw Error('Dispatch is outside the supported delivery window.');
    try {
      // Transport metadata contains no objective, messages, source text or secrets.
      await bounded(dependencies.send(publication.message, { idempotencyKey: publication.idempotencyKey,
        retentionSeconds: 86_400, delaySeconds }), Math.min(10_000, remaining - 5_000));
      await dependencies.repository.acknowledgePublication(publication);
      result.accepted += 1;
    } catch {
      result.unconfirmed += 1;
      if (dependencies.deadlineAt - now() >= 6_000) await dependencies.repository.retryPublication(publication, 30_000);
      // A provider outage does not fan out across the rest of the pending work.
      break;
    }
  }
  return result;
}
