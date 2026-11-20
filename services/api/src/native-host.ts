import { createApp, type AppDependencies } from './app.js';

/** Native hosting exposes no organization, financial, supplier or access commands. */
export function createNativeTaskApp(dependencies: Pick<AppDependencies,
  'allowedOrigins' | 'repository' | 'verifyIdentity' | 'verifyObservedIdentity' | 'nativeTaskRepository' | 'nativeTaskProvenance' | 'nativeMemoryNotesRepository' | 'nativeWorkIntentRepository' | 'nativePaidWorkIntentRepository' | 'nativePaidWorkPolicy' | 'nativePaidWorkOrganizationId' | 'nativePaidQuoteGateway' | 'nativePaidToolHumanRepository' | 'nativeAgentWorkRepository' | 'nativeWorkActivityRepository' | 'nativeVoiceGateway' | 'nativeAgentWorkListRepository' | 'nativeWorkConversationRepository' | 'nativeGoogleGateway' | 'nativeGoogleDiscoveryGateway'>) {
  return createApp(dependencies, { surface: 'native' });
}

export { createClerkIdentityVerifier, createClerkIdentityObservationVerifier } from './auth.js';
