import { randomUUID } from 'node:crypto';
import { GoogleDiscoveryInputSchema, GoogleDiscoveryPrepareSchema, GoogleDiscoveryRequestKeySchema, GoogleDiscoveryOverviewSchema, GoogleDiscoveryReviewSchema, type NativeGoogleDiscoveryReaderPort } from '../../../packages/contracts/src/native-google-discovery';
import { NativeGoogleError, type NativeGoogleSignedSessionSource } from '../../../packages/contracts/src/native-google';
import type { PostgresNativeGoogleDiscoveryRepository } from '../../../packages/db/src/native-google-discovery-repository';
import { googleDisplayText, googleEventLinkTarget, googleNamedEvent } from './native-google-discovery-presentation';

export class NativeGoogleDiscoveryGateway {
  constructor(readonly publicWebOrigin: string, private readonly sessions: NativeGoogleSignedSessionSource, private readonly store: PostgresNativeGoogleDiscoveryRepository, private readonly reader: NativeGoogleDiscoveryReaderPort) {
    const origin = new URL(publicWebOrigin);
    if (origin.origin !== publicWebOrigin || origin.protocol !== 'https:' || !Object.isFrozen(reader.binding) || reader.binding.redirectUri !== publicWebOrigin + '/app/settings/connections/google/callback' || reader.binding.expectedEmail !== 'richverseecotech@gmail.com') throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');
  }
  async overview(bearer: string, signal: AbortSignal) {
    const value = GoogleDiscoveryOverviewSchema.parse(await this.store.overview(await this.sessions.resolve(bearer, signal)));
    signal.throwIfAborted();
    for (const task of value.tasks) { googleDisplayText(task.title); googleDisplayText(task.siteName); }
    for (const consent of value.consents) { googleDisplayText(consent.rootTitle); if (consent.details === 'available') googleDisplayText(consent.eventName); }
    return value;
  }
  async baseline(bearer: string, input: unknown, signal: AbortSignal) {
    const q = GoogleDiscoveryInputSchema.parse(input), target = googleEventLinkTarget(q.eventLink, this.reader.binding.expectedEmail);
    const session = await this.sessions.resolve(bearer, signal); signal.throwIfAborted();
    const ticket = await this.store.begin(session, { connectionId: q.connectionId, target, allowRead: true }), operationId = randomUUID();
    try {
      const read = await this.reader.read(ticket.id, operationId, signal);
      const current = await this.sessions.resolve(bearer, signal);
      if (current.actor.sessionId !== read.session.actor.sessionId || current.actor.authenticatedAt !== read.session.actor.authenticatedAt || current.actor.actorId !== read.session.actor.actorId || current.actor.organizationId !== read.session.actor.organizationId || current.actor.environment !== read.session.actor.environment) throw new NativeGoogleError('GOOGLE_DENIED');
      const event = googleNamedEvent(read.event, target.eventId, Date.parse(read.observedAt));
      signal.throwIfAborted(); const receipt = await this.store.complete(ticket.id, operationId, current, event, read.observedAt); signal.throwIfAborted(); return receipt;
    } catch (error) { await this.store.fail(ticket.id, operationId).catch(() => {}); throw error; }
  }
  async prepare(bearer: string, key: string, input: unknown, signal: AbortSignal) {
    const q = GoogleDiscoveryPrepareSchema.parse(input); googleDisplayText(q.purpose, 1000);
    const session = await this.sessions.resolve(bearer, signal); signal.throwIfAborted();
    const value = GoogleDiscoveryReviewSchema.parse(await this.store.prepare(session, GoogleDiscoveryRequestKeySchema.parse(key), q)); signal.throwIfAborted();
    googleDisplayText(value.rootTitle); googleDisplayText(value.siteName); googleDisplayText(value.eventName); googleDisplayText(value.purpose, 1000);
    return value;
  }
}
