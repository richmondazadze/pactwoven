import { createCustodySetupPool, PostgresCustodySetupRepository,
  PostgresCustodySetupAuthenticationRepository, PostgresCustodySetupReaders } from '@pactwoven/db';
import type { ClerkIdentityConfig } from './auth.js';
import { createClerkCustodySetupVerifier } from './custody-setup-verifier.js';
import { createCustodySetupService } from './custody-setup-service.js';

/** Called only with the paired development configuration accepted at startup. */
export async function createDevelopmentCustodySetup(configuration: {
  writerDatabaseUrl: string;
  verifierDatabaseUrl: string;
  identity: ClerkIdentityConfig;
}) {
  // Capture both connections and identity configuration before pool creation awaits.
  const writerUrl = configuration.writerDatabaseUrl, verifierUrl = configuration.verifierDatabaseUrl;
  const identity = { ...configuration.identity, authorizedParties: [...configuration.identity.authorizedParties] };
  let writer: Awaited<ReturnType<typeof createCustodySetupPool>> | undefined;
  let verifier: Awaited<ReturnType<typeof createCustodySetupPool>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.allSettled([writer?.end(), verifier?.end()]).then(() => {});
  try {
    writer = await createCustodySetupPool(writerUrl, 'writer');
    verifier = await createCustodySetupPool(verifierUrl, 'verifier');
    const gateway = createCustodySetupService({
      verifier: createClerkCustodySetupVerifier(identity),
      repository: new PostgresCustodySetupRepository(writer),
      authentication: new PostgresCustodySetupAuthenticationRepository(verifier),
      readers: new PostgresCustodySetupReaders(writer, verifier),
    });
    return { gateway, close };
  } catch {
    await close();
    throw new Error('Custody development setup failed. Check the protected paired database and identity configuration.');
  }
}
