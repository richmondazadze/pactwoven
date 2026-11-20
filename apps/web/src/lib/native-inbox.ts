import { NativeAgentAttentionQuerySchema, NativeAgentAttentionPageSchema } from '../../../../packages/contracts/src/native-agent-attention';
import { agentWorkResponseScope, type AgentWorkScope } from './native-agent-work';

export function inboxRequestPath(siteId: string, cursor?: string) {
  const query = NativeAgentAttentionQuerySchema.parse({ siteId, limit: 20, ...(cursor ? { cursor } : {}) });
  return `/v1/agent-work/attention?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`;
}
export function inboxPageSchema(scope: AgentWorkScope, cursor?: string) {
  return NativeAgentAttentionPageSchema.refine(page => agentWorkResponseScope(scope, page) && page.scannedCount <= 20 &&
    page.nextCursor !== cursor && new Set(page.items.map(item => item.id)).size === page.items.length);
}
export const inboxPath = (siteId: string) => `/app/inbox?${new URLSearchParams({ site: siteId })}`;

export function inboxScanCopy(items: number, complete: boolean, fromBeginning: boolean) {
  if (items > 0) return `${items} ${items === 1 ? 'task needs' : 'tasks need'} review.${complete ? '' : ' More work remains to be checked.'}`;
  return complete && fromBeginning ? 'No tasks needing review were found in your current work.'
    : 'No tasks needing review in this part of your work. Continue checking older work.';
}
