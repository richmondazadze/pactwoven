import { createNativeTaskApp, createClerkIdentityObservationVerifier } from '@pactwoven/api/native-host';
import { PostgresFoundationRepository, type createRuntimePool } from '@pactwoven/db';
import { PostgresNativeGoogleStore } from '../../../packages/db/src/native-google-repository';
import { PostgresNativeGoogleAccessRepository } from '../../../packages/db/src/native-google-access-repository';
import { PostgresNativeGoogleDiscoveryRepository } from '../../../packages/db/src/native-google-discovery-repository';
import { PostgresNativeCommunicationRepository, PostgresNativeCommunicationReviewRepository } from '../../../packages/db/src/native-communication-repository';
import { NativeGoogleClerkSessionSource, NativeGoogleGateway } from '../../api/src/native-google-service';
import { NativeGoogleDiscoveryGateway } from '../../api/src/native-google-discovery-service';
import { NativeGoogleConnectionService } from '../../connectors/src/google/service';
import { FixedGoogleReadTransport } from '../../connectors/src/google/transport';
import { FixedGoogleDiscoveryEventTransport, NativeGoogleDiscoveryReader } from '../../connectors/src/google/discovery';
import { GoogleCredentialVault } from '../../connectors/src/google/vault';
import type { GoogleForegroundLane, readNativeGoogleConfig } from './google-config';
type Pool = Awaited<ReturnType<typeof createRuntimePool>>;

/** Called only after the host admits the exact SQL profiles. No background
 * communication worker, content writer, signer or model credential is present. */
export function composeNativeGoogleApp(config: ReturnType<typeof readNativeGoogleConfig>, pools: Record<GoogleForegroundLane | 'foundation', Pool>) {
  const environment = config.base.environment;
  const foundation = new PostgresFoundationRepository(pools.foundation, environment);
  const verify = createClerkIdentityObservationVerifier(config.base.identity);
  const access = new PostgresNativeGoogleAccessRepository({ observer: pools.observer, api: pools.api, review: pools.review }, environment);
  const sessions = new NativeGoogleClerkSessionSource(verify, foundation, access);
  const store = new PostgresNativeGoogleStore(pools.auth, undefined, environment);
  const vault = new GoogleCredentialVault(config.keyring), transport = new FixedGoogleReadTransport(config.oauth);
  const connections = new NativeGoogleConnectionService(config.oauth, sessions, store, vault, transport);
  const reviews = new PostgresNativeCommunicationReviewRepository(pools.review, environment, access);
  const communication = new PostgresNativeCommunicationRepository(pools.api, environment);
  const discoveryStore = new PostgresNativeGoogleDiscoveryRepository({ api: pools.api, reader: pools.reader }, environment);
  const reader = new NativeGoogleDiscoveryReader(config.oauth, discoveryStore, vault, transport, new FixedGoogleDiscoveryEventTransport());
  return createNativeTaskApp({ allowedOrigins: [config.oauth.publicWebOrigin], verifyObservedIdentity: verify, repository: foundation,
    nativeGoogleGateway: new NativeGoogleGateway(config.oauth.publicWebOrigin, sessions, connections, access, reviews, communication),
    nativeGoogleDiscoveryGateway: new NativeGoogleDiscoveryGateway(config.oauth.publicWebOrigin, sessions, discoveryStore, reader) });
}
