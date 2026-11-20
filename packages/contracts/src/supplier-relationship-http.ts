import { z } from 'zod';
import { IdSchema, InstantSchema } from './core';
import { HashSchema } from './financial';
import { SupplierScopeSchema, supplierScopesMatch } from './supplier-protocol';
import {
  SupplierRelationshipCommandSchema, SupplierRelationshipMutationSchema, SupplierRelationshipReceiptSchema,
  SupplierRelationshipHeadSchema, SupplierRelationshipProjectionSchema,
} from './supplier-relationships';
import {
  SUPPLIER_SCOPE_POLICY_MAX_VALIDITY_MS, SupplierScopePolicyCommandSchema, SupplierScopePolicyMutationSchema,
  SupplierScopePolicyReferenceSchema, SupplierScopePolicyCommandIdentitySchema, SupplierScopeCategorySchema,
  supplierScopePolicyPairsMatch,
} from './supplier-scope-policy';

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const SupplierRelationshipHttpKindSchema = z.enum([
  'relationship-status', 'relationship-command', 'relationship-recover', 'policy-read', 'policy-command',
]);
export type SupplierRelationshipHttpKind = z.infer<typeof SupplierRelationshipHttpKindSchema>;
export const supplierRelationshipHttpRoutes = Object.freeze({
  'relationship-status': '/v1/supplier-relationships/status',
  'relationship-command': '/v1/supplier-relationships/commands',
  'relationship-recover': '/v1/supplier-relationships/recover',
  'policy-read': '/v1/supplier-scope-policies/read',
  'policy-command': '/v1/supplier-scope-policies/commands',
} satisfies Record<SupplierRelationshipHttpKind, string>);
export const supplierRelationshipHttpBodyLimits = Object.freeze({
  'relationship-status': 8 * 1024, 'relationship-command': 64 * 1024, 'relationship-recover': 8 * 1024,
  'policy-read': 8 * 1024, 'policy-command': 1024 * 1024,
} satisfies Record<SupplierRelationshipHttpKind, number>);

// Routes choose kind and attach the key header. Bodies cannot supply current
// identity, private purpose, binding, evidence, approvers or recorded handles.
export const SupplierRelationshipStatusHttpSchema = z.strictObject({ scope: SupplierScopeSchema, revision: version.nullable() });
export const SupplierRelationshipCommandHttpSchema = SupplierRelationshipCommandSchema;
export const SupplierScopePolicyCommandHttpSchema = SupplierScopePolicyCommandSchema;
export const SupplierScopePolicyReadHttpSchema = z.strictObject({ policy: SupplierScopePolicyReferenceSchema });
/** Historical locator only. The service independently requires the current actor to match it. */
export const SupplierRelationshipRecoveryHttpSchema = z.strictObject({
  identity: SupplierRelationshipReceiptSchema.shape.identity, commandDigest: HashSchema,
  action: z.enum(['create', 'revise', 'approve', 'suspend', 'revoke']),
});
export const SupplierRelationshipHttpRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('relationship-status'), query: SupplierRelationshipStatusHttpSchema }),
  z.strictObject({ kind: z.literal('relationship-command'), mutation: SupplierRelationshipMutationSchema }),
  z.strictObject({ kind: z.literal('relationship-recover'), query: SupplierRelationshipRecoveryHttpSchema }),
  z.strictObject({ kind: z.literal('policy-read'), query: SupplierScopePolicyReadHttpSchema }),
  z.strictObject({ kind: z.literal('policy-command'), mutation: SupplierScopePolicyMutationSchema }),
]);
export type SupplierRelationshipHttpRequest = z.infer<typeof SupplierRelationshipHttpRequestSchema>;

