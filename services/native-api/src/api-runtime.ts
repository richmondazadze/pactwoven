import { attachDatabasePool } from '@vercel/functions';
import { createNativeTaskApp, createClerkIdentityVerifier } from '@pactwoven/api/native-host';
import { createRuntimePool, createNativeTaskPool, PostgresFoundationRepository, PostgresNativeTaskRepository, PostgresNativeAuthorityRepository } from '@pactwoven/db';
import { readNativeApiConfig } from './config.js';
import { createClerkProviderAuthorityObserver } from './provider-authority.js';
import type { NativeAuthorityResources } from './authority.js';
import { nativeDelegatedResources } from './delegated-runtime.js';

type Resources = { app: ReturnType<typeof createNativeTaskApp>; authority: NativeAuthorityResources };
let initialized: Promise<Resources> | undefined;
function nativeApiResources() {
  if (initialized) return initialized;
  initialized = (async () => {
    const config = readNativeApiConfig(process.env);
    const foundation = await createRuntimePool(config.foundationDatabaseUrl);
    let native: Awaited<ReturnType<typeof createNativeTaskPool>> | undefined;
    try {
      native = await createNativeTaskPool(config.nativeDatabaseUrl, config.environment, 'api');
      attachDatabasePool(foundation); attachDatabasePool(native);
      const app = createNativeTaskApp({ allowedOrigins: config.allowedOrigins,
        verifyIdentity: createClerkIdentityVerifier(config.identity),
        repository: new PostgresFoundationRepository(foundation, config.environment),
        nativeTaskRepository: new PostgresNativeTaskRepository(native, config.environment),
        nativeTaskProvenance: { provenance: async (actor, siteId, ids) =>
          (await nativeDelegatedResources()).workIntent.provenance(actor, siteId, ids) } });
      return { app, authority: { repository: new PostgresNativeAuthorityRepository(native, config.environment),
        issuer: config.identity.issuer, observe: createClerkProviderAuthorityObserver(config.identity) } };
    } catch (error) { await Promise.allSettled([foundation.end(), native?.end()]); throw error; }
  })().catch(() => { initialized = undefined; throw Error('Native API initialization failed.'); });
  return initialized;
}
export async function nativeApiApp() { return (await nativeApiResources()).app; }
export async function nativeAuthorityResources() { return (await nativeApiResources()).authority; }
