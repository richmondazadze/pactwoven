import { NativeAgentWorkListQuerySchema, NativeAgentWorkPageSchema } from '../../../../packages/contracts/src/native-agent-work';
import { agentWorkResponseScope, type AgentWorkScope } from './native-agent-work';
export type WorkFilter = 'all' | 'active' | 'completed';
export const workStateLabels = { queued: 'Queued', working: 'Working', waiting: 'Working with specialists', paused: 'Paused', cancelled: 'Cancelled', completed: 'Advice ready', needs_review: 'Needs review' } as const;
export function workListPath(siteId: string, q: string, filter: WorkFilter, cursor?: string) {
  const input = NativeAgentWorkListQuerySchema.parse({ siteId, limit: 20, q, filter, ...(cursor ? { cursor } : {}) });
  return `/v1/agent-work?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}`;
}
export function workListSchema(scope: AgentWorkScope, filter: WorkFilter, cursor?: string) {
  return NativeAgentWorkPageSchema.refine(value => agentWorkResponseScope(scope, value) && value.items.length <= 20 &&
    new Set(value.items.map(item => item.id)).size === value.items.length && value.nextCursor !== cursor &&
    value.items.every(item => filter === 'completed' ? item.state === 'completed' : filter !== 'active' || !['completed', 'cancelled'].includes(item.state)));
}