/** Exact policy material for the authorized buyer. No issuer/provider/staff/session or private evidence fields. */
export const SupplierScopePolicyHttpProjectionSchema = z.strictObject({
  reference: SupplierScopePolicyReferenceSchema, predecessor: SupplierScopePolicyReferenceSchema.nullable(),
  status: z.enum(['ACTIVE', 'REVOKED']),
  buyerSiteIds: z.array(IdSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length),
  categories: z.array(SupplierScopeCategorySchema).min(1).max(100).refine(values => new Set(values.map(value => value.id)).size === values.length),
  issuedAt: InstantSchema, validFrom: InstantSchema, expiresAt: InstantSchema,
}).superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.reference.version === 1 ? value.predecessor !== null || value.status !== 'ACTIVE' : value.predecessor === null ||
    value.predecessor.version !== value.reference.version - 1 || !supplierScopePolicyPairsMatch(value.reference.pair, value.predecessor.pair)) {
    invalid('Policy material must retain its exact predecessor and original status.');
  }
  if (value.issuedAt !== value.validFrom) invalid('Policy activation must retain its original acceptance time.');
  const duration = Date.parse(value.expiresAt) - Date.parse(value.validFrom);
  if (value.status === 'ACTIVE' ? duration <= 0 || duration > SUPPLIER_SCOPE_POLICY_MAX_VALIDITY_MS : duration !== 0) invalid('Policy validity must retain its original finite interval.');
});
export type SupplierScopePolicyHttpProjection = z.infer<typeof SupplierScopePolicyHttpProjectionSchema>;

export const SupplierScopePolicyHttpReceiptSchema = z.strictObject({
  identity: SupplierScopePolicyCommandIdentitySchema, commandDigest: HashSchema,
  result: SupplierScopePolicyReferenceSchema, recordedAt: InstantSchema,
}).refine(value => supplierScopePolicyPairsMatch(value.identity.pair, value.result.pair), 'Original policy receipt and result must retain the same pair.');
export const SupplierRelationshipHttpResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('relationship-status'), projection: SupplierRelationshipProjectionSchema }),
  z.strictObject({ kind: z.literal('policy-read'), policy: SupplierScopePolicyHttpProjectionSchema }),
  z.strictObject({ kind: z.literal('policy-command'), outcome: z.enum(['APPENDED', 'EXACT_REPLAY']),
    receipt: SupplierScopePolicyHttpReceiptSchema, current: SupplierScopePolicyReferenceSchema }),
  z.strictObject({ kind: z.literal('relationship-command'), outcome: z.enum(['APPENDED', 'EXACT_REPLAY']),
    receipt: SupplierRelationshipReceiptSchema, currentHead: SupplierRelationshipHeadSchema }),
  z.strictObject({ kind: z.literal('relationship-recover'), original: z.strictObject({
    mutation: SupplierRelationshipMutationSchema, receipt: SupplierRelationshipReceiptSchema, currentHead: SupplierRelationshipHeadSchema,
  }).nullable() }),
]).superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.kind === 'policy-command') {
    const original = value.receipt.result, current = value.current;
    if (!supplierScopePolicyPairsMatch(original.pair, current.pair) || original.version > current.version ||
      (original.version === current.version && original.hash !== current.hash) ||
      (value.outcome === 'APPENDED' && (original.version !== current.version || original.hash !== current.hash))) invalid('Original policy receipt and observed head disagree.');
  }
  const original = value.kind === 'relationship-command' ? value.receipt : value.kind === 'relationship-recover' ? value.original?.receipt : undefined;
  const current = value.kind === 'relationship-command' ? value.currentHead : value.kind === 'relationship-recover' ? value.original?.currentHead : undefined;
  if (original && current) {
    const old = original.result;
    if (!supplierScopesMatch(old.scope, current.scope) || old.revision > current.revision || old.proposal.version > current.proposal.version ||
      (old.proposal.version === current.proposal.version && old.proposal.hash !== current.proposal.hash) ||
      (old.revision === current.revision && (old.proposal.version !== current.proposal.version || old.status !== current.status)) ||
      (value.kind === 'relationship-command' && value.outcome === 'APPENDED' && old.revision !== current.revision)) invalid('Original relationship receipt and observed head disagree.');
  }
});
export type SupplierRelationshipHttpResponse = z.infer<typeof SupplierRelationshipHttpResponseSchema>;
/** A trusted same-process service implements this interface; it is not an authentication constructor. */
export type SupplierRelationshipHttpGateway = {
  submit(bearer: string, input: SupplierRelationshipHttpRequest): Promise<SupplierRelationshipHttpResponse>;
};
