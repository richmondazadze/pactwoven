import { DomainError } from '@pactwoven/domain';
import { VOICE_MAX_AUDIO_BYTES, type VoiceTranscribeCommand } from '../../../packages/contracts/src/native-voice';

export interface NativeVoiceGateway {
  transcribe(input: VoiceTranscribeCommand, signal: AbortSignal): Promise<string>;
  speak(text: string, signal: AbortSignal): Promise<Uint8Array>;
}
const unavailable = () => new DomainError('VOICE_UNAVAILABLE', 503, 'Voice is temporarily unavailable. You can continue by typing.');
async function bounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength; if (length > maximum) throw unavailable(); chunks.push(chunk.value); }
    const output = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  } catch { await reader.cancel().catch(() => {}); throw unavailable(); }
  finally { reader.releaseLock(); }
}
export function voiceAudioBytes(input: VoiceTranscribeCommand): Uint8Array {
  const bytes = Buffer.from(input.audioBase64, 'base64'), mime = input.mimeType.split(';')[0];
  if (bytes.length < 16 || bytes.length > VOICE_MAX_AUDIO_BYTES || bytes.toString('base64') !== input.audioBase64) {
    throw new DomainError('VALIDATION_FAILED', 422, 'Record a short audio message and try again.');
  }
  const prefix = bytes.subarray(0, 12).toString('ascii');
  const matches = mime === 'audio/webm' ? bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) :
    mime === 'audio/ogg' ? prefix.startsWith('OggS') : mime === 'audio/mp4' ? prefix.slice(4, 8) === 'ftyp' :
    mime === 'audio/wav' ? prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WAVE' :
    mime === 'audio/mpeg' && (prefix.startsWith('ID3') || bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  if (!matches) throw new DomainError('VALIDATION_FAILED', 422, 'The recording format could not be read. Try recording again.');
  return bytes;
}

/** Server-only ElevenLabs adapter: fixed origin, no source URLs, webhooks,
 * voice cloning, transcript instruction rewriting or retained audio files. */
export function createElevenLabsVoiceGateway(options: { apiKey: string; voiceId: string; fetch?: typeof fetch }): NativeVoiceGateway {
  if (!options.apiKey || /\s/.test(options.apiKey) || !/^[A-Za-z0-9_-]{1,128}$/.test(options.voiceId)) throw unavailable();
  const transport = options.fetch ?? fetch;
  async function call(path: string, init: RequestInit, signal: AbortSignal) {
    try { return await transport('https://api.elevenlabs.io' + path, { ...init, redirect: 'error',
      headers: { ...init.headers, 'xi-api-key': options.apiKey }, signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) }); }
    catch { throw unavailable(); }
  }
  return {
    async transcribe(input, signal) {
      const bytes = voiceAudioBytes(input), form = new FormData();
      form.set('model_id', 'scribe_v2'); form.set('tag_audio_events', 'false'); form.set('diarize', 'false');
      form.set('file', new Blob([new Uint8Array(bytes)], { type: input.mimeType.split(';')[0]! }), 'recording');
      const raw = await bounded(await call('/v1/speech-to-text', { method: 'POST', body: form }, signal), 512 * 1024);
      try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (typeof value.text !== 'string' || !value.text.trim() || value.text.trim().length > 12000) throw unavailable();
        return value.text.trim();
      } catch { throw unavailable(); }
    },
    async speak(text, signal) {
      if (!text.trim() || text.length > 1600) throw new DomainError('VALIDATION_FAILED', 422, 'This result is not ready to read aloud.');
      const response = await call('/v1/text-to-speech/' + options.voiceId + '?output_format=mp3_44100_128', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
      }, signal);
      if (!/^audio\/mpeg(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw unavailable(); }
      const bytes = await bounded(response, 2 * 1024 * 1024);
      // A content-type alone does not establish playable audio. Apply the
      // same bounded container admission as recordings before returning it.
      try { voiceAudioBytes({ siteId: 'voice-output', mimeType: 'audio/mpeg', audioBase64: Buffer.from(bytes).toString('base64') }); }
      catch { throw unavailable(); }
      return bytes;
    },
  };
}
