import { z } from 'zod';
import { CustodyOwnerSchema,CustodyUuidSchema,CustodyInstantSchema,CustodyRefSchema,CustodySignatureSchema,CustodyNonceSchema,HashSchema,IdSchema,IdempotencyKeySchema } from '@pactwoven/contracts';
const common={schemaVersion:z.literal(1),id:CustodyUuidSchema,environment:z.literal('development'),organizationId:IdSchema,owner:CustodyOwnerSchema,
  observedAt:CustodyInstantSchema,expiresAt:CustodyInstantSchema};
const identity={externalOrganizationId:IdSchema,externalRole:z.string().min(1).max(128),issuer:z.string().url().max(512),tokenHash:HashSchema,tokenIssuedAt:CustodyInstantSchema};
export const CustodyIdentityEvidenceSchema=z.strictObject({...common,...identity,kind:z.literal('identity'),purpose:z.literal('custody_setup_observation')});
export const CustodyWalletEvidenceSchema=z.strictObject({...common,kind:z.literal('wallet'),purpose:z.literal('custody_setup_wallet'),setupId:CustodyUuidSchema,
  challenge:CustodyRefSchema,signature:CustodySignatureSchema,signatureHash:HashSchema});
export const CustodyMfaEvidenceSchema=z.strictObject({...common,...identity,kind:z.literal('mfa'),purpose:z.literal('custody_setup_owner_binding'),
  confirmationId:CustodyUuidSchema,intentHash:HashSchema,requestHash:HashSchema,nonce:CustodyNonceSchema,key:IdempotencyKeySchema,
  firstFactorAgeMinutes:z.number().int().min(0).max(1000000),secondFactorAgeMinutes:z.number().int().min(0).max(1000000),verifiedAt:CustodyInstantSchema});
/** Private verifier seam only; parsing does not prove Clerk identity or wallet possession. */
export const CustodyAuthEvidenceSchema=z.discriminatedUnion('kind',[CustodyIdentityEvidenceSchema,CustodyWalletEvidenceSchema,CustodyMfaEvidenceSchema]);
export type CustodyAuthEvidence=z.infer<typeof CustodyAuthEvidenceSchema>;
