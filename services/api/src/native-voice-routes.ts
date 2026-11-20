import type { Hono } from 'hono';
import { DomainError } from '@pactwoven/domain';
import { VoiceSpeakCommandSchema, VoiceTranscribeCommandSchema, VoiceTranscriptResponseSchema } from '../../../packages/contracts/src/native-voice';
import type { ApiEnv } from './app';
import { projectNativeAgentWork, type NativeAgentWorkRepository } from './native-agent-work-routes';
import { voiceAudioBytes, type NativeVoiceGateway } from './native-voice-service';

/** Voice returns drafts/audio only. It never starts, updates, approves or pays. */
export function registerNativeVoiceRoutes(app: Hono<ApiEnv>, gateway?: NativeVoiceGateway, work?: NativeAgentWorkRepository) {
  const active = new Set<string>();
  async function within<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (active.has(key) || active.size >= 4) throw new DomainError('VOICE_BUSY', 429, 'Voice is busy. Wait a moment and try again.');
    active.add(key); try { return await task(); } finally { active.delete(key); }
  }
  const access = (session: ApiEnv['Variables']['session'], siteId: string) => {
    if (session.actor.principalKind !== 'human' || !session.actor.siteIds.includes(siteId) || !session.sites.some(site => site.id === siteId))
      throw new DomainError('FORBIDDEN', 403, 'Current workspace access is required.');
    if (!gateway) throw new DomainError('SETUP_REQUIRED', 503, 'Voice is not connected yet. You can continue by typing.');
    return { environment: session.actor.environment, organizationId: session.actor.organizationId, siteId };
  };
  app.post('/v1/voice/transcribe', async c => {
    c.header('Cache-Control', 'private, no-store');
    const input = VoiceTranscribeCommandSchema.parse(c.get('requestBody')), session = c.get('session'), scope = access(session, input.siteId);
    voiceAudioBytes(input);
    const transcript = await within(JSON.stringify([scope.environment, scope.organizationId, session.actor.actorId]),
      () => gateway!.transcribe(input, c.req.raw.signal));
    return c.json(VoiceTranscriptResponseSchema.parse({ scope, transcript }));
  });
  app.post('/v1/voice/speak', async c => {
    c.header('Cache-Control', 'private, no-store');
    const input = VoiceSpeakCommandSchema.parse(c.get('requestBody')), session = c.get('session'), scope = access(session, input.siteId);
    if (!work) throw new DomainError('SETUP_REQUIRED', 503, 'Saved work is not connected yet.');
    const { work: current } = projectNativeAgentWork(session, input.rootTaskId, input.siteId, await work.read(session.actor, input.rootTaskId));
    if (current.evidenceUnavailable || current.result?.evidenceValidUntil && Date.parse(current.result.evidenceValidUntil) <= Date.now())
      throw new DomainError('EVIDENCE_STALE', 409, 'Refresh the saved result before reading it aloud.');
    const summary = current.result ? `${current.result.title}. ${current.result.summary}` : current.statusText;
    const text = `${current.title}. ${summary}`.slice(0, 1500);
    const audio = await within(JSON.stringify([scope.environment, scope.organizationId, session.actor.actorId]), () => gateway!.speak(text, c.req.raw.signal));
    // A long synthesis request does not keep an old read authorized indefinitely.
    const { work: latest } = projectNativeAgentWork(session, input.rootTaskId, input.siteId, await work.read(session.actor, input.rootTaskId));
    if (latest.evidenceUnavailable || latest.controlVersion !== current.controlVersion || latest.updatedAt !== current.updatedAt || JSON.stringify(latest.result) !== JSON.stringify(current.result) ||
      latest.result?.evidenceValidUntil && Date.parse(latest.result.evidenceValidUntil) <= Date.now())
      throw new DomainError('EVIDENCE_STALE', 409, 'This work changed. Refresh it before reading it aloud.');
    return c.body(new Uint8Array(audio).buffer, 200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store' });
  });
}
