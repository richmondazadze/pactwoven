import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema } from './core';
import { HashSchema } from './financial';
import { FINANCE_DEVNET_ASSET, SolanaPublicKeySchema } from './finance-provenance';
import { FinancialAuthorityFenceSchema, FinancialFenceGenerationSchema, FinancialFenceVersionSchema } from './financial-fences';

export const CustodyVersionSchema = FinancialFenceVersionSchema;
export const CustodyGenerationSchema = FinancialFenceGenerationSchema;
export const CustodyUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).refine(v => v !== '00000000-0000-0000-0000-000000000000');
export const CustodyInstantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
export const CustodyAmountSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n);
export const CustodyWalletSchema = SolanaPublicKeySchema.refine(v => v !== '11111111111111111111111111111111');
export const CustodyNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const CustodySignatureSchema = z.string().regex(/^[A-Za-z0-9+/]{85}[AQgw]==$/);
export const CustodyRefSchema = z.strictObject({ id: IdSchema, version: CustodyVersionSchema, recordHash: HashSchema });
export const CustodyOwnerSchema = z.strictObject({ actorId: IdSchema, membershipVersion: CustodyVersionSchema,
  subject: IdSchema, externalMembershipId: IdSchema, sessionId: z.string().min(1).max(256) });
export const CustodyExpectedScopeSchema = z.strictObject({ responsibilityVersion: CustodyVersionSchema, responsibilityHash: HashSchema,
  siteGeneration: CustodyGenerationSchema, siteRecordHash: HashSchema, canonicalGeneration: CustodyGenerationSchema, canonicalHash: HashSchema });
/** A private root-reviewed candidate, never client evidence of qualification. */
export const CustodySetupSpecificationSchema = z.strictObject({
  schemaVersion: z.literal(1), purpose: z.literal('INITIALIZE_EMPTY_CUSTODY'), environment: z.literal('development'),
  id: IdSchema, version: CustodyVersionSchema, predecessor: CustodyRefSchema.nullable(),
  organization: z.strictObject({ id: IdSchema, registrationUuid: CustodyUuidSchema, authorityEpoch: CustodyGenerationSchema }),
  responsibility: z.strictObject({ id: IdSchema, registrationUuid: CustodyUuidSchema, version: CustodyVersionSchema, hash: HashSchema, siteId: IdSchema }),
  site: z.strictObject({ id: IdSchema, generation: CustodyGenerationSchema, recordHash: HashSchema, active: z.literal(true) }),
  authority: z.strictObject({ snapshot: FinancialAuthorityFenceSchema, recordHash: HashSchema }), owner: CustodyOwnerSchema,
  ownerWalletPublicKey: CustodyWalletSchema,
  program: z.strictObject({ id: CustodyWalletSchema, loader: z.literal('BPFLoaderUpgradeab1e11111111111111111111111'), programData: CustodyWalletSchema,
    deploymentSlot: CustodyAmountSchema, sourceHash: HashSchema, binaryHash: HashSchema, idlHash: HashSchema, clientHash: HashSchema, buildManifestHash: HashSchema, upgradePolicy: CustodyRefSchema }),
  config: z.strictObject({ address: CustodyWalletSchema, recordHash: HashSchema, setupIntentHash: HashSchema, observation: CustodyRefSchema }),
  asset: z.strictObject({ genesis: z.literal(FINANCE_DEVNET_ASSET.genesis), tokenProgram: z.literal(FINANCE_DEVNET_ASSET.tokenProgram), mint: z.literal(FINANCE_DEVNET_ASSET.mint),
    decimals: z.literal(6), key: z.literal('34ee730cf90d3d55ea2d34e911aa4ad941aafb29668bf4056cfa88c6cf0492e4'),
    registryVersion: CustodyVersionSchema, registryRecordHash: HashSchema, controlGeneration: CustodyGenerationSchema, controlHash: HashSchema }),
  registrationAddress: CustodyWalletSchema, vaultAddress: CustodyWalletSchema, registrar: CustodyWalletSchema, rentPayer: CustodyWalletSchema, setupOperationKey: HashSchema,
  transactionPolicy: z.strictObject({ reference: CustodyRefSchema, instructionPlanHash: HashSchema, maximumFeeLamports: CustodyAmountSchema,
    maximumRentLamports: CustodyAmountSchema, maximumFaucetLamports: CustodyAmountSchema, maximumTotalLamports: CustodyAmountSchema }),
  issuedAt: CustodyInstantSchema, expiresAt: CustodyInstantSchema,
}).superRefine((v,c) => {
  if (![v.transactionPolicy.maximumFeeLamports,v.transactionPolicy.maximumRentLamports,v.transactionPolicy.maximumFaucetLamports,v.transactionPolicy.maximumTotalLamports].every(a=>CustodyAmountSchema.safeParse(a).success)) return;
  if ((v.version === 1) !== (v.predecessor === null) || (v.predecessor && (v.predecessor.id !== v.id || v.predecessor.version + 1 !== v.version)) ||
    v.ownerWalletPublicKey === v.registrar || v.site.id !== v.responsibility.siteId || v.authority.snapshot.environment !== v.environment ||
    v.authority.snapshot.organizationId !== v.organization.id || v.authority.snapshot.responsibility.id !== v.responsibility.id ||
    v.authority.snapshot.responsibility.version !== v.responsibility.version || v.authority.snapshot.responsibility.hash !== v.responsibility.hash ||
    v.authority.snapshot.responsibility.siteId !== v.site.id || Date.parse(v.expiresAt) <= Date.parse(v.issuedAt) ||
    BigInt(v.transactionPolicy.maximumFeeLamports) === 0n || BigInt(v.transactionPolicy.maximumRentLamports) === 0n ||
    BigInt(v.transactionPolicy.maximumTotalLamports) < BigInt(v.transactionPolicy.maximumFeeLamports) + BigInt(v.transactionPolicy.maximumRentLamports))
    c.addIssue({code:'custom',message:'Exact scope, predecessor, distinct owner and bounded setup terms required.'});
});
const common = { schemaVersion:z.literal(1), id:CustodyUuidSchema, setupId:CustodyUuidSchema, version:CustodyVersionSchema,
  environment:z.literal('development'), organizationId:IdSchema, responsibilityId:IdSchema, actorId:IdSchema, issuedAt:CustodyInstantSchema, expiresAt:CustodyInstantSchema };
