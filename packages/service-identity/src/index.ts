import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

export const VercelWorkloadIdentitySchema = z.strictObject({
  team: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  teamId: z.string().regex(/^team_[A-Za-z0-9]{1,128}$/),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  projectId: z.string().regex(/^prj_[A-Za-z0-9]{1,128}$/),
});
export type VercelWorkloadIdentity = z.infer<typeof VercelWorkloadIdentitySchema>;

/** A verified project identity is transport authentication only. Each receiver
 * must enforce its own operation scope, replay rules and durable authority. */
export function createVercelWorkloadVerifier(identity: VercelWorkloadIdentity, getKey?: JWTVerifyGetKey) {
  const expected = VercelWorkloadIdentitySchema.parse(identity);
  const issuer = `https://oidc.vercel.com/${expected.team}`;
  const keys = getKey ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`), {
    timeoutDuration: 3_000, cooldownDuration: 30_000, cacheMaxAge: 300_000,
  });
  return async (request: Request): Promise<boolean> => {
    const header = request.headers.get('authorization');
    if (!header || header.length > 8192 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)) return false;
    try {
      const { payload } = await jwtVerify(header.slice(7), keys, {
        issuer, audience: `https://vercel.com/${expected.team}`,
        subject: `owner:${expected.team}:project:${expected.project}:environment:production`,
        algorithms: ['RS256'], typ: 'JWT', clockTolerance: 5,
        requiredClaims: ['iat', 'nbf', 'exp', 'owner', 'owner_id', 'project', 'project_id', 'environment'],
        maxTokenAge: 7200,
      });
      return payload.owner === expected.team && payload.owner_id === expected.teamId &&
        payload.project === expected.project && payload.project_id === expected.projectId && payload.environment === 'production' &&
        typeof payload.iat === 'number' && typeof payload.exp === 'number' && typeof payload.nbf === 'number' &&
        payload.exp > payload.iat && payload.exp - payload.iat <= 7200 && payload.nbf >= payload.iat;
    } catch { return false; }
  };
}

