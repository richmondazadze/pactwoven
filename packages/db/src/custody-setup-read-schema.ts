import {z} from 'zod';
import {CustodyInstantSchema,CustodyOwnerSchema,CustodyRefSchema,CustodyUuidSchema,CustodyRecordSchema,CustodyCommandSchema,CustodyResultSchema,
 CustodySetupSpecificationSchema,CustodyApiRecoveryQuerySchema,IdSchema,HashSchema} from '@pactwoven/contracts';
import {MandateIdentitySchema} from './mandate-schema.js';

/** Private sanitized authenticator output. Parsing it never authenticates a caller. */
export const CustodyReadObservationSchema=z.strictObject({identity:MandateIdentitySchema.extend({membershipObservedAt:CustodyInstantSchema,authenticatedAt:CustodyInstantSchema}),
 observation:z.strictObject({issuer:z.string().url().max(512),tokenHash:HashSchema,tokenIssuedAt:CustodyInstantSchema,observedAt:CustodyInstantSchema,expiresAt:CustodyInstantSchema})});
export const CustodyReadOwnerScopeSchema=z.strictObject({environment:z.literal('development'),organizationId:IdSchema,externalOrganizationId:IdSchema,responsibilityId:IdSchema,owner:CustodyOwnerSchema});
export const CustodyPrivateRecordQuerySchema=z.strictObject({setupId:CustodyUuidSchema,id:CustodyUuidSchema,kind:z.enum(['wallet_challenge','confirmation'])});
export const CustodyPrivateRecordSchema=z.strictObject({record:CustodyRecordSchema,reference:CustodyRefSchema});
export const CustodyOriginalOperationSchema=z.strictObject({command:CustodyCommandSchema,result:CustodyResultSchema});
export type CustodyReadObservation=z.infer<typeof CustodyReadObservationSchema>;
export type CustodyReadOwnerScope=z.infer<typeof CustodyReadOwnerScopeSchema>;
export type CustodyPrivateRecordQuery=z.infer<typeof CustodyPrivateRecordQuerySchema>;
export type CustodyPrivateRecord=z.infer<typeof CustodyPrivateRecordSchema>;
export type CustodyOriginalOperation=z.infer<typeof CustodyOriginalOperationSchema>;
export interface CustodySetupReaders {
 resolveOwner(observation:CustodyReadObservation,responsibilityId:string,trace:string):Promise<CustodyReadOwnerScope>;
 specification(identityEvidenceId:string,scope:CustodyReadOwnerScope,reference:z.infer<typeof CustodyRefSchema>,trace:string):Promise<z.infer<typeof CustodySetupSpecificationSchema>|null>;
 record(identityEvidenceId:string,scope:CustodyReadOwnerScope,query:CustodyPrivateRecordQuery,trace:string):Promise<CustodyPrivateRecord|null>;
 original(identityEvidenceId:string,scope:CustodyReadOwnerScope,query:z.infer<typeof CustodyApiRecoveryQuerySchema>,trace:string):Promise<CustodyOriginalOperation|null>;
}
