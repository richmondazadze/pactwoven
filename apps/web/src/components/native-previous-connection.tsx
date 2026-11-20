'use client';
import type { PreviousTaskRequest } from '../lib/native-tasks';
import { SupportDetails } from './support-details';
import { Alert } from './ui';

export function NativePreviousConnection({ requests }: { requests: PreviousTaskRequest[] }) {
  if (requests.length === 0) return null;
  const reply = requests.every(request => request.kind === 'reply');
  return <Alert title={reply ? 'An earlier message needs recovery' : 'An earlier task needs recovery'} tone="amber">
    <p>Your work connection changed while {reply ? 'a message was' : 'a task request was'} awaiting confirmation. The original details remain saved in this tab, and nothing has been resent.</p>
    <p>Restore the original work connection to check the saved request before {reply ? 'sending another message to this task' : 'starting another task'}. Copy the support details if you need help recovering it.</p>
    {requests.map((request, index) => <SupportDetails key={`${index}:${request.key}`} context="native-work" references={{ requestId: request.key, ...(request.taskId ? { recordId: request.taskId } : {}) }} label={requests.length > 1 ? `Saved request ${index + 1} details` : 'Saved request details'} />)}
  </Alert>;
}
