import { z } from 'zod';
import { EnvironmentSchema, IdSchema, InstantSchema, ResponsibilitySchema } from './core';
import { VersionReferenceSchema } from './financial';
import { MandateResponsibilityReferenceSchema, PolicyDocumentVersionSchema } from './mandates';
import { MandateOperationResultSchema } from './mandate-http';

const version = z.number().int().positive().max(2_147_483_647);
const epoch = z.number().int().nonnegative().max(2_147_483_647);
const queryInteger = z.union([z.number().int(), z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number)]);
export const MandateDocumentQuerySchema = z.strictObject({ version: queryInteger.pipe(version) });
export type MandateDocumentQuery = z.infer<typeof MandateDocumentQuerySchema>;

/** Exact historical content and its safe save receipt; current preparation comes from the collection. */
export const MandateDocumentReadSchema = z.strictObject({
  schemaVersion: z.literal(1), environment: EnvironmentSchema, organizationId: IdSchema, responsibilityId: IdSchema,
  observedAt: InstantSchema,
  document: PolicyDocumentVersionSchema.safeExtend({ version, previousVersion: VersionReferenceSchema.safeExtend({ version }).nullable() }),
  savedAgainst: z.strictObject({ responsibility: MandateResponsibilityReferenceSchema.safeExtend({ version }), organizationEpoch: epoch }),
  savedResponsibility: ResponsibilitySchema.safeExtend({ version }),
  saveOperation: MandateOperationResultSchema,
}).refine(value => {
  const { document, savedAgainst, savedResponsibility: saved, saveOperation: receipt } = value;
  const reference = savedAgainst.responsibility, operation = receipt.operation;
  return document.organizationId === value.organizationId && document.environment === value.environment &&
    saved.organizationId === value.organizationId && saved.environment === value.environment &&
    saved.id === value.responsibilityId && reference.id === saved.id && reference.version === saved.version && reference.siteId === saved.siteId &&
    receipt.organizationId === value.organizationId && receipt.responsibilityId === value.responsibilityId && operation.environment === value.environment &&
    receipt.kind === 'mandate.document.create' && receipt.target.kind === 'document' && receipt.target.id === document.id &&
    receipt.target.version === document.version && receipt.target.hash === document.hash && operation.status === 'succeeded' &&
    operation.financialState === null && operation.error === null && operation.nextCheckAt === null && operation.evidenceRefs.length === 0 && receipt.intentHash === null &&
    receipt.observedAt === document.createdAt && Date.parse(document.createdAt) <= Date.parse(value.observedAt) &&
    Date.parse(saved.createdAt) <= Date.parse(saved.updatedAt) && Date.parse(saved.updatedAt) <= Date.parse(document.createdAt) &&
    document.text === document.text.normalize('NFC').replace(/\r\n?/g, '\n') &&
    (document.version === 1 ? document.previousVersion === null : document.previousVersion !== null &&
      document.previousVersion.id === document.id && document.previousVersion.version === document.version - 1);
}, 'Exact document, saved responsibility and successful original save receipt must agree');
export type MandateDocumentRead = z.infer<typeof MandateDocumentReadSchema>;
