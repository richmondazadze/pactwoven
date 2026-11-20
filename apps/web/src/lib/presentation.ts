import type { Environment, Operation, Role } from '@pactwoven/contracts';
import { RequestError } from './api';

export type ErrorIntent = 'read' | 'save' | 'setup' | 'access';
export function readableRequestFailure(error: unknown, intent: ErrorIntent = 'read'): string {
  const saving = intent === 'save' || intent === 'setup';
  const subject = intent === 'setup' ? 'workspace setup' : 'save';
  if (error instanceof RequestError) {
    if (error.status === 401 || ['AUTH_REQUIRED', 'SESSION_REQUIRED'].includes(error.code)) return 'Your sign-in needs checking. Sign in again, then return to this page.';
    if (error.status === 403 || error.code === 'FORBIDDEN') return 'Your current workspace access does not allow this action. Check your account and assigned sites.';
    if (error.status === 404) return 'This record is not available in your current workspace.';
    if (error.code === 'VERSION_CONFLICT') return 'This record changed. Refresh it before making another change.';
    if (error.code === 'IDEMPOTENCY_CONFLICT') return 'The saved request needs review. Keep the original details and check its outcome before starting again.';
    if (error.code === 'BOOTSTRAP_REJECTED') return 'The service rejected this setup attempt. Review the site details before starting a new attempt.';
    if (error.code === 'ORGANIZATION_SETUP_REQUIRED') return 'Finish setting up your workspace to continue.';
    if (['ORGANIZATION_ALREADY_CONFIGURED', 'ORGANIZATION_ALREADY_PROVISIONED'].includes(error.code)) return 'Workspace setup is already recorded. Check your access to open it.';
    if (error.code === 'INVALID_DRAFT' || error.status === 422 || error.code === 'VALIDATION_FAILED') return 'Review the highlighted details before saving again.';
    if (['SETUP_REQUIRED', 'API_NOT_CONFIGURED'].includes(error.code)) return 'The workspace service is not connected yet. Please try again after setup is complete.';
    if (error.status === 429) return saving ? 'The service is busy. Wait briefly, then check the saved request.' : 'The service is busy. Wait briefly, then refresh this page.';
    if (error.code === 'RESPONSE_UNVERIFIED') return saving ? `We could not verify the ${subject} response. Check the saved request before starting another.` : 'We could not verify the returned record. Refresh it before relying on this information.';
    if (error.code === 'UNCONFIRMED') return 'An earlier save is awaiting confirmation. Check the saved draft before creating another.';
  }
  if (saving) return `We could not confirm the ${subject}. Check the saved request before starting another.`;
  if (intent === 'access') return 'Your workspace access could not be verified. Try checking again when your connection returns.';
  return 'The workspace could not be reached. Try refreshing when your connection returns.';
}

export const workspaceTypeLabel: Record<Environment, string> = {
  simulation: 'Simulation workspace', development: 'Test workspace', staging: 'Staging preview', production: 'Live workspace',
};
export const accessRoleLabels: Record<Role, string> = {
  owner: 'Owner', operations: 'Operations', finance: 'Finance', receiver: 'Receiving',
  supplier_admin: 'Supplier administration', supplier_dispatcher: 'Supplier dispatch', auditor: 'Audit access',
  support: 'Support access', service: 'Service account',
};
export function recordSaveState(status: Operation['status']): { title: string; message: string } {
  if (status === 'succeeded') return { title: 'Draft saved', message: 'Your work record has been saved.' };
  if (status === 'failed') return { title: 'The save was rejected', message: 'The service recorded a failed save. Keep the saved request available while you review the result.' };
  if (status === 'accepted') return { title: 'Save accepted', message: 'The service accepted the save for processing. Check the saved draft for confirmation.' };
  if (status === 'pending') return { title: 'Saving is awaiting confirmation', message: 'The save is still pending. Check the saved draft to retrieve its result.' };
  return { title: 'Saving needs confirmation', message: 'The outcome is not yet known. Check the saved draft before creating another.' };
}

const contexts = { 'workspace-access': 'Workspace access', 'workspace-setup': 'Workspace setup', 'record-list': 'Work records', 'record-create': 'Save work record', 'record-details': 'Work record', 'page-load': 'Page loading', 'native-work': 'Agent work recovery' } as const;
export type SupportContext = keyof typeof contexts;
export type SupportReferences = { requestId?: string; operationId?: string; recordId?: string; revision?: number };
const knownCodes = new Set(['API_NOT_CONFIGURED', 'AUTH_REQUIRED', 'SESSION_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'DURABLE_SERVICE_UNAVAILABLE', 'NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT', 'REQUEST_FAILED', 'RESPONSE_UNVERIFIED', 'SETUP_REQUIRED', 'ORGANIZATION_SETUP_REQUIRED', 'ORGANIZATION_ALREADY_CONFIGURED', 'ORGANIZATION_ALREADY_PROVISIONED', 'BOOTSTRAP_REJECTED', 'OUTCOME_UNKNOWN', 'UNCONFIRMED', 'INVALID_DRAFT', 'SESSION_UNAVAILABLE']);
const safeReference = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function supportDetailEntries(context: SupportContext, error?: unknown, references: SupportReferences = {}): [string, string][] {
  const entries: [string, string][] = [['Area', contexts[context]]];
  if (error instanceof RequestError) {
    entries.push(['Issue', knownCodes.has(error.code) ? error.code : 'UNEXPECTED_RESPONSE']);
    if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) entries.push(['Response status', String(error.status)]);
    if (safeReference(error.correlationId)) entries.push(['Support reference', error.correlationId]);
  }
  for (const [key, label] of [['requestId', 'Request reference'], ['operationId', 'Operation reference'], ['recordId', 'Record reference']] as const) {
    const value = references[key]; if (safeReference(value)) entries.push([label, value]);
  }
  if (Number.isSafeInteger(references.revision) && references.revision! > 0) entries.push(['Revision', String(references.revision)]);
  return entries;
}
export function supportDetailText(context: SupportContext, error?: unknown, references: SupportReferences = {}) {
  return ['Pactwoven support details', ...supportDetailEntries(context, error, references).map(([name, value]) => `${name}: ${value}`)].join('\n');
}
export async function copySupportDetails(text: string, clipboard?: Pick<Clipboard, 'writeText'>): Promise<'copied' | 'unavailable'> {
  if (!clipboard) return 'unavailable';
  try { await clipboard.writeText(text); return 'copied'; } catch { return 'unavailable'; }
}
