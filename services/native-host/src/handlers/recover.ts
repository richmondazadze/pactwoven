import { handleSchedule } from '@vercel/schedules';
import { recoverWorkspaceWork } from '../dispatch-workspaces.js';
import { invocationDeadline } from '../deadline.js';

// Private schedule trigger; never add a public rewrite to this handler.
export function POST(request: Request) {
  const deadlineAt = invocationDeadline(60_000);
  return handleSchedule(async metadata => {
    if (metadata.name !== 'native-recovery') throw Error('Unexpected native recovery schedule.');
    await recoverWorkspaceWork(deadlineAt);
  })(request);
}
