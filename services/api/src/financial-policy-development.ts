import { createFinancialAuthorityPool, PostgresFinancialPolicyRepository,
  PostgresFinancialAuthenticationRepository, PostgresFinancialPolicyReaders, PostgresFinancialPolicyPreparationReader } from '@pactwoven/db';
import type { ClerkIdentityConfig } from './auth.js';
import { createClerkFinancialPolicyVerifier } from './financial-policy-verifier.js';
import { createFinancialPolicyGateway } from './financial-policy-service.js';
import { createFinancialPolicyWriteGateway } from './financial-policy-write-service.js';
import { createFinancialPolicyPreparationGateway } from './financial-policy-preparation-service.js';

/** Construct only from the paired configuration validated by the development entrypoint. */
export async function createDevelopmentFinancialPolicy(configuration: {
  authorizerDatabaseUrl: string;
  verifierDatabaseUrl: string;
  identity: ClerkIdentityConfig;
}) {
  const authorizerUrl = configuration.authorizerDatabaseUrl, verifierUrl = configuration.verifierDatabaseUrl;
  const identity = { ...configuration.identity, authorizedParties: [...configuration.identity.authorizedParties] };
  let authorizer: Awaited<ReturnType<typeof createFinancialAuthorityPool>> | undefined;
  let verifier: Awaited<ReturnType<typeof createFinancialAuthorityPool>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.allSettled([
    Promise.resolve().then(() => authorizer?.end()),
    Promise.resolve().then(() => verifier?.end()),
  ]).then(() => {});
  try {
    authorizer = await createFinancialAuthorityPool(authorizerUrl, 'authorizer');
    verifier = await createFinancialAuthorityPool(verifierUrl, 'verifier');
    const dependencies = {
      environment: 'development' as const, issuer: identity.issuer,
      verifier: createClerkFinancialPolicyVerifier(identity, 'development'),
      readers: new PostgresFinancialPolicyReaders(authorizer, verifier),
      repository: new PostgresFinancialPolicyRepository(authorizer),
      authentication: new PostgresFinancialAuthenticationRepository(verifier),
    };
    const gateway = createFinancialPolicyGateway(dependencies);
    const writeGateway = createFinancialPolicyWriteGateway(dependencies);
    const preparationGateway = createFinancialPolicyPreparationGateway({ environment: dependencies.environment, issuer: dependencies.issuer,
      verifier: dependencies.verifier, readers: dependencies.readers, authentication: dependencies.authentication,
      preparationReader: new PostgresFinancialPolicyPreparationReader(authorizer) });
    return { gateway, writeGateway, preparationGateway, close };
  } catch {
    await close();
    throw new Error('Financial policy development setup failed. Check the protected paired database and identity configuration.');
  }
}
