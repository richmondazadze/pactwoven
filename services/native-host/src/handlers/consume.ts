import { nativeQueue } from '../queue.js';
import { invocationDeadline } from '../deadline.js';
import { NativeDeliveryRetry } from '../consume.js';
import { runNativeQueueMessage } from '../worker-runtime.js';

// Only Vercel's private queue trigger may reach this function. Header parsing
// alone is not authentication; the checked deployment config is mandatory.
export function POST(request: Request) {
  const deadlineAt = invocationDeadline(300_000);
  return nativeQueue.handleCallback<unknown>(payload => runNativeQueueMessage(payload, deadlineAt), {
    visibilityTimeoutSeconds: 300,
    retry: error => ({ afterSeconds: error instanceof NativeDeliveryRetry ? error.afterSeconds : 30 }),
  })(request);
}
