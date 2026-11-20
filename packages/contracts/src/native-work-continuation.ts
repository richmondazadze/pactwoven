import { z } from 'zod';
import { EnvironmentSchema, IdSchema } from './core';

// Content-free navigation from a retained legacy reference to its real root.
export const NativeWorkContinuationSchema = z.strictObject({
  scope: z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema }),
  taskId: IdSchema,
  continuation: z.strictObject({ kind: z.literal('agent_work'), id: IdSchema, siteId: IdSchema }).nullable(),
});