export const CustodyDraftSchema = z.strictObject({ ...common, kind:z.literal('draft'), specification:CustodyRefSchema, specificationControlGeneration:CustodyGenerationSchema,
  predecessor:CustodyRefSchema.nullable(), prepareOperationId:CustodyUuidSchema });
export const CustodyWalletChallengeSchema = z.strictObject({ ...common, kind:z.literal('wallet_challenge'), specification:CustodyRefSchema,
  draft:CustodyRefSchema, owner:CustodyOwnerSchema, wallet:CustodyWalletSchema, organizationRegistrationUuid:CustodyUuidSchema,
  responsibilityRegistrationUuid:CustodyUuidSchema, setupOperationKey:HashSchema, nonce:CustodyNonceSchema });
export const CustodyConfirmationIntentSchema = z.strictObject({ schemaVersion:z.literal(1), purpose:z.literal('custody_setup_owner_binding'),
  environment:z.literal('development'), organizationId:IdSchema, responsibilityId:IdSchema, setupId:CustodyUuidSchema,
  specification:CustodyRefSchema, challenge:CustodyRefSchema, signatureHash:HashSchema, owner:CustodyOwnerSchema, key:IdempotencyKeySchema, nonce:CustodyNonceSchema });
export const CustodyConfirmationSchema = z.strictObject({ ...common, kind:z.literal('confirmation'), draft:CustodyRefSchema,
  walletEvidence:CustodyRefSchema, intent:CustodyConfirmationIntentSchema, intentHash:HashSchema, requestHash:HashSchema });
export const CustodyOperationRefSchema = z.strictObject({id:CustodyUuidSchema,key:IdempotencyKeySchema,commandHash:HashSchema});
export const CustodyOwnerBindingSchema = z.strictObject({ ...common, kind:z.literal('owner_binding'), purpose:z.literal('INITIALIZE_EMPTY_CUSTODY'),
  specification:CustodySetupSpecificationSchema, specificationRef:CustodyRefSchema, specificationControlGeneration:CustodyGenerationSchema, draft:CustodyRefSchema, challenge:CustodyRefSchema,
  confirmation:CustodyRefSchema, identityEvidence:CustodyRefSchema, walletEvidence:CustodyRefSchema, mfaEvidence:CustodyRefSchema,
  signatureHash:HashSchema, prepareOperation:CustodyOperationRefSchema, confirmOperation:CustodyOperationRefSchema, controlGeneration:CustodyGenerationSchema });
