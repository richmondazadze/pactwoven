import { ResponsibilitySchema, ResponsibilityPageSchema, type Session, type Responsibility, type CreateResponsibilityPayload } from '@pactwoven/contracts';
export function siteName(session: Session, siteId: string) { return session.sites.find(site => site.id === siteId)?.name ?? 'Assigned site'; }
export function formatInstant(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone }).format(new Date(value));
}
export function readableState(value: string | null) { if (!value) return 'Not authorized'; return value.toLowerCase().replaceAll('_',' '); }
export function responsibilityFacts(record: Responsibility) { return [ ['Execution', readableState(record.executionState)], ['Authority', readableState(record.authorityState)], ['Coverage', readableState(record.coverageState)] ] as const; }
// Only translate an explicit ISO timestamp with an offset. Browser-local wall time
// must never silently become a site's time when users work across zones.
export function normalizeTimestamp(value: string): string { return new Date(value).toISOString(); }
export function newCreateCommand(payload: CreateResponsibilityPayload) { return { expectedVersion: 0, mandateVersion: null, authorityEpoch: null, payload } as const; }

export function scopedResponsibilitySchema(session: Session) { return ResponsibilitySchema.refine(record => record.organizationId === session.organization.id && record.environment === session.actor.environment, 'Record scope does not match the active workspace'); }
export function scopedResponsibilityPageSchema(session: Session) { return ResponsibilityPageSchema.refine(page => page.items.every(record => record.organizationId === session.organization.id && record.environment === session.actor.environment), 'Records do not match the active workspace'); }
