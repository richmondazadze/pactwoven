import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, InstantSchema } from './core';
import { NativeGoogleConnectionSchema, NativeGoogleSessionSchema } from './native-google';

// Private composition schemas. Explicit public projections below never contain
// credentials, raw provider targets or signed-session evidence.
const Name = z.string().trim().min(1).max(300);
const Version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const GoogleDiscoveryTargetSchema = z.strictObject({ calendarId: z.literal('primary'), eventId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
export const GoogleDiscoveryInputSchema = z.strictObject({ connectionId: IdSchema, eventLink: z.string().min(1).max(4096), allowRead: z.literal(true) });
export const GoogleDiscoveryBeginSchema = z.strictObject({ connectionId: IdSchema, target: GoogleDiscoveryTargetSchema, allowRead: z.literal(true) });
export const GoogleDiscoveryPrepareSchema = z.strictObject({ baselineReference: IdSchema, taskReference: IdSchema, purpose: z.string().trim().min(1).max(1000), durationMinutes: z.union([z.literal(15), z.literal(60), z.literal(240), z.literal(1440)]) });
export const GoogleDiscoveryTicketSchema = z.strictObject({ id: IdSchema });
export const GoogleDiscoveryLeaseSchema = z.strictObject({ id: IdSchema, operationId: IdSchema, session: NativeGoogleSessionSchema, target: GoogleDiscoveryTargetSchema, connection: NativeGoogleConnectionSchema, expiresAt: InstantSchema });
export const GoogleDiscoveryEventSchema = z.strictObject({ kind: z.literal('calendar#event'), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), etag: z.string().min(1).max(512).regex(/^[^\s\u0000-\u001f\u007f]+$/), status: z.enum(['confirmed', 'tentative']), updated: InstantSchema, summary: Name, start: z.strictObject({ dateTime: InstantSchema }), end: z.strictObject({ dateTime: InstantSchema }) });
const EventFields = { eventName: Name, calendarName: z.literal('Primary calendar'), startsAt: InstantSchema, endsAt: InstantSchema };
export const GoogleDiscoveryBaselineSchema = z.strictObject({ reference: IdSchema, ...EventFields, validUntil: InstantSchema });
export const GoogleDiscoveryReviewSchema = z.strictObject({ id: IdSchema, token: z.string().regex(/^[a-f0-9]{64}$/), rootTitle: Name, siteName: Name, accountEmail: z.literal('richverseecotech@gmail.com'), ...EventFields, purpose: z.string().trim().min(1).max(1000), expiresAt: InstantSchema, confirmBy: InstantSchema, permission: z.literal('read_single_calendar_event'), outboundEffects: z.literal('forbidden'), continuesAfterSignOut: z.literal(true) });
const ConsentFields = { id: IdSchema, version: Version, rootTitle: Name, expiresAt: InstantSchema, status: z.enum(['prepared', 'approved', 'active', 'revoked']) };
export const GoogleDiscoveryConsentSchema = z.union([
  z.strictObject({ ...ConsentFields, details: z.literal('available'), ...EventFields }),
  z.strictObject({ ...ConsentFields, details: z.literal('unavailable'), preparedAt: InstantSchema }),
]);
export const GoogleDiscoveryOverviewSchema = z.strictObject({ availability: z.enum(['ready', 'unavailable']), connections: z.array(z.strictObject({ id: IdSchema, version: Version, email: z.literal('richverseecotech@gmail.com'), status: z.enum(['connected', 'refreshing', 'revoked', 'unavailable']) })).max(100), tasks: z.array(z.strictObject({ reference: IdSchema, title: Name, siteName: Name })).max(500), consents: z.array(GoogleDiscoveryConsentSchema).max(500) });
export type GoogleDiscoveryTarget = z.infer<typeof GoogleDiscoveryTargetSchema>;
export type GoogleDiscoveryBegin = z.infer<typeof GoogleDiscoveryBeginSchema>;
export type GoogleDiscoveryLease = z.infer<typeof GoogleDiscoveryLeaseSchema>;
export type GoogleDiscoveryEvent = z.infer<typeof GoogleDiscoveryEventSchema>;
export type GoogleDiscoveryPrepare = z.infer<typeof GoogleDiscoveryPrepareSchema>;
export type GoogleDiscoveryReview = z.infer<typeof GoogleDiscoveryReviewSchema>;
export type GoogleDiscoveryBaseline = z.infer<typeof GoogleDiscoveryBaselineSchema>;
export type GoogleDiscoveryOverview = z.infer<typeof GoogleDiscoveryOverviewSchema>;
export interface NativeGoogleDiscoveryReaderPort {
  readonly binding: Readonly<{ clientId: string; redirectUri: string; expectedEmail: string }>;
  read(id: string, operationId: string, signal: AbortSignal): Promise<{ event: GoogleDiscoveryEvent; observedAt: string; session: GoogleDiscoveryLease['session'] }>;
}
export { IdempotencyKeySchema as GoogleDiscoveryRequestKeySchema };
