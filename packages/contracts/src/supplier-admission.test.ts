import { describe, expect, it } from 'vitest';
import { AccessRoleSchema } from './access';
import {
  SupplierAdmissionContextRequestSchema, SupplierAdmissionContextSchema, SupplierAdmissionObservationSchema,
  SupplierEnrollmentReviewRequestSchema, SupplierEnrollmentCommandSchema, SupplierEnrollmentRecoveryRequestSchema,
  SupplierEnrollmentRecoveryResponseSchema, SupplierEnrollmentCommandResponseSchema, SupplierAdministratorGrantRecordSchema,
  supplierAdmissionLimitations, supplierEnrollmentReviewDigest, supplierEnrollmentPublicRequestDigest, supplierAdministratorGrantDigest,
  parseSupplierAdmissionContext, parseSupplierEnrollmentReview, parseSupplierEnrollmentRecovery, parseSupplierEnrollmentCommandResponse,
  type SupplierAdministratorGrantRecord,
} from './supplier-admission';

const now = '2026-11-17T18:00:00.000Z', hash = 'a'.repeat(64);
const later = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
const candidate = { id: 'candidate', version: 1, hash };
const member = { actorId: 'owner', membershipId: 'member', membershipVersion: 1 };
const basis = () => ({ environment: 'development' as const, organization: { id: 'supplier', version: 1, authorityEpoch: 0 },
  issuer: { ...member }, target: { candidate: { ...candidate }, member: { ...member } }, previousGrant: null,
  observation: { observedAt: now, expiresAt: later(20_000) } });
const material = () => ({ schemaVersion: 1 as const, role: 'supplier_admin' as const,
  selection: { action: 'grant' as const, candidate: { ...candidate }, expiresAt: later(86_400_000) },
  basis: basis(), targetDisplayName: 'Current owner', previousGrant: null });
async function fixture() {
  const selected = material(), reviewHash = await supplierEnrollmentReviewDigest(selected);
  const mutation = { idempotencyKey: 'supplier_enroll_original_001', command: {
    schemaVersion: 1 as const, role: 'supplier_admin' as const, selection: selected.selection, basis: selected.basis, reviewHash,
  } };
  const identity = { environment: 'development' as const, organizationId: 'supplier', actorId: 'owner', idempotencyKey: mutation.idempotencyKey };
  const publicRequestHash = await supplierEnrollmentPublicRequestDigest(mutation);
  const record: SupplierAdministratorGrantRecord = { schemaVersion: 1, id: 'grant', environment: 'development', organizationId: 'supplier',
    role: 'supplier_admin', version: 1, predecessor: null, action: 'grant', status: 'ACTIVE',
    target: { ...member, membershipVersion: 2 }, issuer: { ...member }, organizationVersion: 2, authorityEpoch: 1,
    issuedAt: later(1000), validFrom: later(1000), expiresAt: selected.selection.expiresAt };
  const result = { record, reference: { id: record.id, version: record.version, hash: await supplierAdministratorGrantDigest(record) } };
  const request = { identity, action: 'grant' as const, target: selected.basis.target, previousGrant: null, publicRequestHash };
  const receipt = { identity, action: 'grant' as const, publicRequestHash, result, recordedAt: record.issuedAt };
  const recovery = { kind: 'SUPPLIER_ENROLLMENT_RECOVERY' as const, status: 'RECORDED' as const, request,
    observation: { observedAt: later(5000), expiresAt: later(25_000) }, current: { status: 'AVAILABLE' as const, grant: result },
    limitations: supplierAdmissionLimitations, original: { exactPublicMutation: mutation, receipt } };
  return { selected, mutation, request, result, receipt, recovery,
    review: { kind: 'SUPPLIER_ENROLLMENT_REVIEW' as const, material: selected, reviewHash,
      state: 'REVIEWABLE' as const, blockers: [], limitations: supplierAdmissionLimitations } };
}

