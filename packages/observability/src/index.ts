import { z } from 'zod';
import { EnvironmentSchema } from '@pactwoven/contracts';

const SafeEventSchema = z.strictObject({
  event: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  level: z.enum(['info', 'warn', 'error']),
  environment: EnvironmentSchema,
  correlationId: z.string().max(128).optional(),
  organizationId: z.string().max(128).optional(),
  operationId: z.string().max(128).optional(),
  code: z.string().regex(/^[A-Z0-9_]{1,80}$/).optional(),
  durationMs: z.number().nonnegative().finite().optional(),
  status: z.number().int().min(100).max(599).optional(),
});
export type SafeEvent = z.infer<typeof SafeEventSchema>;
export type LogSink = (line: string) => void;

// Logs accept known metadata only: request bodies, raw exceptions, URLs and headers
// must never flow into this interface.
export function createLogger(sink: LogSink = line => console.log(line)) {
  return (event: SafeEvent): void => {
    const parsed = SafeEventSchema.safeParse(event);
    if (!parsed.success) {
      sink(JSON.stringify({ event: 'logging.invalid_metadata', level: 'error' }));
      return;
    }
    sink(JSON.stringify({ ...parsed.data, at: new Date().toISOString() }));
  };
}