export const CustodyCancellationSchema = z.strictObject({ ...common, kind:z.literal('cancellation'), draft:CustodyRefSchema,
  previousControlGeneration:CustodyGenerationSchema, controlGeneration:CustodyGenerationSchema });
export const CustodyRecordSchema = z.discriminatedUnion('kind',[CustodyDraftSchema,CustodyWalletChallengeSchema,CustodyConfirmationSchema,CustodyOwnerBindingSchema,CustodyCancellationSchema]);
const command = { schemaVersion:z.literal(1), key:IdempotencyKeySchema, responsibilityId:IdSchema };
const expected = { setupId:CustodyUuidSchema, expectedSetupVersion:CustodyVersionSchema, expectedSetupHash:HashSchema };
export const CustodyPrepareCommandSchema = z.strictObject({ ...command, kind:z.literal('prepare'), reviewedSpecificationRef:CustodyRefSchema,
  ownerWalletPublicKey:CustodyWalletSchema, expectedScope:CustodyExpectedScopeSchema, previousDraft:CustodyRefSchema.nullable() });
export const CustodyChallengeCommandSchema = z.strictObject({ ...command,...expected,kind:z.literal('challenge') });
export const CustodyConfirmationCommandSchema = z.strictObject({ ...command,...expected,kind:z.literal('confirmation'),
  confirmationKey:IdempotencyKeySchema, challengeId:CustodyUuidSchema, challengeHash:HashSchema, walletEvidenceId:CustodyUuidSchema });
export const CustodyConfirmCommandSchema = z.strictObject({ ...command,...expected,kind:z.literal('confirm'),
  confirmationId:CustodyUuidSchema, confirmationNonce:CustodyNonceSchema, mfaEvidenceId:CustodyUuidSchema });
export const CustodyCancelCommandSchema = z.strictObject({ ...command,...expected,kind:z.literal('cancel'),expectedSetupControlGeneration:CustodyGenerationSchema });
export const CustodyCommandSchema = z.discriminatedUnion('kind',[CustodyPrepareCommandSchema,CustodyChallengeCommandSchema,CustodyConfirmationCommandSchema,CustodyConfirmCommandSchema,CustodyCancelCommandSchema]);
export const CustodyResultSchema = z.strictObject({schemaVersion:z.literal(1),id:CustodyUuidSchema,organizationId:IdSchema,actorId:IdSchema,
  responsibilityId:IdSchema,kind:z.enum(['prepare','challenge','confirmation','confirm','cancel']),key:IdempotencyKeySchema,commandHash:HashSchema,
  setupId:CustodyUuidSchema,target:CustodyRefSchema,body:CustodyRecordSchema,financialState:z.null()});
export const CustodyReadSchema = z.strictObject({schemaVersion:z.literal(1),setupId:CustodyUuidSchema,draft:CustodyDraftSchema,
  draftHash:HashSchema,controlGeneration:CustodyGenerationSchema,state:z.enum(['pending','confirmed','cancelled','expired']),binding:CustodyOwnerBindingSchema.nullable()});
export const CustodyLookupSchema = z.strictObject({responsibilityId:IdSchema,kind:z.enum(['prepare','challenge','confirmation','confirm','cancel']),key:IdempotencyKeySchema,commandHash:HashSchema});
export type CustodySetupSpecification = z.infer<typeof CustodySetupSpecificationSchema>;
export type CustodyOwnerBinding = z.infer<typeof CustodyOwnerBindingSchema>;
export type CustodyWalletChallenge = z.infer<typeof CustodyWalletChallengeSchema>;
export type CustodyCommand = z.infer<typeof CustodyCommandSchema>;
export type CustodyResult = z.infer<typeof CustodyResultSchema>;
export type CustodyRecord = z.infer<typeof CustodyRecordSchema>;
export type CustodyLookup = z.infer<typeof CustodyLookupSchema>;
export type CustodyRead = z.infer<typeof CustodyReadSchema>;