describe('bounded supplier enrollment contracts', () => {
  it('keeps generic access unchanged and rejects invented body authority at every nested boundary', async () => {
    const { mutation } = await fixture();
    expect(AccessRoleSchema.safeParse('supplier_admin').success).toBe(false);
    expect(SupplierAdmissionContextRequestSchema.safeParse({}).success).toBe(true);
    for (const extra of [{ role: 'supplier_admin' }, { environment: 'production' }, { actorId: 'owner' }, { verified: true }])
      expect(SupplierAdmissionContextRequestSchema.safeParse(extra).success).toBe(false);
    for (const extra of [{ idempotencyKey: 'second_key_supplied' }, { factors: {} }, { sessionId: 'session' },
      { verified: true }, { purpose: 'supplier_administrator_enrollment' }, { roles: ['owner'] }])
      expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, ...extra }).success).toBe(false);
    expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, basis: { ...basis(), subject: 'provider_subject' } }).success).toBe(false);
    expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, basis: { ...basis(), target: {
      ...basis().target, externalMembershipId: 'provider_member',
    } } }).success).toBe(false);
    expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, role: 'owner' }).success).toBe(false);
  });
  it('bounds original observations, identity columns and encoded request bytes', async () => {
    const { mutation } = await fixture();
    for (const interval of [1, 19_999, 20_000])
      expect(SupplierAdmissionObservationSchema.safeParse({ observedAt: now, expiresAt: later(interval) }).success).toBe(true);
    for (const interval of [-1, 0, 20_001])
      expect(SupplierAdmissionObservationSchema.safeParse({ observedAt: now, expiresAt: later(interval) }).success).toBe(false);
    for (const invalid of [0, 1.5, 2_147_483_648, Number.POSITIVE_INFINITY]) {
      expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, basis: { ...basis(), issuer: { ...member, membershipVersion: invalid } } }).success).toBe(false);
      expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, basis: { ...basis(), organization: { ...basis().organization, version: invalid } } }).success).toBe(false);
    }
    expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, basis: { ...basis(), organization: { ...basis().organization, authorityEpoch: 2_147_483_648 } } }).success).toBe(false);
    expect(SupplierEnrollmentReviewRequestSchema.safeParse({ schemaVersion: 1, selection: { ...material().selection, candidate: {
      ...candidate, id: '界'.repeat(5000),
    } } }).success).toBe(false);
  });
  it('distinguishes first candidate, existing member, renewal and revocation without arbitrary role edits', async () => {
    const { mutation, result } = await fixture();
    expect(SupplierEnrollmentCommandSchema.safeParse(mutation.command).success).toBe(true);
    expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, basis: { ...basis(), target: { candidate, member: null } } }).success).toBe(true);
    for (const action of ['renew', 'revoke'] as const) {
      const selection = action === 'revoke' ? { action, grant: result.reference } : { action, grant: result.reference, expiresAt: later(1000) };
      const command = { ...mutation.command, selection, basis: { ...basis(), previousGrant: result.reference } };
      expect(SupplierEnrollmentCommandSchema.safeParse(command).success).toBe(true);
      expect(SupplierEnrollmentCommandSchema.safeParse({ ...command, basis: basis() }).success).toBe(false);
      expect(SupplierEnrollmentCommandSchema.safeParse({ ...command, basis: { ...command.basis, target: { candidate, member: null } } }).success).toBe(false);
    }
    expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, basis: { ...basis(), previousGrant: result.reference } }).success).toBe(false);
    expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, selection: { ...mutation.command.selection, candidate: { ...candidate, hash: 'b'.repeat(64) } } }).success).toBe(false);
    for (const expiresAt of [now, later(2_592_000_001)])
      expect(SupplierEnrollmentCommandSchema.safeParse({ ...mutation.command, selection: { ...mutation.command.selection, expiresAt } }).success).toBe(false);
  });
  it('requires matching review hashes and the exact requested selection without provider disclosure', async () => {
    const { review } = await fixture(), request = { schemaVersion: 1, selection: review.material.selection };
    expect(await parseSupplierEnrollmentReview(review, request)).toEqual(review);
    await expect(parseSupplierEnrollmentReview({ ...review, material: { ...review.material, targetDisplayName: 'Different target' } }, request)).rejects.toThrow('hash mismatch');
    await expect(parseSupplierEnrollmentReview(review, { ...request, selection: { ...request.selection, expiresAt: later(2000) } })).rejects.toThrow('selection mismatch');
    await expect(parseSupplierEnrollmentReview({ ...review, material: { ...review.material, subject: 'private' } }, request)).rejects.toThrow();
    await expect(parseSupplierEnrollmentReview({ ...review, blockers: ['OWNER_REQUIRED'] }, request)).rejects.toThrow();
    await expect(parseSupplierEnrollmentReview({ ...review, limitations: { ...supplierAdmissionLimitations, paymentAuthority: true } }, request)).rejects.toThrow();
  });
  it('requires a finite exact grant for current supplier context and clips observation to expiry', async () => {
    const { result } = await fixture();
    const context = { schemaVersion: 1, kind: 'SUPPLIER_ADMISSION_CONTEXT', environment: 'development', party: 'supplier',
      organization: { id: 'supplier', version: 2, authorityEpoch: 1, name: 'Supplier organization', status: 'ACTIVE' }, viewer: result.record.target,
      administration: { owner: true, supplierAdministrator: true, grant: result }, enrollment: { state: 'REVIEWABLE', blockers: [] },
      observation: { observedAt: later(2000), expiresAt: later(22_000) }, limitations: supplierAdmissionLimitations };
    expect(await parseSupplierAdmissionContext(context)).toEqual(context);
    const shortRecord = { ...result.record, expiresAt: later(3000) };
    const short = { record: shortRecord, reference: { ...result.reference, hash: await supplierAdministratorGrantDigest(shortRecord) } };
    expect(SupplierAdmissionContextSchema.safeParse({ ...context, administration: { ...context.administration, grant: short } }).success).toBe(false);
    expect(SupplierAdmissionContextSchema.safeParse({ ...context, administration: { ...context.administration, grant: short }, observation: { ...context.observation, expiresAt: later(3000) } }).success).toBe(true);
    for (const change of [{ grant: null }, { grant: { ...result, record: { ...result.record, organizationId: 'other' } } }])
      expect(SupplierAdmissionContextSchema.safeParse({ ...context, administration: { ...context.administration, ...change } }).success).toBe(false);
    expect(SupplierAdmissionContextSchema.safeParse({ ...context, party: 'buyer' }).success).toBe(false);
    expect(SupplierAdmissionContextSchema.safeParse({ ...context, administration: { ...context.administration, owner: false } }).success).toBe(false);
  });
  it('retains finite grant history and rejects invented predecessors or provider stamps', async () => {
    const { result } = await fixture();
    for (const change of [{ role: 'owner' }, { version: 2 }, { expiresAt: result.record.validFrom }, { issuer: { ...member, subject: 'private' } },
      { status: 'REVOKED' }, { validFrom: now }, { expiresAt: later(2_592_001_001) }])
      expect(SupplierAdministratorGrantRecordSchema.safeParse({ ...result.record, ...change }).success).toBe(false);
    expect(SupplierAdministratorGrantRecordSchema.safeParse({ ...result.record, version: 2, predecessor: result.reference,
      action: 'revoke', status: 'REVOKED', expiresAt: result.record.validFrom }).success).toBe(true);
  });
  it('rejects correctly hashed grant organization or epoch stamps ahead of the current context', async () => {
    const { result } = await fixture();
    for (const change of [{ organizationVersion: 3 }, { authorityEpoch: 2 }, { organizationVersion: 3, authorityEpoch: 2 }]) {
      const record = { ...result.record, ...change };
      const grant = { record, reference: { ...result.reference, hash: await supplierAdministratorGrantDigest(record) } };
      const context = { schemaVersion: 1, kind: 'SUPPLIER_ADMISSION_CONTEXT', environment: 'development', party: 'supplier',
        organization: { id: 'supplier', version: 2, authorityEpoch: 1, name: 'Supplier', status: 'ACTIVE' }, viewer: result.record.target,
        administration: { owner: true, supplierAdministrator: true, grant }, enrollment: { state: 'REVIEWABLE', blockers: [] },
        observation: { observedAt: later(2000), expiresAt: later(22_000) }, limitations: supplierAdmissionLimitations };
      await expect(parseSupplierAdmissionContext(context)).rejects.toThrow();
    }
  });
  it('recovers exact originals and rejects changed selectors, hashes, scope, fences and source bytes', async () => {
    const { recovery, request } = await fixture();
    expect(await parseSupplierEnrollmentRecovery(recovery, request)).toEqual(recovery);
    await expect(parseSupplierEnrollmentRecovery(recovery, { ...request, identity: { ...request.identity, idempotencyKey: 'different_original_key' } })).rejects.toThrow('request mismatch');
    for (const change of [
      { publicRequestHash: hash }, { identity: { ...request.identity, actorId: 'other' } },
      { target: { ...request.target, candidate: { ...candidate, version: 2 } } },
    ]) await expect(parseSupplierEnrollmentRecovery({ ...recovery, request: { ...request, ...change } }, { ...request, ...change })).rejects.toThrow();
    const original = recovery.original;
    await expect(parseSupplierEnrollmentRecovery({ ...recovery, original: { ...original, exactPublicMutation: {
      ...original.exactPublicMutation, command: { ...original.exactPublicMutation.command, reviewHash: hash },
    } } }, request)).rejects.toThrow('request hash mismatch');
    for (const change of [{ organizationVersion: 1 }, { authorityEpoch: 0 }, { expiresAt: later(1000) },
      { target: { ...original.receipt.result.record.target, membershipVersion: 1 } }, { issuer: { ...member, actorId: 'other' } }]) {
      const badResult = { ...original.receipt.result, record: { ...original.receipt.result.record, ...change } };
      expect(SupplierEnrollmentRecoveryResponseSchema.safeParse({ ...recovery, original: { ...original, receipt: { ...original.receipt, result: badResult } } }).success).toBe(false);
    }
    const corrupted = { ...original.receipt.result, reference: { ...original.receipt.result.reference, hash } };
    await expect(parseSupplierEnrollmentRecovery({ ...recovery, current: { status: 'AVAILABLE', grant: corrupted },
      original: { ...original, receipt: { ...original.receipt, result: corrupted } } }, request)).rejects.toThrow('grant hash mismatch');
  });
  it('keeps NOT_RECORDED, unavailable current state and historical revoked state separate', async () => {
    const { recovery, request, result } = await fixture();
    const absent = { ...recovery, status: 'NOT_RECORDED', original: null, current: { status: 'UNAVAILABLE', grant: null } };
    expect(await parseSupplierEnrollmentRecovery(absent, request)).toEqual(absent);
    expect(SupplierEnrollmentRecoveryResponseSchema.safeParse({ ...absent, status: 'CLOSED' }).success).toBe(false);
    expect(SupplierEnrollmentRecoveryResponseSchema.safeParse({ ...absent, current: { status: 'UNAVAILABLE', grant: result } }).success).toBe(false);
    expect(SupplierEnrollmentRecoveryRequestSchema.safeParse({ ...request, cancel: true }).success).toBe(false);
    const stoppedRecord: SupplierAdministratorGrantRecord = { ...result.record, version: 2, predecessor: result.reference,
      action: 'revoke', status: 'REVOKED', target: { ...result.record.target, membershipVersion: 3 },
      organizationVersion: 3, authorityEpoch: 2, issuedAt: later(4000), validFrom: later(4000), expiresAt: later(4000) };
    const stopped = { record: stoppedRecord, reference: { id: 'grant', version: 2, hash: await supplierAdministratorGrantDigest(stoppedRecord) } };
    const historical = await parseSupplierEnrollmentRecovery({ ...recovery, current: { status: 'AVAILABLE', grant: stopped } }, request);
    expect(historical.original?.receipt.result.record.status).toBe('ACTIVE');
    expect(historical.current.grant?.record.status).toBe('REVOKED');
  });
  it('does not interchange reads and command receipts or let APPENDED paint a historical result', async () => {
    const { recovery, mutation } = await fixture();
    const { status: _status, ...rest } = recovery;
    const response = { ...rest, kind: 'SUPPLIER_ENROLLMENT_COMMAND', outcome: 'APPENDED' };
    expect(await parseSupplierEnrollmentCommandResponse(response, mutation)).toEqual(response);
    expect(SupplierEnrollmentCommandResponseSchema.safeParse(recovery).success).toBe(false);
    expect(SupplierEnrollmentRecoveryResponseSchema.safeParse(response).success).toBe(false);
    expect(SupplierEnrollmentCommandResponseSchema.safeParse({ ...response, current: { status: 'UNAVAILABLE', grant: null } }).success).toBe(false);
    expect(SupplierEnrollmentCommandResponseSchema.safeParse({ ...response, outcome: 'EXACT_REPLAY', current: { status: 'UNAVAILABLE', grant: null } }).success).toBe(true);
    await expect(parseSupplierEnrollmentCommandResponse(response, { ...mutation, idempotencyKey: 'other_original_key_001' })).rejects.toThrow('response mismatch');
  });
  it('rejects correctly hashed current successors that reuse or regress identity fences or issue time', async () => {
    const { recovery, request, result } = await fixture();
    const successor: SupplierAdministratorGrantRecord = { ...result.record, version: 2, predecessor: result.reference,
      action: 'renew', target: { ...result.record.target, membershipVersion: 3 }, organizationVersion: 3, authorityEpoch: 2,
      issuedAt: later(4000), validFrom: later(4000) };
    const changed = [
      { target: { ...successor.target, membershipVersion: 2 } },
      { target: { ...successor.target, membershipVersion: 1 } },
      { organizationVersion: 2 }, { organizationVersion: 1 }, { authorityEpoch: 1 }, { authorityEpoch: 0 },
      { issuedAt: now, validFrom: now },
    ];
    for (const change of changed) {
      const record = { ...successor, ...change };
      const current = { status: 'AVAILABLE', grant: { record, reference: { id: 'grant', version: 2, hash: await supplierAdministratorGrantDigest(record) } } };
      await expect(parseSupplierEnrollmentRecovery({ ...recovery, current }, request)).rejects.toThrow();
    }
    // Two commits may share millisecond precision. A gap permits only monotonic
    // consistency checking; these two snapshots do not prove the missing chain.
    for (const version of [2, 3]) {
      const record = { ...successor, version, predecessor: version === 2 ? result.reference : { id: 'grant', version: 2, hash },
        target: { ...successor.target, membershipVersion: result.record.target.membershipVersion + version - 1 },
        organizationVersion: result.record.organizationVersion + version - 1, authorityEpoch: result.record.authorityEpoch + version - 1,
        issuedAt: result.record.issuedAt, validFrom: result.record.validFrom };
      const current = { status: 'AVAILABLE', grant: { record, reference: { id: 'grant', version, hash: await supplierAdministratorGrantDigest(record) } } };
      await expect(parseSupplierEnrollmentRecovery({ ...recovery, current }, request)).resolves.toMatchObject({ current });
    }
  });
  it('requires enough identity-fence advances for every skipped grant version without proving missing history', async () => {
    const { recovery, request, result } = await fixture();
    const valid: SupplierAdministratorGrantRecord = { ...result.record, version: 3, predecessor: { id: 'grant', version: 2, hash },
      action: 'renew', target: { ...result.record.target, membershipVersion: 4 }, organizationVersion: 4, authorityEpoch: 3,
      issuedAt: later(4000), validFrom: later(4000) };
    for (const change of [
      { target: { ...valid.target, membershipVersion: 3 } }, { organizationVersion: 3 }, { authorityEpoch: 2 },
      { target: { ...valid.target, membershipVersion: 3 }, organizationVersion: 3, authorityEpoch: 2 },
    ]) {
      const record = { ...valid, ...change };
      const current = { status: 'AVAILABLE', grant: { record, reference: { id: 'grant', version: 3, hash: await supplierAdministratorGrantDigest(record) } } };
      await expect(parseSupplierEnrollmentRecovery({ ...recovery, current }, request)).rejects.toThrow();
    }
    const current = { status: 'AVAILABLE', grant: { record: valid, reference: { id: 'grant', version: 3, hash: await supplierAdministratorGrantDigest(valid) } } };
    await expect(parseSupplierEnrollmentRecovery({ ...recovery, current }, request)).resolves.toMatchObject({ current });
  });
});
