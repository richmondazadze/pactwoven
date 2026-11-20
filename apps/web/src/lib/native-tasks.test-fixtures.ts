import { NativeTaskSchema, SessionSchema } from '@pactwoven/contracts';
export const nativeSessionFixture = () => SessionSchema.parse({
  actor: { actorId: 'operator_one', principalKind: 'human', organizationId: 'company_one', environment: 'development', roles: ['owner'],
    siteIds: ['site_one'], actionSiteIds: ['site_one'], sessionId: 'session_one', authenticatedAt: '2026-11-18T12:00:00.000Z', correlationId: 'request_one' },
  organization: { id: 'company_one', name: 'Test Company', authorityEpoch: 1 },
  sites: [{ id: 'site_one', name: 'Chicago office', timeZone: 'America/Chicago' }],
});
export const nativeTaskFixture = () => NativeTaskSchema.parse({
  id: 'task_long_internal_identifier_00001', title: 'Office chairs for Friday', siteId: 'site_one', status: 'running', phase: 'Comparing the supplied information',
  createdAt: '2026-11-18T12:00:00.000Z', updatedAt: '2026-11-18T12:01:00.000Z', version: 3,
  availableActions: ['pause', 'cancel', 'message'], prompt: 'Compare these office chairs.', mode: 'advise',
  steps: [{ id: 'step_internal_research', agent: 'research', title: 'Review the supplied sources', status: 'completed', summary: 'Two supplied descriptions reviewed.' },
    { id: 'step_internal_plan', agent: 'planning', title: 'Compare the options', status: 'working', summary: 'Checking price and delivery constraints.' }],
  messages: [{ id: 'message_internal_001', role: 'user', text: 'Compare these office chairs.', createdAt: '2026-11-18T12:00:00.000Z' },
    { id: 'message_internal_002', role: 'assistant', text: 'I will compare the supplied information and identify what still needs verification.', createdAt: '2026-11-18T12:00:30.000Z' }],
  artifacts: [{ id: 'artifact_internal_001', kind: 'comparison', title: 'Chair options', text: '## Delivery\n\nDelivery dates still need confirmation.\n\n- Check the supplier terms\n- Confirm the delivery address',
    sources: [{ title: 'Chair description', url: 'https://example.com/chair' }], createdAt: '2026-11-18T12:01:00.000Z' }],
  events: [{ sequence: 1, kind: 'created', title: 'Task saved', detail: 'The requested comparison is ready.', agent: null, createdAt: '2026-11-18T12:00:00.000Z' },
    { sequence: 2, kind: 'progress', title: 'Comparison started', detail: 'Planning is checking the supplied constraints.', agent: 'planning', createdAt: '2026-11-18T12:01:00.000Z' }],
});
export const nativeTaskResponseFixture = () => ({ scope: { environment: 'development' as const, organizationId: 'company_one' }, task: nativeTaskFixture() });
