import { attachDatabasePool } from '@vercel/functions';
import { createNativeTaskApp, createClerkIdentityObservationVerifier } from '@pactwoven/api/native-host';
import { createRuntimePool, PostgresFoundationRepository, PostgresNativeMemoryNotesRepository,
  PostgresNativeRootRepository, PostgresNativeWorkIntentRepository, PostgresNativeAgentWorkListRepository, PostgresNativeDelegationRepository } from '@pactwoven/db';
import { createNativeWorkProtocolPool } from '../../../packages/db/src/native-work-protocol-pool';
import { PostgresNativeWorkConversationRepository } from '../../../packages/db/src/native-work-conversation-repository';
import { PostgresNativeWorkExecutionRepository } from '../../../packages/db/src/native-work-execution-repository';
import { PostgresNativeWorkActivityRepository } from '../../../packages/db/src/native-work-activity-repository';
import { createElevenLabsVoiceGateway } from '../../api/src/native-voice-service';
import { readNativeApiConfig, readNativeDelegatedApiConfig } from './config.js';
import { createClerkDelegatedProviderAuthorityObserver } from './delegated-provider-authority.js';
import type { NativeDelegatedAuthorityResources } from './delegated-authority.js';

type Resources = { app: ReturnType<typeof createNativeTaskApp>; authority: NativeDelegatedAuthorityResources;
  workIntent: PostgresNativeWorkIntentRepository };
type ManagedPool = Awaited<ReturnType<typeof createRuntimePool>>;
const failure = () => Error('Delegated service initialization failed.');
const remaining = (deadlineAt: number) => Number.isSafeInteger(deadlineAt) && deadlineAt > Date.now();
async function closePools(pools: ManagedPool[]) {
  if (!pools.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Start every shutdown even if another driver throws synchronously. Disposal
  // may finish later, but a failed initializer never reuses an owned pool.
  try { await Promise.race([Promise.allSettled(pools.map(async pool => { await pool.end(); })),
    new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
  finally { clearTimeout(timer); }
}
async function openPool(create: () => Promise<ManagedPool>, deadlineAt: number): Promise<ManagedPool> {
  if (!remaining(deadlineAt)) throw failure();
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = Promise.resolve().then(() => { if (!remaining(deadlineAt)) throw failure(); return create(); }).then(pool => {
      if (expired || !remaining(deadlineAt)) { void closePools([pool]); throw failure(); }
      return pool;
    });
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(failure()); }, Math.max(0, deadlineAt - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}
async function awaitResources(work: Promise<Resources>, deadlineAt: number): Promise<Resources> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resources = await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(failure()), Math.max(0, Math.min(15000, deadlineAt - Date.now())));
    })]);
    if (!remaining(deadlineAt)) throw failure();
    return resources;
  } finally { clearTimeout(timer); }
}
let initialized: Promise<Resources> | undefined;
// Shared work surfaces admit one complete known catalog profile. Conversation
// stays unavailable until the atomic instruction protocol migration is present.
export function nativeDelegatedResources(deadlineAt = Date.now() + 15000): Promise<Resources> {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt - Date.now() <= 1000) return Promise.reject(failure());
  if (initialized) return awaitResources(initialized, deadlineAt);
  // Leave room in the 15-second authority handler for current observation, and
  // reserve one second for cleanup when a caller supplies a shorter deadline.
  const initializeBy = Math.min(Date.now() + 10000, deadlineAt - 1000);
  initialized = (async () => {
    const base = readNativeApiConfig(process.env), config = readNativeDelegatedApiConfig(process.env);
    const opened: ManagedPool[] = [];
    try {
      const foundation = await openPool(() => createRuntimePool(base.foundationDatabaseUrl), initializeBy); opened.push(foundation);
      let instructions = false, activity = false, execution = false;
      const delegated = await openPool(async () => {
        const selected = await createNativeWorkProtocolPool(config.delegationDatabaseUrl, config.environment);
        instructions = selected.instructions;
        activity = selected.activity;
        execution = selected.execution;
        return selected.pool;
      }, initializeBy); opened.push(delegated);
      const workIntent = new PostgresNativeWorkIntentRepository(delegated, config.environment);
      // Optional speech configuration must not disable task controls, memory
      // or the authority observer when a provider setting is invalid.
      let nativeVoiceGateway;
      if (process.env.ELEVENLABS_API_KEY) {
        try {
          nativeVoiceGateway = createElevenLabsVoiceGateway({ apiKey: process.env.ELEVENLABS_API_KEY,
            voiceId: process.env.ELEVENLABS_VOICE_ID || 'CwhRBWXzGAHq8TQ4Fs17' });
        } catch { console.error('Voice configuration is unavailable; text work remains enabled.'); }
      }
      const app = createNativeTaskApp({ allowedOrigins: base.allowedOrigins,
        verifyObservedIdentity: createClerkIdentityObservationVerifier(config.identity),
        repository: new PostgresFoundationRepository(foundation, config.environment),
        nativeMemoryNotesRepository: new PostgresNativeMemoryNotesRepository(delegated, config.environment),
        nativeWorkIntentRepository: workIntent,
        nativeAgentWorkListRepository: new PostgresNativeAgentWorkListRepository(delegated, config.environment),
        nativeAgentWorkRepository: new PostgresNativeRootRepository(delegated, config.environment),
        ...(nativeVoiceGateway ? { nativeVoiceGateway } : {}),
        ...(execution ? { nativeWorkTeamActivityRepository: new PostgresNativeWorkExecutionRepository(delegated, config.environment) } : {}),
        ...(activity ? { nativeWorkActivityRepository: new PostgresNativeWorkActivityRepository(delegated, config.environment) } : {}),
        ...(instructions ? { nativeWorkConversationRepository: new PostgresNativeWorkConversationRepository(delegated, config.environment) } : {}) });
      const authority: NativeDelegatedAuthorityResources = { repository: new PostgresNativeDelegationRepository(delegated, config.environment),
        issuer: config.identity.issuer, observe: createClerkDelegatedProviderAuthorityObserver(config.identity) };
      if (!remaining(initializeBy)) throw failure();
      attachDatabasePool(foundation); attachDatabasePool(delegated);
      return { app, authority, workIntent };
    } catch { await closePools(opened); throw failure(); }
  })().catch(() => { initialized = undefined; throw failure(); });
  return awaitResources(initialized, deadlineAt);
}
export async function nativeWorkApp(deadlineAt?: number) { return (await nativeDelegatedResources(deadlineAt)).app; }
