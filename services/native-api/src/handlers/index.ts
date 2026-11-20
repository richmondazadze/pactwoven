import { nativePaidWorkApp } from '../paid-runtime';
import { waitUntil } from '@vercel/functions';
import { nativeApiApp, nativeAuthorityResources } from '../api-runtime.js';
import { createNativeHttpHandler } from '../http.js';
import { invocationDeadline } from '../deadline.js';
import { nudgeNativeExecution } from '../nudge.js';
import { createNativeAuthorityHandler, readNativeExecutorIdentity } from '../authority.js';
import { createVercelWorkloadVerifier } from '@pactwoven/service-identity';
import { createNativeDelegatedAuthorityHandler } from '../delegated-authority.js';
import { nativeDelegatedAuthorityResources } from '../delegated-authority-runtime.js';
import { nativeMemoryApp } from '../memory-runtime.js';
import { nativeWorkApp } from '../delegated-runtime.js';
import { nativeGoogleApp } from '../google-runtime.js';

let verifier: ReturnType<typeof createVercelWorkloadVerifier> | undefined;

export default {
  fetch(request: Request) {
    const deadlineAt = invocationDeadline(60_000);
    return createNativeHttpHandler({ app: nativeApiApp, memoryApp: nativeMemoryApp, workApp: nativeWorkApp, paidApp: () => nativePaidWorkApp(deadlineAt), googleApp: () => nativeGoogleApp(deadlineAt), nudge: () => nudgeNativeExecution(deadlineAt), defer: waitUntil,
      authority: createNativeAuthorityHandler({ deadlineAt, resources: nativeAuthorityResources, verify: incoming => {
        verifier ??= createVercelWorkloadVerifier(readNativeExecutorIdentity(process.env));
        return verifier(incoming);
      } }),
      delegatedAuthority: createNativeDelegatedAuthorityHandler({ deadlineAt, resources: nativeDelegatedAuthorityResources, verify: incoming => {
        verifier ??= createVercelWorkloadVerifier(readNativeExecutorIdentity(process.env));
        return verifier(incoming);
      } }),
    })(request);
  },
};
