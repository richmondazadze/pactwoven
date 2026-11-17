import { createClerkClient } from '@clerk/backend';
import { z } from 'zod';
import { InstantSchema, SupplierScopeSchema, SupplierRelationshipHeadSchema, SupplierRelationshipApprovalSchema } from '@pactwoven/contracts';
import { DomainError, canonicalJson, immutable } from '@pactwoven/domain';
import { SupplierObserverConfigurationSchema, type SupplierObserverConfiguration } from '../../../packages/db/src/supplier-observer-schema.js';
import { SupplierApproverObservationsSchema, SupplierMembershipObservationSchema } from '../../../packages/db/src/supplier-relationship-persistence-schema.js';
import type { ClerkIdentityConfig } from './auth.js';
import { captureSupplierClerkConfiguration } from './supplier-relationship-verifier.js';

const externalId = z.string().min(1).max(256);
const planSchema = z.strictObject({
  scope: SupplierScopeSchema, head: SupplierRelationshipHeadSchema.nullable(),
  approvers: z.array(z.strictObject({
    approval: SupplierRelationshipApprovalSchema, externalOrganizationId: externalId, externalMembershipId: externalId, subject: externalId,
  })).max(2),
}).superRefine((plan, context) => {
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  if ((plan.head === null ? plan.approvers.length !== 0 : !same(plan.head.scope, plan.scope)) ||
    new Set(plan.approvers.map(entry => entry.approval.party)).size !== plan.approvers.length ||
    plan.approvers.some(entry => !same(entry.approval.proposal, plan.head?.proposal) || entry.approval.organizationId !==
      (entry.approval.party === 'buyer' ? plan.scope.buyerOrganizationId : plan.scope.supplierOrganizationId)) ||
    (plan.head?.status === 'ACTIVE' ? plan.approvers.length !== 2 : plan.head?.status === 'PROPOSED' ? plan.approvers.length > 1 : plan.approvers.length !== 0)) {
    context.addIssue({ code: 'custom', message: 'Original approver locators must retain one exact private head.' });
  }
});
export type SupplierOriginalApproverPlan = z.infer<typeof planSchema>;
export type SupplierOriginalApproverObservations = z.infer<typeof SupplierApproverObservationsSchema>;
const membershipPageSchema = z.object({
  totalCount: z.literal(1), data: z.array(z.object({
    id: externalId, role: externalId, organization: z.object({ id: externalId }),
    publicUserData: z.object({ userId: externalId }),
  })).length(1),
});
const refused = () => new DomainError('SUPPLIER_APPROVER_REFUSED', 403, 'Exact current original approver membership is required.');
const unavailable = () => new DomainError('SUPPLIER_APPROVER_UNAVAILABLE', 503, 'Original approver membership verification is temporarily unavailable.');

export function assertSupplierApproversCurrent(entries: SupplierOriginalApproverObservations,
  configuration: SupplierObserverConfiguration, now: string): void {
  const at = Date.parse(InstantSchema.parse(now)), binding = configuration.binding;
  if (binding.status !== 'ACTIVE' || Date.parse(binding.validFrom) > at || at >= Date.parse(binding.expiresAt)) throw refused();
  for (const { observation, approval } of entries) {
    if (observation.issuer !== configuration.issuer || Date.parse(observation.observedAt) < Date.parse(binding.validFrom) ||
      Date.parse(observation.observedAt) > at || at - Date.parse(observation.observedAt) > 20_000 ||
      at >= Date.parse(observation.expiresAt) || Date.parse(observation.expiresAt) > Date.parse(binding.expiresAt) ||
      Date.parse(approval.approvedAt) > at) throw refused();
  }
}

/** Membership-only provider reads for private preflight locators. No invented old-approver sessions. */
export function createSupplierRelationshipApproverObserver(clerkInput: ClerkIdentityConfig, observerInput: SupplierObserverConfiguration,
  clock: () => string = () => new Date().toISOString()) {
  const configuration = immutable(SupplierObserverConfigurationSchema.parse(observerInput));
  const clerk = captureSupplierClerkConfiguration(clerkInput, configuration.issuer);
  const client = createClerkClient({ secretKey: clerk.secretKey, telemetry: { disabled: true } });
  const lookup = client.organizations.getOrganizationMembershipList.bind(client.organizations);
  return Object.freeze({
    async observe(input: SupplierOriginalApproverPlan): Promise<SupplierOriginalApproverObservations> {
      const parsed = planSchema.safeParse(input);
      if (!parsed.success) throw refused();
      const plan = immutable(parsed.data), entries: SupplierOriginalApproverObservations = [];
      assertSupplierApproversCurrent(entries, configuration, clock());
      for (const original of plan.approvers) {
        let result: Awaited<ReturnType<typeof lookup>>;
        try { result = await lookup({ organizationId: original.externalOrganizationId, userId: [original.subject], limit: 2 }); }
        catch { throw unavailable(); }
        const page = membershipPageSchema.safeParse(result), member = page.success ? page.data.data[0] : undefined;
        if (!member || member.id !== original.externalMembershipId ||
          member.organization.id !== original.externalOrganizationId || member.publicUserData.userId !== original.subject) throw refused();
        const observedAt = InstantSchema.parse(clock());
        // Copy immediately. A subsequent lookup never refreshes this observation.
        const observation = SupplierMembershipObservationSchema.safeParse({
          issuer: configuration.issuer, subject: original.subject, externalOrganizationId: original.externalOrganizationId,
          externalMembershipId: original.externalMembershipId, externalRole: member.role, status: 'ACTIVE', observedAt,
          expiresAt: new Date(Math.min(Date.parse(observedAt) + 30_000, Date.parse(configuration.binding.expiresAt))).toISOString(),
        });
        if (!observation.success || plan.head === null) throw refused();
        entries.push(immutable({ head: plan.head, approval: original.approval, observation: observation.data }));
        assertSupplierApproversCurrent(entries, configuration, clock());
      }
      return immutable(SupplierApproverObservationsSchema.parse(entries));
    },
  });
}
