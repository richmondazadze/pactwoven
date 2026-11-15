import { z } from 'zod';
import { CustodyPrepareCommandSchema, CustodyChallengeCommandSchema, CustodyCancelCommandSchema, CustodySignatureSchema,
  CustodyNonceSchema, CustodyUuidSchema } from './custody-setup';
import { HashSchema } from './financial';
import { IdempotencyKeySchema } from './core';
// No identity, evidence identifiers, verified flags or arbitrary transaction bytes are public inputs.
export const CustodyPrepareHttpSchema = CustodyPrepareCommandSchema.omit({kind:true,responsibilityId:true});
export const CustodyChallengeHttpSchema = CustodyChallengeCommandSchema.omit({kind:true,responsibilityId:true,setupId:true});
export const CustodyConfirmationHttpSchema = CustodyChallengeHttpSchema.extend({confirmationKey:IdempotencyKeySchema,
  challengeId:CustodyUuidSchema,challengeHash:HashSchema,walletSignature:CustodySignatureSchema});
export const CustodyConfirmHttpSchema = CustodyChallengeHttpSchema.extend({challengeId:CustodyUuidSchema,challengeHash:HashSchema,
  walletSignature:CustodySignatureSchema,confirmationId:CustodyUuidSchema,confirmationNonce:CustodyNonceSchema});
export const CustodyCancelHttpSchema = CustodyCancelCommandSchema.omit({kind:true,responsibilityId:true,setupId:true});
export const custodyHttpBodyLimits = Object.freeze({prepare:8192,challenge:2048,confirmation:4096,confirm:4096,cancel:2048});
export const CustodyHttpErrorSchema = z.enum(['CUSTODY_INPUT_INVALID','CUSTODY_ACCESS_DENIED','CUSTODY_SCOPE_CHANGED',
  'CUSTODY_EXPIRED','CUSTODY_KEY_CONFLICT','CUSTODY_OUTCOME_UNKNOWN','UNSAFE_DATABASE_ROLE']);
