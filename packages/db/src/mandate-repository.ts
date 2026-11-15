import { type Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { CreateMandateDocumentRequestSchema, EnvironmentSchema, IdempotencyKeySchema, IdSchema, InstantSchema,
  MandateAuthorityIntentSchema, MandateCollectionQuerySchema, MandateDecisionIntentSchema, MandateDecisionSchema,
  MandateHeadSchema, MandateOperationKindSchema, MandateOperationQuerySchema, MandateOperationResultSchema, MandateDocumentQuerySchema, MandateDocumentReadSchema,
  MandateProposalVersionSchema, MandateReviewQuerySchema, MandateVersionSchema, MemberCandidateSchema,
  PolicyDocumentVersionSchema, ProposeMandateCommandSchema, ResponsibilitySchema, VersionReferenceSchema,
  type Environment, type MandateOperationKind, type MandateOperationResult, type MandateProposalVersion,
  type MandateDecision, type MandateHead, type MandateVersion, type PolicyDocumentVersion } from '@pactwoven/contracts';
import { assertMandateActor, changeMandateAuthority, commandDigest, createMandateProposal, createPolicyDocumentVersion,
  decideMandateProposal, DomainError, equalMandateValue, mandateHeadReference, mandateIntentHash, mandateReference,
  mandateResponsibilityReference, mandateVersionReference, normalizePolicyText, projectMandatePage, projectMandateRead,
  validatePolicyDocumentVersion, type MandateCurrentContext, type MandateHeadHistory, type MandateReadSource,
  type VerifiedMandateEvidence } from '@pactwoven/domain';
import { MandateMfaEvidenceSchema, type MandateMfaEvidence } from './mandate-evidence.js';
import { MandateIdentitySchema, MandateResolvedContextSchema, type MandateMutation, type MandateRepository,
  type MandateResolvedContext, type MandateRequesterSelector, type VerifiedMandateCommand } from './mandate-schema.js';
import type { VerifiedIdentity } from './repository.js';

const referenceKey = (value: { id: string; version: number }) => `${value.id}:${value.version}`;
const traceSchema = z.string().min(1).max(128);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const auditSchema = z.strictObject({ schemaVersion: z.literal(1), operationId: IdSchema, kind: MandateOperationKindSchema,
  actorId: IdSchema, identity: MandateIdentitySchema, evidence: MandateMfaEvidenceSchema.nullable(), requestNonce: z.uuid(),
  requestHash: hashSchema.nullable(), requesterObservation: MemberCandidateSchema.nullable(), commandHash: hashSchema,
  intentHash: hashSchema.nullable(), occurredAt: InstantSchema, history: z.unknown().nullable() });
const effectContextSchema = z.strictObject({ identity: MandateIdentitySchema, evidence: MandateMfaEvidenceSchema.nullable(), requesterObservation: MemberCandidateSchema.nullable(),
  kind: MandateOperationKindSchema, responsibilityId: IdSchema, responsibilitySnapshot: ResponsibilitySchema, organizationEpoch: z.number().int().nonnegative().max(2_147_483_647),
  command: z.unknown(), intentHash: hashSchema.nullable(), nonce: z.uuid(), requestHash: hashSchema.nullable(), operationId: IdSchema, key: IdempotencyKeySchema,
  commandHash: hashSchema, proposalExpiresAt: InstantSchema.nullable(), authorityExpiresAt: InstantSchema.nullable() });
const operationRowSchema = z.strictObject({ id: IdSchema, actor_id: IdSchema, responsibility_id: IdSchema, site_id: IdSchema,
  kind: MandateOperationKindSchema, idempotency_key: IdempotencyKeySchema, command_hash: hashSchema,
  command: z.unknown(), result: MandateOperationResultSchema, identity: MandateIdentitySchema, effect_context: effectContextSchema });
type OperationRow = z.infer<typeof operationRowSchema>;
type StoredDocument = { id: string; version: number; hash: string; responsibility_version: number; site_id: string; operation_id: string; body: PolicyDocumentVersion };
type StoredProposal = { id: string; version: number; hash: string; requester_id: string; requester_identity: VerifiedIdentity; operation_id: string; body: MandateProposalVersion };
type Loaded = { source: MandateReadSource; documents: StoredDocument[]; proposals: StoredProposal[]; operations: OperationRow[] };
function invalid(): never { throw new DomainError('MANDATE_READ_INVALID', 409, 'Mandate history or policy provenance could not be verified.'); }
function need(value: unknown): asserts value { if (!value) invalid(); }
function notFound(): never { throw new DomainError('NOT_FOUND', 404, 'The requested mandate record was not found.'); }
function requireCurrentRequester(context: MandateResolvedContext, id: string) {
  const row = context.requesters.find(record => record.actor.actorId === id);
  if (!row || row.status !== 'active' || (row.expiresAt && Date.parse(row.expiresAt) <= Date.parse(context.now))) {
    throw new DomainError('REQUESTER_CHANGED', 409, 'The original requester must retain current mandate capability.');
  }
  return row;
}
function parseMutation(input: MandateMutation): MandateMutation {
  switch (input.kind) {
    case 'document': {
      const request = CreateMandateDocumentRequestSchema.parse(input.request);
      request.command.text = normalizePolicyText(request.command.text);
      return { kind: 'document', request };
    }
    case 'propose': {
      const command = ProposeMandateCommandSchema.parse(input.command);
      command.expiresAt = new Date(command.expiresAt).toISOString();
      command.policy.expiresAt = new Date(command.policy.expiresAt).toISOString();
      command.policy.communication.expiresAt = new Date(command.policy.communication.expiresAt).toISOString();
      return { kind: 'propose', command };
    }
    case 'decide': return { kind: 'decide', proposalId: IdSchema.parse(input.proposalId), intent: MandateDecisionIntentSchema.parse(input.intent) };
    case 'control': return { kind: 'control', mandateId: IdSchema.parse(input.mandateId), intent: MandateAuthorityIntentSchema.parse(input.intent) };
  }
}
function publicCommand(mutation: MandateMutation) {
  return mutation.kind === 'document' ? mutation.request : mutation.kind === 'propose' ? mutation.command : mutation.intent;
}
function mutationKind(mutation: MandateMutation): MandateOperationKind {
  return mutation.kind === 'document' ? 'mandate.document.create' : mutation.kind === 'propose' ? 'mandate.propose'
    : MandateOperationKindSchema.parse(`mandate.${mutation.intent.action.toLowerCase()}`);
}
/** Private persistence digest. The public transport digest and signed intent digest have separate purposes. */
export async function mandateCommandHash(scope: { environment: Environment; organizationId: string; actorId: string; responsibilityId: string }, input: MandateMutation) {
  const mutation = parseMutation(input), targetId = mutation.kind === 'document' ? mutation.request.command.documentId
    : mutation.kind === 'propose' ? mutation.command.proposalId : mutation.kind === 'decide' ? mutation.proposalId : mutation.mandateId;
  return commandDigest({ schemaVersion: 1, environment: scope.environment, organizationId: scope.organizationId, actorId: scope.actorId,
    kind: mutationKind(mutation), route: { responsibilityId: scope.responsibilityId, targetId }, command: publicCommand(mutation) });
}
function mutationFromStored(row: OperationRow): MandateMutation {
  if (row.kind === 'mandate.document.create') return parseMutation({ kind: 'document', request: CreateMandateDocumentRequestSchema.parse(row.command) });
  if (row.kind === 'mandate.propose') return parseMutation({ kind: 'propose', command: ProposeMandateCommandSchema.parse(row.command) });
  if (row.kind === 'mandate.authorize' || row.kind === 'mandate.reject') {
    const intent = MandateDecisionIntentSchema.parse(row.command);
    return { kind: 'decide', proposalId: intent.proposal.id, intent };
  }
  const intent = MandateAuthorityIntentSchema.parse(row.command);
  return { kind: 'control', mandateId: intent.mandate.id, intent };
}
function reduceEvidence(evidence: MandateMfaEvidence, actorId: string): VerifiedMandateEvidence {
  return { id: evidence.id, purpose: evidence.purpose, intentHash: evidence.intentHash, actorId, sessionId: evidence.sessionId,
    verifiedAt: evidence.verifiedAt, expiresAt: evidence.expiresAt };
}
async function verifyEvidence(evidence: MandateMfaEvidence | null, identity: VerifiedIdentity, nonce: string, key: string,
  mutation: MandateMutation, actorId: string, now: string): Promise<{ proof: VerifiedMandateEvidence | null; requestHash: string | null }> {
  const requires = (mutation.kind === 'decide' && mutation.intent.action === 'AUTHORIZE') || (mutation.kind === 'control' && mutation.intent.action === 'RESUME');
  if (!requires) { need(evidence === null); return { proof: null, requestHash: null }; }
  if (!evidence) throw new DomainError('STEP_UP_REQUIRED', 403, 'Fresh purpose-specific mandate verification is required.');
  const intent = (mutation as Extract<MandateMutation, { kind: 'decide' | 'control' }>).intent;
  const purpose = intent.action === 'AUTHORIZE' ? 'mandate_authorization' : 'mandate_control';
  const requestHash = await commandDigest({ schemaVersion: 1, purpose, request: { nonce, key, intent } });
  if (evidence.purpose !== purpose || evidence.intentHash !== await mandateIntentHash(intent) || evidence.requestNonce !== nonce || evidence.requestHash !== requestHash ||
      evidence.subject !== identity.subject || evidence.externalOrganizationId !== identity.externalOrganizationId ||
      evidence.externalMembershipId !== identity.externalMembershipId || evidence.sessionId !== identity.sessionId ||
      Date.parse(evidence.observedAt) > Date.parse(now) || Date.parse(evidence.observedAt) < Date.parse(now) - 20_000 || Date.parse(evidence.expiresAt) <= Date.parse(now)) {
    throw new DomainError('STEP_UP_REQUIRED', 403, 'Mandate verification must remain fresh and bind the exact request and current actor.');
  }
  return { proof: reduceEvidence(evidence, actorId), requestHash };
}
function databaseError(error: unknown, committing: boolean): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const mapped = {
    PM001: ['FORBIDDEN', 403, 'Current mandate and site capability are required.'],
    PM002: ['AUTHORITY_CHANGED', 409, 'Mandate authority or its review window changed. Refresh before reviewing again.'],
    PM004: ['VALIDATION_FAILED', 422, 'The exact mandate command and records are required.'],
    PM005: ['STEP_UP_REQUIRED', 403, 'Verify both factors again before authorizing or resuming the mandate.'],
    PM006: ['MANDATE_READ_INVALID', 409, 'Mandate history is immutable.'],
    '42501': ['FORBIDDEN', 403, 'Current mandate and site capability are required.'],
    '23505': ['VERSION_CONFLICT', 409, 'This mandate record or request key already exists. Recover or refresh the original request.'],
    '23503': ['AUTHORITY_CHANGED', 409, 'A referenced mandate record changed. Refresh before reviewing again.'],
    '40001': ['VERSION_CONFLICT', 409, 'A concurrent mandate change requires a fresh review.'],
    '40P01': ['VERSION_CONFLICT', 409, 'A concurrent mandate change requires a fresh review.'],
  } as const;
  if (typeof code === 'string' && Object.hasOwn(mapped, code)) {
    const [name, status, message] = mapped[code as keyof typeof mapped]; throw new DomainError(name, status, message);
  }
  if (error instanceof z.ZodError) invalid();
  throw new DomainError(committing ? 'OUTCOME_UNKNOWN' : 'SERVICE_UNAVAILABLE', 503,
    committing ? 'The mandate outcome is unknown. Recover the original request before trying another change.' : 'Mandate storage is temporarily unavailable.');
}

