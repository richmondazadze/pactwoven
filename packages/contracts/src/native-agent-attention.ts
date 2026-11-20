import { z } from 'zod';
import { IdSchema } from './core';
import { NativeWorkIntentScopeSchema } from './native-work-intent';
import { NativeAgentWorkSummarySchema } from './native-agent-work';

const CursorSchema = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);
export const NativeAgentAttentionQuerySchema = z.strictObject({
  siteId: IdSchema, limit: z.coerce.number().int().min(1).max(50).default(20), cursor: CursorSchema.optional(),
});
/** A page is a bounded scan of current active work. An empty page with a cursor
 * does not establish that no older work needs attention. */
export const NativeAgentAttentionPageSchema = z.strictObject({
  scope: NativeWorkIntentScopeSchema,
  items: z.array(NativeAgentWorkSummarySchema.extend({ state: z.literal('needs_review') })).max(50),
  nextCursor: CursorSchema.nullable(), scannedCount: z.number().int().min(0).max(50), scanComplete: z.boolean(),
}).refine(page => page.scanComplete === (page.nextCursor === null) && page.items.length <= page.scannedCount &&
  (page.nextCursor === null || page.scannedCount > 0) && new Set(page.items.map(item => item.id)).size === page.items.length);
export type NativeAgentAttentionQuery = z.infer<typeof NativeAgentAttentionQuerySchema>;
export type NativeAgentAttentionPage = z.infer<typeof NativeAgentAttentionPageSchema>;
