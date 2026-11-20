import { invocationDeadline } from '../deadline.js';
import { publishWorkspaceWork } from '../dispatch-workspaces.js';
import { createNativeExecutionHandler, createNativeNudgeVerifier, readNativeNudgeIdentity } from '../nudge.js';

let verifier: ReturnType<typeof createNativeNudgeVerifier> | undefined;

export default {
  fetch(request: Request) {
    const deadlineAt = invocationDeadline(60_000);
    return createNativeExecutionHandler({
      verify: incoming => {
        verifier ??= createNativeNudgeVerifier(readNativeNudgeIdentity(process.env));
        return verifier(incoming);
      },
      publish: () => publishWorkspaceWork(deadlineAt),
    })(request);
  },
};