/** Trusted private service repository. Every command uses one connection and organization-first locks. */
export class PostgresMandateRepository implements MandateRepository {
  private readonly environment: Environment;
  constructor(private readonly pool: Pool, environment: Environment) { this.environment = EnvironmentSchema.parse(environment); }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined, committing = false, failed = false;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='4s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
      const result = await work(client);
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failed = true;
      if (client) { try { await client.query('ROLLBACK'); } catch { /* The connection is discarded below. */ } }
      return databaseError(error, committing);
    } finally { client?.release(failed); }
  }
  private async context(client: PoolClient, identity: VerifiedIdentity, responsibilityId: string | null, write: boolean, trace: string) {
    const result = await client.query<{ response: unknown }>('SELECT pactwoven.mandate_resolve_context($1,$2::jsonb,$3,$4,$5) AS response',
      [this.environment, JSON.stringify(identity), responsibilityId, write, trace]);
    return MandateResolvedContextSchema.parse(result.rows[0]?.response);
  }
  private async rows(client: PoolClient, table: string, columns: string, organizationId: string, responsibilityId: string) {
    // Identifiers are hard-coded callers only; all tenant and record values stay parameters.
    const result = await client.query(`SELECT ${columns} FROM pactwoven.${table} WHERE environment=$1 AND organization_id=$2 AND responsibility_id=$3 LIMIT 513`,
      [this.environment, organizationId, responsibilityId]);
    if (result.rows.length > 512) invalid();
    return result.rows;
  }
  private async load(client: PoolClient, context: MandateResolvedContext): Promise<Loaded> {
    const current = context.currentResponsibility; if (!current) notFound();
    const read = (table: string, columns: string) => this.rows(client, table, columns, context.organizationId, current.id);
    const snapshots = (await read('mandate_responsibility_versions', 'body')).map(row => ResponsibilitySchema.parse(row.body));
    const documents = (await read('mandate_policy_documents', 'id,version,hash,responsibility_version,site_id,operation_id,body')).map(row => ({
      id: IdSchema.parse(row.id), version: z.number().int().positive().parse(row.version), hash: hashSchema.parse(row.hash),
      responsibility_version: z.number().int().positive().parse(row.responsibility_version), site_id: IdSchema.parse(row.site_id), operation_id: IdSchema.parse(row.operation_id),
      body: PolicyDocumentVersionSchema.parse(row.body) }));
    const proposals = (await read('mandate_proposals', 'id,version,hash,requester_id,requester_identity,operation_id,body')).map(row => ({
      id: IdSchema.parse(row.id), version: z.number().int().positive().parse(row.version), hash: hashSchema.parse(row.hash), requester_id: IdSchema.parse(row.requester_id),
      requester_identity: MandateIdentitySchema.parse(row.requester_identity), operation_id: IdSchema.parse(row.operation_id), body: MandateProposalVersionSchema.parse(row.body) }));
    const decisions = (await read('mandate_decisions', 'body')).map(row => MandateDecisionSchema.parse(row.body));
    const acceptedVersions = (await read('mandate_versions', 'body')).map(row => MandateVersionSchema.parse(row.body));
    const heads = (await read('mandate_heads', 'body')).map(row => MandateHeadSchema.parse(row.body)); need(heads.length <= 1);
    const operations = (await read('mandate_operations', 'id,actor_id,responsibility_id,site_id,kind,idempotency_key,command_hash,command,result,identity,effect_context')).map(row => operationRowSchema.parse(row));
    const audits = (await read('mandate_audit', 'body')).map(row => auditSchema.parse(row.body));
    const outbox = await read('mandate_outbox', 'operation_id,event_type,payload,delivered_at');
    const headHistory: MandateHeadHistory[] = [];
    need(audits.length === operations.length && outbox.length === operations.length);
    for (const operation of operations) {
      const matches = audits.filter(audit => audit.operationId === operation.id); need(matches.length === 1);
      const audit = matches[0]!;
      const mutation = mutationFromStored(operation), command = publicCommand(mutation), result = operation.result;
      const effect = operation.effect_context;
      need(effect.operationId === operation.id && effect.kind === operation.kind && effect.responsibilityId === operation.responsibility_id &&
        effect.key === operation.idempotency_key && effect.commandHash === operation.command_hash && equalMandateValue(effect.identity, operation.identity) &&
        equalMandateValue(effect.command, command) && effect.intentHash === result.intentHash && effect.nonce === audit.requestNonce && effect.requestHash === audit.requestHash &&
        equalMandateValue(effect.evidence, audit.evidence) && equalMandateValue(effect.requesterObservation, audit.requesterObservation) &&
        effect.organizationEpoch === command.expectedOrganizationEpoch && effect.organizationEpoch <= context.organizationEpoch &&
        effect.responsibilitySnapshot.id === current.id && effect.responsibilitySnapshot.siteId === operation.site_id &&
        snapshots.some(snapshot => equalMandateValue(snapshot, effect.responsibilitySnapshot)) && Date.parse(effect.responsibilitySnapshot.updatedAt) <= Date.parse(result.observedAt));
      let proposalExpiry: string | null = null, authorityExpiry: string | null = null;
      if (mutation.kind === 'propose') {
        proposalExpiry = mutation.command.expiresAt; authorityExpiry = mutation.command.policy.expiresAt;
        if (mutation.command.previousProposal) {
          const prior = proposals.find(row => equalMandateValue(mandateReference(row.body), mutation.command.previousProposal)); need(prior);
          if (Date.parse(prior.body.expiresAt) < Date.parse(proposalExpiry)) proposalExpiry = prior.body.expiresAt;
        }
      } else if (mutation.kind === 'decide') {
        const selected = proposals.find(row => equalMandateValue(mandateReference(row.body), mutation.intent.proposal)); need(selected);
        proposalExpiry = selected.body.expiresAt; authorityExpiry = selected.body.policy.expiresAt;
        need(equalMandateValue(await mandateResponsibilityReference(effect.responsibilitySnapshot), selected.body.responsibility));
      } else if (mutation.kind === 'control') {
        const accepted = acceptedVersions.find(row => row.id === mutation.intent.mandate.id && row.version === mutation.intent.mandate.version); need(accepted);
        authorityExpiry = accepted.policy.expiresAt;
      }
      if ('responsibility' in command) need(equalMandateValue(await mandateResponsibilityReference(effect.responsibilitySnapshot), command.responsibility));
      need(effect.proposalExpiresAt === proposalExpiry && effect.authorityExpiresAt === authorityExpiry &&
        (proposalExpiry === null || Date.parse(proposalExpiry) > Date.parse(result.observedAt)) &&
        (authorityExpiry === null || Date.parse(authorityExpiry) > Date.parse(result.observedAt)));
      need(mutationKind(mutation) === operation.kind && equalMandateValue(command, operation.command) &&
        operation.command_hash === await mandateCommandHash({ environment: this.environment, organizationId: context.organizationId, actorId: operation.actor_id, responsibilityId: current.id }, mutation) && result.commandHash === operation.command_hash &&
        result.organizationId === context.organizationId && result.responsibilityId === current.id && result.kind === operation.kind &&
        result.operation.id === operation.id && result.operation.environment === this.environment && result.operation.status === 'succeeded' &&
        result.operation.error === null && result.operation.nextCheckAt === null && result.operation.evidenceRefs.length === 0 &&
        audit.kind === operation.kind && audit.actorId === operation.actor_id && equalMandateValue(audit.identity, operation.identity) &&
        audit.commandHash === operation.command_hash && audit.intentHash === result.intentHash && audit.occurredAt === result.observedAt);
      need(Date.parse(audit.identity.authenticatedAt) <= Date.parse(audit.occurredAt) && Date.parse(audit.identity.membershipObservedAt) <= Date.parse(audit.occurredAt) &&
        Date.parse(audit.identity.membershipObservedAt) >= Date.parse(audit.occurredAt) - 20_000);
      let bound: Awaited<ReturnType<typeof verifyEvidence>>;
      try { bound = await verifyEvidence(audit.evidence, audit.identity, audit.requestNonce, operation.idempotency_key, mutation, operation.actor_id, audit.occurredAt); }
      catch { invalid(); }
      need(audit.requestHash === bound.requestHash);
      const intentHash = mutation.kind === 'decide' || mutation.kind === 'control' ? await mandateIntentHash(mutation.intent) : null;
      need(result.intentHash === intentHash);
      if (mutation.kind === 'decide' || (mutation.kind === 'control' && mutation.intent.action === 'RESUME')) {
        const selectedReference = mutation.kind === 'decide' ? mutation.intent.proposal : decisions.find(row => row.authorization && equalMandateValue(row.authorization.acceptedVersion, mutation.intent.mandate))?.proposal;
        need(selectedReference);
        const originalRequester = proposals.find(row => equalMandateValue(mandateReference(row.body), selectedReference));
        const observed = audit.requesterObservation;
        need(originalRequester && observed && originalRequester.body.requesterId !== operation.actor_id &&
          observed.externalSubject === originalRequester.requester_identity.subject && observed.externalMembershipId === originalRequester.requester_identity.externalMembershipId &&
          observed.externalOrganizationId === originalRequester.requester_identity.externalOrganizationId &&
          Date.parse(observed.observedAt) <= Date.parse(audit.occurredAt) && Date.parse(observed.observedAt) >= Date.parse(audit.occurredAt) - 20_000);
      } else need(audit.requesterObservation === null);
      if (operation.kind === 'mandate.authorize' || mutation.kind === 'control') {
        need(audit.history && typeof audit.history === 'object');
        const history = audit.history as MandateHeadHistory;
        need(history.operationId === operation.id && history.actorId === operation.actor_id && history.occurredAt === audit.occurredAt &&
          equalMandateValue(history.evidence, bound.proof) && history.action === (mutation.kind === 'decide' ? 'AUTHORIZE' : mutation.kind === 'control' ? mutation.intent.action : null) &&
          equalMandateValue(history.intent, mutation.kind === 'control' ? mutation.intent : null));
        headHistory.push(history);
      } else need(audit.history === null);
      const event = outbox.filter(row => row.operation_id === operation.id); need(event.length === 1);
      need(event[0]!.event_type === operation.kind && event[0]!.delivered_at === null && equalMandateValue(event[0]!.payload,
        { schemaVersion: 1, operationId: operation.id, kind: operation.kind, responsibilityId: current.id, target: result.target }));
    }
    const documentMap = new Map(documents.map(row => [referenceKey(row.body), row])); need(documentMap.size === documents.length);
    for (const row of documents) {
      await validatePolicyDocumentVersion(row.body);
      need(equalMandateValue(mandateReference(row.body), { id: row.id, version: row.version, hash: row.hash }));
      const responsibility = snapshots.find(record => record.version === row.responsibility_version);
      need(responsibility && responsibility.siteId === row.site_id && row.body.organizationId === context.organizationId && row.body.environment === this.environment);
      const prior = row.body.previousVersion ? documentMap.get(referenceKey(row.body.previousVersion)) : null;
      if (row.body.previousVersion) need(prior && equalMandateValue(mandateReference(prior.body), row.body.previousVersion) && prior.site_id === row.site_id && prior.body.purpose === row.body.purpose && Date.parse(prior.body.createdAt) <= Date.parse(row.body.createdAt));
      const operation = operations.find(record => record.id === row.operation_id); need(operation && operation.kind === 'mandate.document.create' && operation.actor_id === row.body.createdBy && operation.result.observedAt === row.body.createdAt);
      const command = CreateMandateDocumentRequestSchema.parse(operation.command);
      need(equalMandateValue(command.responsibility, await mandateResponsibilityReference(responsibility)) && command.command.documentId === row.id && command.command.expectedVersion + 1 === row.version &&
        command.command.text === row.body.text && command.command.purpose === row.body.purpose && equalMandateValue(command.command.previousVersion, row.body.previousVersion));
    }
    for (const row of proposals) {
      const operation = operations.find(record => record.id === row.operation_id); need(operation && operation.kind === 'mandate.propose' && operation.actor_id === row.body.requesterId && operation.result.observedAt === row.body.createdAt);
      need(equalMandateValue(row.requester_identity, operation.identity) && row.requester_id === row.body.requesterId && equalMandateValue(mandateReference(row.body), { id: row.id, version: row.version, hash: row.hash }));
      const command = ProposeMandateCommandSchema.parse(operation.command);
      need(equalMandateValue({ proposalId: row.body.id, expectedProposalVersion: row.body.version - 1, previousProposal: row.body.previousProposal,
        mandateId: row.body.mandateId, responsibility: row.body.responsibility, expectedOrganizationEpoch: row.body.organizationEpoch,
        previousAcceptedVersion: row.body.previousAcceptedVersion, expectedHead: row.body.expectedHead, policy: row.body.policy,
        policyDocument: row.body.policyDocument, expiresAt: row.body.expiresAt }, command));
    }
    for (const row of decisions) {
      const operation = operations.find(record => record.id === row.operationId); need(operation);
      need((row.state === 'OPEN' ? row.createdAt : row.decidedAt) === operation.result.observedAt);
      if (row.state === 'OPEN' || row.state === 'SUPERSEDED') need(operation.kind === 'mandate.propose');
      else need((row.state === 'APPROVED' ? operation.kind === 'mandate.authorize' : row.state === 'REJECTED' && operation.kind === 'mandate.reject') && row.actorId === operation.actor_id && row.intentHash === operation.result.intentHash);
    }
    const used = new Set<string>();
    function include(reference: { id: string; version: number }) {
      let row = documentMap.get(referenceKey(reference)); need(row);
      while (row && !used.has(referenceKey(row.body))) { used.add(referenceKey(row.body)); row = row.body.previousVersion ? documentMap.get(referenceKey(row.body.previousVersion)) : undefined; }
    }
    for (const row of proposals) { include(row.body.policy.acceptancePolicy); include(row.body.policyDocument); }
    const source: MandateReadSource = { organizationId: context.organizationId, environment: this.environment, organizationEpoch: context.organizationEpoch,
      organizationStatus: context.organizationStatus, now: context.now, reader: context.reader, requesters: context.requesters,
      currentResponsibility: current, responsibilityVersions: snapshots, sites: context.sites,
      documents: documents.filter(row => used.has(referenceKey(row.body))).map(row => ({ environment: this.environment,
        organizationId: context.organizationId, responsibilityId: current.id, siteId: row.site_id, document: row.body })),
      proposals: proposals.map(row => row.body), decisions, acceptedVersions, head: heads[0] ?? null, headHistory, selectedProposal: null };
    for (const operation of operations) await this.verifyTarget(operation, source, documents, proposals);
    return { source, documents, proposals, operations };
  }
  private async verifyTarget(operation: OperationRow, source: MandateReadSource, documents: StoredDocument[], proposals: StoredProposal[]) {
    const target = operation.result.target;
    let reference: { id: string; version: number; hash: string } | null = null;
    if (target.kind === 'document') {
      const row = documents.find(record => record.id === target.id && record.version === target.version && record.operation_id === operation.id);
      if (row) reference = mandateReference(row.body);
    } else if (target.kind === 'proposal') {
      const row = proposals.find(record => record.id === target.id && record.version === target.version && record.operation_id === operation.id);
      if (row) reference = mandateReference(row.body);
    } else if (target.kind === 'decision') {
      const row = source.decisions.find(record => record.proposal.id === target.id && record.version === target.version && record.operationId === operation.id);
      if (row) reference = { id: row.proposal.id, version: row.version, hash: await commandDigest(row) };
    } else {
      const row = source.headHistory.find(record => record.head.mandateId === target.id && record.head.mandateEpoch === target.version && record.operationId === operation.id);
      if (row) reference = { id: row.head.mandateId, version: row.head.mandateEpoch, hash: await commandDigest(row.head) };
    }
    need(reference && equalMandateValue(target, { kind: target.kind, ...reference }));
  }
  private async refreshRead(client: PoolClient, identity: VerifiedIdentity, source: MandateReadSource, trace: string) {
    const context = await this.context(client, identity, source.currentResponsibility.id, false, trace);
    need(equalMandateValue(context.currentResponsibility, source.currentResponsibility) && context.organizationEpoch === source.organizationEpoch);
    return { ...source, now: context.now, reader: context.reader, requesters: context.requesters, sites: context.sites, organizationStatus: context.organizationStatus };
  }
  async list(identityInput: VerifiedIdentity, responsibilityInput: string, input: Parameters<MandateRepository['list']>[2], traceInput: string) {
    const identity = MandateIdentitySchema.parse(identityInput), responsibilityId = IdSchema.parse(responsibilityInput), query = MandateCollectionQuerySchema.parse(input), trace = traceSchema.parse(traceInput);
    return this.transaction(async client => {
      const context = await this.context(client, identity, responsibilityId, false, trace), loaded = await this.load(client, context);
      const source = await this.refreshRead(client, identity, loaded.source, trace);
      // Collection rows represent the latest version of each proposal; complete
      // history remains in source for validation and exact-version review.
      const latest = new Map<string, MandateProposalVersion>();
      for (const proposal of source.proposals) {
        const prior = latest.get(proposal.id);
        if (!prior || proposal.version > prior.version) latest.set(proposal.id, proposal);
      }
      const proposals = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
      let offset = 0;
      if (query.cursor) {
        let cursor: { organizationId: string; responsibilityId: string; proposal: { id: string; version: number; hash: string } };
        try { cursor = z.strictObject({ organizationId: IdSchema, responsibilityId: IdSchema, proposal: VersionReferenceSchema }).parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
        catch { throw new DomainError('VALIDATION_FAILED', 422, 'A valid mandate page cursor is required.'); }
        if (cursor.organizationId !== context.organizationId || cursor.responsibilityId !== responsibilityId) throw new DomainError('VALIDATION_FAILED', 422, 'The cursor belongs to a different mandate collection.');
        offset = proposals.findIndex(row => equalMandateValue(mandateReference(row), cursor.proposal)) + 1;
        if (offset === 0) throw new DomainError('VERSION_CONFLICT', 409, 'The mandate collection changed. Refresh its first page.');
      }
      const selected = proposals.slice(offset, offset + query.limit), last = selected.at(-1);
      const nextCursor = last && offset + selected.length < proposals.length ? Buffer.from(JSON.stringify({ organizationId: context.organizationId, responsibilityId, proposal: mandateReference(last) })).toString('base64url') : null;
      return projectMandatePage(source, { proposals: selected.map(mandateReference), nextCursor });
    });
  }
  async review(identityInput: VerifiedIdentity, responsibilityInput: string, proposalInput: string, input: Parameters<MandateRepository['review']>[3], traceInput: string) {
    const identity = MandateIdentitySchema.parse(identityInput), responsibilityId = IdSchema.parse(responsibilityInput), proposalId = IdSchema.parse(proposalInput), query = MandateReviewQuerySchema.parse(input), trace = traceSchema.parse(traceInput);
    return this.transaction(async client => {
      const context = await this.context(client, identity, responsibilityId, false, trace), loaded = await this.load(client, context);
      const source = await this.refreshRead(client, identity, loaded.source, trace);
      const proposal = source.proposals.find(row => row.id === proposalId && row.version === query.version); if (!proposal) notFound();
      return projectMandateRead({ ...source, selectedProposal: mandateReference(proposal) });
    });
  }
  async operation(identityInput: VerifiedIdentity, input: Parameters<MandateRepository['operation']>[1], traceInput: string) {
    const identity = MandateIdentitySchema.parse(identityInput), query = MandateOperationQuerySchema.parse(input), trace = traceSchema.parse(traceInput);
    return this.transaction(async client => {
      let context = await this.context(client, identity, null, false, trace);
      const found = await client.query('SELECT responsibility_id FROM pactwoven.mandate_operations WHERE environment=$1 AND organization_id=$2 AND kind=$3 AND idempotency_key=$4 AND actor_id=$5',
        [this.environment, context.organizationId, query.kind, query.key, context.reader.actor.actorId]);
      if (found.rows.length !== 1) notFound();
      context = await this.context(client, identity, IdSchema.parse(found.rows[0].responsibility_id), false, trace);
      const { source, operations } = await this.load(client, context); await projectMandateRead(await this.refreshRead(client, identity, source, trace));
      const operation = operations.find(row => row.kind === query.kind && row.idempotency_key === query.key && row.actor_id === context.reader.actor.actorId); if (!operation) notFound();
      return operation.result;
    });
  }
  async readDocument(identityInput: VerifiedIdentity, responsibilityInput: string, documentInput: string, input: Parameters<MandateRepository['readDocument']>[3], traceInput: string) {
    const identity = MandateIdentitySchema.parse(identityInput), responsibilityId = IdSchema.parse(responsibilityInput),
      documentId = IdSchema.parse(documentInput), query = MandateDocumentQuerySchema.parse(input), trace = traceSchema.parse(traceInput);
    return this.transaction(async client => {
      const context = await this.context(client, identity, responsibilityId, false, trace), loaded = await this.load(client, context);
      const document = loaded.documents.find(row => row.id === documentId && row.version === query.version);
      if (!document) notFound();
      const source = await this.refreshRead(client, identity, loaded.source, trace);
      await projectMandateRead(source);
      if (!source.reader.actor.siteIds.includes(document.site_id)) throw new DomainError('FORBIDDEN', 403, 'Current read access to the historical document site is required.');
      const saved = source.responsibilityVersions.find(row => row.id === responsibilityId && row.version === document.responsibility_version && row.siteId === document.site_id);
      const operation = loaded.operations.find(row => row.id === document.operation_id);
      need(saved && operation && operation.kind === 'mandate.document.create');
      const request = CreateMandateDocumentRequestSchema.parse(operation.command), reference = await mandateResponsibilityReference(saved);
      need(equalMandateValue(reference, request.responsibility) && equalMandateValue(saved, operation.effect_context.responsibilitySnapshot) &&
        operation.effect_context.organizationEpoch === request.expectedOrganizationEpoch && operation.site_id === saved.siteId &&
        document.body.createdBy === operation.actor_id && document.body.createdAt === operation.result.observedAt &&
        equalMandateValue(operation.result.target, { kind: 'document', ...mandateReference(document.body) }));
      // Only the validated historical content and public save receipt cross this boundary.
      return MandateDocumentReadSchema.parse({ schemaVersion: 1, environment: this.environment, organizationId: source.organizationId,
        responsibilityId, observedAt: source.now, document: document.body,
        savedAgainst: { responsibility: reference, organizationEpoch: request.expectedOrganizationEpoch },
        savedResponsibility: saved, saveOperation: operation.result });
    });
  }
  async requester(identityInput: VerifiedIdentity, responsibilityInput: string, input: MandateRequesterSelector, traceInput: string) {
    const identity = MandateIdentitySchema.parse(identityInput), responsibilityId = IdSchema.parse(responsibilityInput), trace = traceSchema.parse(traceInput);
    const selector = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('proposal'), reference: VersionReferenceSchema }), z.strictObject({ kind: z.literal('mandate'), reference: VersionReferenceSchema })]).parse(input);
    return this.transaction(async client => {
      let context = await this.context(client, identity, responsibilityId, false, trace);
      const { source, proposals } = await this.load(client, context);
      context = await this.context(client, identity, responsibilityId, false, trace);
      await projectMandateRead({ ...source, now: context.now, reader: context.reader, requesters: context.requesters });
      let proposal: MandateProposalVersion | undefined;
      if (selector.kind === 'proposal') proposal = source.proposals.find(row => equalMandateValue(mandateReference(row), selector.reference));
      else {
        const accepted = source.acceptedVersions.find(row => row.id === selector.reference.id && row.version === selector.reference.version);
        if (accepted && equalMandateValue(await mandateVersionReference(accepted), selector.reference)) {
          const decision = source.decisions.find(row => row.authorization && equalMandateValue(row.authorization.acceptedVersion, selector.reference));
          if (decision) proposal = proposals.find(row => equalMandateValue(mandateReference(row.body), decision.proposal))?.body;
        }
      }
      if (!proposal) notFound();
      const requester = requireCurrentRequester(context, proposal.requesterId);
      if (!requester.externalMembershipId) notFound();
      return { externalSubject: requester.externalSubject, externalMembershipId: requester.externalMembershipId };
    });
  }
  async mutate(verifiedInput: VerifiedMandateCommand, responsibilityInput: string, keyInput: string, input: MandateMutation, traceInput: string) {
    const identity = MandateIdentitySchema.parse(verifiedInput.identity), evidence = verifiedInput.evidence ? MandateMfaEvidenceSchema.parse(verifiedInput.evidence) : null,
      requestNonce = z.uuid().parse(verifiedInput.requestNonce), requesterObservation = verifiedInput.requesterObservation ? MemberCandidateSchema.parse(verifiedInput.requesterObservation) : null;
    const responsibilityId = IdSchema.parse(responsibilityInput), key = IdempotencyKeySchema.parse(keyInput), mutation = parseMutation(input), trace = traceSchema.parse(traceInput);
    const command = publicCommand(mutation), kind = mutationKind(mutation);
    if ((mutation.kind === 'decide' && mutation.proposalId !== mutation.intent.proposal.id) || (mutation.kind === 'control' && mutation.mandateId !== mutation.intent.mandate.id) ||
        ('responsibility' in command && command.responsibility.id !== responsibilityId)) throw new DomainError('VALIDATION_FAILED', 422, 'The exact mandate route target is required.');
    return this.transaction(async client => {
      let context = await this.context(client, identity, responsibilityId, true, trace);
      const commandHash = await mandateCommandHash({ environment: this.environment, organizationId: context.organizationId, actorId: context.reader.actor.actorId, responsibilityId }, mutation);
      let loaded = await this.load(client, context);
      await projectMandateRead(loaded.source);
      const prior = await client.query('SELECT id,actor_id,responsibility_id,command_hash,command FROM pactwoven.mandate_operations WHERE environment=$1 AND organization_id=$2 AND kind=$3 AND idempotency_key=$4', [this.environment, context.organizationId, kind, key]);
      if (prior.rows.length) {
        const row = prior.rows[0];
        if (row.actor_id !== context.reader.actor.actorId || row.responsibility_id !== responsibilityId || row.command_hash !== commandHash || !equalMandateValue(row.command, command)) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'This request key belongs to a different mandate command.');
        const original = loaded.operations.find(operation => operation.id === row.id); if (!original) invalid();
        return original.result;
      }
      const responsibility = context.currentResponsibility!;
      const current: MandateCurrentContext = { organizationId: context.organizationId, environment: this.environment, organizationEpoch: context.organizationEpoch,
        now: context.now, responsibility, site: context.sites.find(site => site.id === responsibility.siteId)!, head: loaded.source.head,
        acceptedVersion: loaded.source.head ? loaded.source.acceptedVersions.find(row => row.id === loaded.source.head!.mandateId && row.version === loaded.source.head!.mandateVersion)! : null,
        documents: loaded.documents.map(row => row.body) };
      assertMandateActor(context.reader.actor, current, mutation.kind === 'document' || mutation.kind === 'propose' ? ['owner', 'finance', 'operations'] : ['owner', 'finance']);
      const verified = await verifyEvidence(evidence, identity, requestNonce, key, mutation, context.reader.actor.actorId, context.now);
      const operationId = crypto.randomUUID(), intentHash = mutation.kind === 'decide' || mutation.kind === 'control' ? await mandateIntentHash(mutation.intent) : null;
      let document: PolicyDocumentVersion | null = null, proposal: MandateProposalVersion | null = null, decisions: MandateDecision[] = [],
        accepted: MandateVersion | null = null, head: MandateHead | null = null, history: MandateHeadHistory | null = null;
      let proposalExpiresAt: string | undefined, authorityExpiresAt: string | undefined;
      const requesterFor = (id: string) => {
        const requester = requireCurrentRequester(context, id), observed = requesterObservation;
        if (!observed || observed.externalSubject !== requester.externalSubject || observed.externalMembershipId !== requester.externalMembershipId || observed.externalOrganizationId !== identity.externalOrganizationId ||
            (requester.grantBasis === 'clerk_admin_bootstrap' && observed.externalRole !== 'org:admin') || Date.parse(observed.observedAt) > Date.parse(context.now) || Date.parse(observed.observedAt) < Date.parse(context.now) - 20_000) {
          throw new DomainError('REQUESTER_CHANGED', 409, 'The original requester membership must be freshly verified.');
        }
        return requester.actor;
      };
      if (mutation.kind === 'document') {
        if (mutation.request.expectedOrganizationEpoch !== context.organizationEpoch || !equalMandateValue(mutation.request.responsibility, await mandateResponsibilityReference(responsibility))) throw new DomainError('RESPONSIBILITY_CHANGED', 409, 'The exact current responsibility and organization are required.');
        const prior = loaded.documents.filter(row => row.id === mutation.request.command.documentId).sort((a, b) => b.version - a.version)[0];
        if (prior && prior.site_id !== responsibility.siteId) throw new DomainError('POLICY_DOCUMENT_CHANGED', 409, 'This document belongs to a different responsibility site.');
        document = await createPolicyDocumentVersion({ actor: context.reader.actor, now: context.now }, mutation.request.command, prior?.body ?? null);
      } else if (mutation.kind === 'propose') {
        const previous = loaded.source.proposals.filter(row => row.id === mutation.command.proposalId).sort((a, b) => b.version - a.version)[0] ?? null;
        const previousDecision = previous ? loaded.source.decisions.filter(row => equalMandateValue(row.proposal, mandateReference(previous))).sort((a, b) => b.version - a.version)[0]! : null;
        const plan = await createMandateProposal({ ...current, actor: context.reader.actor, operationId, previousProposal: previous, previousDecision }, mutation.command);
        proposal = plan.proposal; decisions = [plan.decision, ...(plan.supersededDecision ? [plan.supersededDecision] : [])];
        proposalExpiresAt = previous ? (Date.parse(previous.expiresAt) < Date.parse(proposal.expiresAt) ? previous.expiresAt : proposal.expiresAt) : proposal.expiresAt;
        authorityExpiresAt = proposal.policy.expiresAt;
      } else if (mutation.kind === 'decide') {
        const selected = loaded.source.proposals.find(row => equalMandateValue(mandateReference(row), mutation.intent.proposal)); if (!selected) notFound();
        const decision = loaded.source.decisions.filter(row => equalMandateValue(row.proposal, mutation.intent.proposal)).sort((a, b) => b.version - a.version)[0]; if (!decision) invalid();
        const plan = await decideMandateProposal({ ...current, actor: context.reader.actor, requester: requesterFor(selected.requesterId), stepUp: verified.proof,
          receiptId: crypto.randomUUID(), operationId }, selected, decision, mutation.intent);
        decisions = [plan.decision]; accepted = plan.authorityChange?.acceptedVersion ?? null; head = plan.authorityChange?.head ?? null;
        proposalExpiresAt = selected.expiresAt; authorityExpiresAt = selected.policy.expiresAt;
        if (head) history = { head, previousHead: selected.expectedHead, action: 'AUTHORIZE', actorId: context.reader.actor.actorId, occurredAt: context.now, operationId, intent: null, evidence: verified.proof };
      } else {
        const selectedDecision = loaded.source.decisions.find(row => current.acceptedVersion && row.authorization?.acceptedVersion.id === current.acceptedVersion.id && row.authorization.acceptedVersion.version === current.acceptedVersion.version) ?? null;
        const selected = selectedDecision ? loaded.source.proposals.find(row => equalMandateValue(mandateReference(row), selectedDecision.proposal)) ?? null : null;
        const plan = await changeMandateAuthority({ ...current, actor: context.reader.actor, requester: mutation.intent.action === 'RESUME' && selected ? requesterFor(selected.requesterId) : null,
          stepUp: verified.proof, acceptedProposal: selected, acceptedDecision: selectedDecision, operationId }, mutation.intent);
        head = plan.head; authorityExpiresAt = head.expiresAt;
        history = { head, previousHead: mutation.intent.head, action: mutation.intent.action, actorId: plan.actorId, occurredAt: plan.occurredAt, operationId, intent: mutation.intent, evidence: plan.stepUp };
      }
      const target: MandateOperationResult['target'] = document ? { kind: 'document', ...mandateReference(document) } : proposal ? { kind: 'proposal', ...mandateReference(proposal) }
        : mutation.kind === 'decide' ? { kind: 'decision', id: mutation.proposalId, version: decisions[0]!.version, hash: await commandDigest(decisions[0]) }
        : { kind: 'authority', id: head!.mandateId, version: head!.mandateEpoch, hash: await commandDigest(head) };
      const result = MandateOperationResultSchema.parse({ schemaVersion: 1, organizationId: context.organizationId, responsibilityId, kind, target, commandHash, intentHash, observedAt: context.now,
        operation: { id: operationId, environment: this.environment, status: 'succeeded', aggregateId: target.id, aggregateVersion: target.version, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } });
      const effect = { identity, evidence, requesterObservation, kind, responsibilityId, responsibilitySnapshot: responsibility, organizationEpoch: context.organizationEpoch,
        command, intentHash, nonce: requestNonce, requestHash: verified.requestHash, operationId, key, commandHash, proposalExpiresAt, authorityExpiresAt };
      await client.query("SELECT pg_catalog.set_config('pactwoven.mandate_effect',$1,true)", [JSON.stringify(effect)]);
      const scope = [this.environment, context.organizationId, responsibilityId, responsibility.siteId];
      await client.query('INSERT INTO pactwoven.mandate_operations(environment,organization_id,responsibility_id,site_id,id,actor_id,kind,idempotency_key,command_hash,command,result,identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb)',
        [...scope, operationId, context.reader.actor.actorId, kind, key, commandHash, JSON.stringify(command), JSON.stringify(result), JSON.stringify(identity)]);
      if (document) await client.query('INSERT INTO pactwoven.mandate_policy_documents(environment,organization_id,responsibility_id,site_id,id,version,hash,body,operation_id,responsibility_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)', [...scope, document.id, document.version, document.hash, JSON.stringify(document), operationId, responsibility.version]);
      if (proposal) await client.query('INSERT INTO pactwoven.mandate_proposals(environment,organization_id,responsibility_id,site_id,id,version,hash,mandate_id,requester_id,requester_identity,body,operation_id,responsibility_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)',
        [...scope, proposal.id, proposal.version, proposal.hash, proposal.mandateId, proposal.requesterId, JSON.stringify(identity), JSON.stringify(proposal), operationId, responsibility.version]);
      for (const decision of decisions) await client.query('INSERT INTO pactwoven.mandate_decisions(environment,organization_id,responsibility_id,site_id,proposal_id,proposal_version,version,body,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
        [...scope, decision.proposal.id, decision.proposal.version, decision.version, JSON.stringify(decision), operationId]);
      if (accepted) await client.query('INSERT INTO pactwoven.mandate_versions(environment,organization_id,responsibility_id,site_id,id,version,proposal_id,proposal_version,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
        [...scope, accepted.id, accepted.version, decisions[0]!.proposal.id, decisions[0]!.proposal.version, JSON.stringify(accepted)]);
      if (head) {
        if (current.head) await client.query('UPDATE pactwoven.mandate_heads SET body=$1::jsonb WHERE environment=$2 AND organization_id=$3 AND responsibility_id=$4 AND id=$5', [JSON.stringify(head), this.environment, context.organizationId, responsibilityId, head.mandateId]);
        else await client.query('INSERT INTO pactwoven.mandate_heads(environment,organization_id,responsibility_id,id,body) VALUES($1,$2,$3,$4,$5::jsonb)', [this.environment, context.organizationId, responsibilityId, head.mandateId, JSON.stringify(head)]);
      }
      const audit = auditSchema.parse({ schemaVersion: 1, operationId, kind, actorId: context.reader.actor.actorId, identity, evidence, requestNonce,
        requestHash: verified.requestHash, requesterObservation, commandHash, intentHash, occurredAt: context.now, history });
      await client.query('INSERT INTO pactwoven.mandate_audit(environment,organization_id,responsibility_id,site_id,id,operation_id,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [...scope, crypto.randomUUID(), operationId, JSON.stringify(audit)]);
      await client.query('INSERT INTO pactwoven.mandate_outbox(environment,organization_id,responsibility_id,site_id,id,operation_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
        [...scope, crypto.randomUUID(), operationId, kind, JSON.stringify({ schemaVersion: 1, operationId, kind, responsibilityId, target })]);
      context = await this.context(client, identity, responsibilityId, true, trace);
      loaded = await this.load(client, context);
      await projectMandateRead(loaded.source);
      return result;
    });
  }
}
