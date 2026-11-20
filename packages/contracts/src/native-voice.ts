import { z } from 'zod';
import { IdSchema } from './core';
import { NativeWorkIntentScopeSchema } from './native-work-intent';

export const VOICE_MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const VOICE_MAX_REQUEST_BYTES = 3 * 1024 * 1024;
export const VoiceTranscribeCommandSchema = z.strictObject({
  siteId: IdSchema,
  mimeType: z.enum(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/wav', 'audio/mpeg']),
  audioBase64: z.string().min(4).max(Math.ceil(VOICE_MAX_AUDIO_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export const VoiceTranscriptResponseSchema = z.strictObject({ scope: NativeWorkIntentScopeSchema,
  transcript: z.string().trim().min(1).max(12000) });
export const VoiceSpeakCommandSchema = z.strictObject({ siteId: IdSchema, rootTaskId: IdSchema });
export const isNativeVoiceHttpRoute = (path: string, method: string): boolean =>
  /^\/v1\/voice\/(transcribe|speak)$/.test(path) && ['POST', 'OPTIONS'].includes(method);
export type VoiceTranscribeCommand = z.infer<typeof VoiceTranscribeCommandSchema>;
