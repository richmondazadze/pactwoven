import { OperationSchema } from '@pactwoven/contracts';
import type { OrganizationProvisioner } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import type { ServiceBinding } from './worker-config.js';
import { serviceJsonRequest } from './worker-service.js';

export const provisionerUrl = 'https://pactwoven-provisioner.internal/v1/organizations/bootstrap';
const safeErrors = {
  AUTH_REQUIRED: [401, 'Sign in again to continue.'],
  FORBIDDEN: [403, 'Your current membership cannot set up this organization.'],
  IDEMPOTENCY_CONFLICT: [409, 'This request key was already used for a different command.'],
  ORGANIZATION_ALREADY_CONFIGURED: [409, 'This organization is configured. Refresh your session to continue.'],
  VALIDATION_FAILED: [422, 'Check the organization and initial site details.'],
} as const;

/** Forward a signed credential, never a caller-asserted actor or membership. */
export function serviceProvisioner(binding: ServiceBinding, authorization: string): OrganizationProvisioner {
  return {
    async bootstrapOrganization(_identity, idempotencyKey, command, correlationId) {
      const { response, data } = await serviceJsonRequest(binding, new Request(provisionerUrl, {
        method: 'POST', redirect: 'manual', headers: { Authorization: authorization, 'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey, 'X-Correlation-Id': correlationId }, body: JSON.stringify(command),
      }));
      if (response.status !== 201) {
        const code = typeof data === 'object' && data !== null && 'error' in data &&
          typeof data.error === 'object' && data.error !== null && 'code' in data.error ? data.error.code : null;
        if (typeof code === 'string' && Object.hasOwn(safeErrors, code)) {
          const [status, message] = safeErrors[code as keyof typeof safeErrors];
          if (response.status === status) throw new DomainError(code, status, message);
        }
        throw new Error('Organization setup was not confirmed');
      }
      const operation = OperationSchema.parse(data);
      if (operation.environment !== 'development' || operation.status !== 'succeeded' || operation.financialState !== null) {
        throw new Error('Invalid provisioner operation');
      }
      return operation;
    },
  };
}
