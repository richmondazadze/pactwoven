import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { FINANCE_DEVNET_ASSET, CustodySetupSpecificationSchema, type CustodyRecord, type CustodyResult } from '@pactwoven/contracts';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { createCustodyAttempt, custodyRecordRef, custodyRecordDigest, custodySpecificationDigest, custodyPrivateCommandDigest, custodyChallengeBytes, custodyBytesHash, custodyBase64, qualifyCustodyMutation, qualifyCustodyRecovery, qualifyCustodyRead, custodyVisibleIdentity, custodyVisibleResultMatches, verifyCustodyAttempt, type CustodyBasis, type CustodyScope, type CustodyAttempt, type CustodyRequest } from './custody-setup-contract';

// Fixed synthetic bytes and IDs only. No keys/signatures are generated or verified,
// and these fixtures establish no deployment, wallet ownership or financial authority.
const at = Date.parse('2026-11-15T12:00:00.000Z'), hash = 'a'.repeat(64), iso = (n: number) => new Date(n).toISOString(), uuid = (n: number) => `123e4567-e89b-12d3-a456-${String(n).padStart(12, '0')}`, ref = (id: string) => ({ id, version: 1, recordHash: hash });
async function fixture() {
  const owner = { actorId: 'owner_a', membershipVersion: 1, subject: 'user_a', externalMembershipId: 'member_a', sessionId: 'session_a' };
  const scope: CustodyScope = { environment: 'development', apiBase: 'https://api.example.test', userId: 'user_a', externalOrganizationId: 'provider_org', organizationId: 'org_a', responsibilityId: 'responsibility_a', owner };
  const authority = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const program = '5UaivPxV8oQypy5mxmQCzvZXHVSMkPsZ2TKJvszyebVG', wallet = '6nCoQdJQFYiz4s8JY3d5oZb38hBrTJayvxk5xib9SvDs';
  const specification = CustodySetupSpecificationSchema.parse({ schemaVersion: 1, purpose: 'INITIALIZE_EMPTY_CUSTODY', environment: 'development', id: 'spec_a', version: 1, predecessor: null, organization: { id: 'org_a', registrationUuid: uuid(1), authorityEpoch: 0 }, responsibility: { ...authority.responsibility, registrationUuid: uuid(2) }, site: { id: 'site_a', generation: 0, recordHash: hash, active: true }, authority: { snapshot: authority, recordHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: authority }) }, owner, ownerWalletPublicKey: wallet,
    program: { id: program, loader: 'BPFLoaderUpgradeab1e11111111111111111111111', programData: program, deploymentSlot: '1', sourceHash: hash, binaryHash: hash, idlHash: hash, clientHash: hash, buildManifestHash: hash, upgradePolicy: ref('upgrade_a') }, config: { address: wallet, recordHash: hash, setupIntentHash: hash, observation: ref('config_a') }, asset: { ...FINANCE_DEVNET_ASSET, decimals: 6, key: '34ee730cf90d3d55ea2d34e911aa4ad941aafb29668bf4056cfa88c6cf0492e4', registryVersion: 1, registryRecordHash: hash, controlGeneration: 0, controlHash: hash }, registrationAddress: 'Gj3xg9vE2DWPFeSJo5tJqxn88mz8Zmo5ovCbYXhGhK4F', vaultAddress: 'ea7H8kdpttXwcbZLJ9d7CR5VhJY1ZTD24MwYeFkJpEk', registrar: program, rentPayer: program, setupOperationKey: hash,
    transactionPolicy: { reference: ref('policy_a'), instructionPlanHash: hash, maximumFeeLamports: '1000', maximumRentLamports: '1000', maximumFaucetLamports: '0', maximumTotalLamports: '2000' }, issuedAt: iso(at - 1000), expiresAt: iso(at + 120000) });
  const specificationRef = { id: specification.id, version: 1, recordHash: await custodySpecificationDigest(specification) }, setupId = uuid(3);
  let basis: CustodyBasis = { specification, draft: null, prepareOperation: null, challenge: null, confirmation: null, binding: null, controlGeneration: 0, state: null };
  const common = (n: number) => ({ schemaVersion: 1 as const, id: uuid(n), setupId, version: 1, environment: 'development' as const, organizationId: scope.organizationId, responsibilityId: scope.responsibilityId, actorId: owner.actorId, issuedAt: iso(at), expiresAt: iso(at + 60000) });
  async function operation(attempt: CustodyAttempt, record: CustodyRecord, id: string, privateCommand?: unknown): Promise<CustodyResult> { return { schemaVersion: 1, id, organizationId: scope.organizationId, actorId: owner.actorId, responsibilityId: scope.responsibilityId, kind: attempt.request.kind, key: attempt.request.body.key, setupId, commandHash: privateCommand ? await custodyPrivateCommandDigest(scope, privateCommand) : attempt.locator.pins.expectedCommandHash!, target: await custodyRecordRef(record), body: record, financialState: null }; }
  const prepare: CustodyRequest = { kind: 'prepare', responsibilityId: scope.responsibilityId, setupId: null, body: { schemaVersion: 1, key: 'prepare_original_001', reviewedSpecificationRef: specificationRef, ownerWalletPublicKey: wallet, expectedScope: { responsibilityVersion: 1, responsibilityHash: hash, siteGeneration: 0, siteRecordHash: hash, canonicalGeneration: 0, canonicalHash: specification.authority.recordHash }, previousDraft: null } };
  const p = await createCustodyAttempt(scope, prepare, basis, 'draft_ui_a', at), draft: CustodyRecord = { ...common(4), kind: 'draft', specification: specificationRef, specificationControlGeneration: 0, predecessor: null, prepareOperationId: uuid(5) }, pr = await operation(p, draft, uuid(5));
  basis = { ...basis, draft, prepareOperation: { id: pr.id, key: pr.key, commandHash: pr.commandHash }, state: 'pending' }; const expected = { schemaVersion: 1 as const, expectedSetupVersion: 1, expectedSetupHash: pr.target.recordHash };
  const c = await createCustodyAttempt(scope, { kind: 'challenge', responsibilityId: scope.responsibilityId, setupId, body: { ...expected, key: 'challenge_original_001' } }, basis, 'draft_ui_a', at), challenge: CustodyRecord = { ...common(6), kind: 'wallet_challenge', specification: specificationRef, draft: pr.target, owner, wallet, organizationRegistrationUuid: specification.organization.registrationUuid, responsibilityRegistrationUuid: specification.responsibility.registrationUuid, setupOperationKey: specification.setupOperationKey, nonce: 'A'.repeat(43) }, cr = await operation(c, challenge, uuid(7));
  basis = { ...basis, challenge }; const signature = 'A'.repeat(86) + '==', signatureHash = createHash('sha256').update(new Uint8Array(64)).digest('hex');
  const f = await createCustodyAttempt(scope, { kind: 'confirmation', responsibilityId: scope.responsibilityId, setupId, body: { ...expected, key: 'confirmation_original_001', confirmationKey: 'confirm_original_001', challengeId: challenge.id, challengeHash: cr.target.recordHash, walletSignature: signature } }, basis, 'draft_ui_a', at);
  const intent = { schemaVersion: 1 as const, purpose: 'custody_setup_owner_binding' as const, environment: 'development' as const, organizationId: scope.organizationId, responsibilityId: scope.responsibilityId, setupId, specification: specificationRef, challenge: cr.target, signatureHash, owner, key: 'confirm_original_001', nonce: 'B'.repeat(42) + 'A' };
  const confirmation: CustodyRecord = { ...common(8), kind: 'confirmation', draft: pr.target, walletEvidence: ref(uuid(9)), intent, intentHash: await commandDigest(intent), requestHash: await commandDigest({ schemaVersion: 1, purpose: 'custody_setup_owner_binding', request: { nonce: intent.nonce, key: intent.key, intent } }) };
  const fr = await operation(f, confirmation, uuid(10), { ...expected, schemaVersion: 1, kind: 'confirmation', responsibilityId: scope.responsibilityId, setupId, key: 'confirmation_original_001', confirmationKey: intent.key, challengeId: challenge.id, challengeHash: cr.target.recordHash, walletEvidenceId: confirmation.walletEvidence.id });
  basis = { ...basis, confirmation }; const b = await createCustodyAttempt(scope, { kind: 'confirm', responsibilityId: scope.responsibilityId, setupId, body: { ...expected, key: intent.key, challengeId: challenge.id, challengeHash: cr.target.recordHash, walletSignature: signature, confirmationId: confirmation.id, confirmationNonce: intent.nonce } }, basis, 'draft_ui_a', at);
  const confirmHash = await custodyPrivateCommandDigest(scope, { ...expected, kind: 'confirm', responsibilityId: scope.responsibilityId, setupId, key: intent.key, confirmationId: confirmation.id, confirmationNonce: intent.nonce, mfaEvidenceId: uuid(11) });
  const binding: CustodyRecord = { ...common(12), kind: 'owner_binding', purpose: 'INITIALIZE_EMPTY_CUSTODY', specification, specificationRef, specificationControlGeneration: 0, draft: pr.target, challenge: cr.target, confirmation: fr.target, identityEvidence: ref(uuid(13)), walletEvidence: confirmation.walletEvidence, mfaEvidence: ref(uuid(11)), signatureHash, prepareOperation: basis.prepareOperation!, confirmOperation: { id: uuid(14), key: intent.key, commandHash: confirmHash }, controlGeneration: 1 }, br: CustodyResult = { ...(await operation(b, binding, uuid(14))), commandHash: confirmHash };
  basis = { ...basis, binding, controlGeneration: 1, state: 'confirmed' }; const x = await createCustodyAttempt(scope, { kind: 'cancel', responsibilityId: scope.responsibilityId, setupId, body: { ...expected, key: 'cancel_original_001', expectedSetupControlGeneration: 1 } }, basis, 'draft_ui_a', at), cancellation: CustodyRecord = { ...common(15), kind: 'cancellation', draft: pr.target, previousControlGeneration: 1, controlGeneration: 2 }, xr = await operation(x, cancellation, uuid(16));
  const mutation = async (r: CustodyResult) => ({ schemaVersion: 1 as const, operation: r, review: r.kind === 'prepare' || r.kind === 'challenge' ? specification : null, message: r.body.kind === 'wallet_challenge' ? { bytes: custodyBase64(custodyChallengeBytes(r.body)), messageHash: await custodyBytesHash(custodyChallengeBytes(r.body)) } : null });
  const recovery = (r: CustodyResult | null, a: CustodyAttempt) => ({ schemaVersion: 1 as const, organizationId: scope.organizationId, actorId: owner.actorId, responsibilityId: scope.responsibilityId, kind: a.request.kind, key: a.request.body.key, status: r ? 'recorded' as const : 'not_recorded' as const, operation: r });
  const read = { schemaVersion: 1 as const, setup: { schemaVersion: 1 as const, setupId, draft, draftHash: pr.target.recordHash, controlGeneration: 1, state: 'confirmed' as const, binding }, review: specification }, target = { setupId, draft: pr.target, specification: specificationRef };
  return { scope, specification, basis, p, c, f, b, x, pr, cr, fr, br, xr, mutation, recovery, read, target };
}


import { createCustodyMemory, storeCustodyReference, assertCustodyReference, listCustodyReferences, custodyReferenceKey, settleCustodyReference, CUSTODY_REFERENCE_PREFIX } from './custody-setup-recovery';
function storage() { const values = new Map<string, string>(); return { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
describe('custody original recovery references', () => {
  it('persists only bounded references; signatures, nonce, session and wallet state remain private', async () => { const f = await fixture(), store = storage(), memory = createCustodyMemory(f.scope); await memory.retain(f.b); expect(store.length).toBe(0); storeCustodyReference(store, f.b.locator); const serialized = store.getItem(custodyReferenceKey(f.b.locator))!; for (const privateValue of [(f.b.request.body as any).walletSignature, (f.b.request.body as any).confirmationNonce, f.scope.owner.sessionId, f.specification.ownerWalletPublicKey, 'walletSignature', 'confirmationNonce', 'Bearer']) expect(serialized).not.toContain(privateValue); expect(listCustodyReferences(store, f.scope)).toEqual({ blocked: false, references: [f.b.locator] }); expect(memory.original(f.b.locator)).toEqual(f.b); const reloaded = createCustodyMemory({ ...f.scope, owner: { ...f.scope.owner, sessionId: 'reloaded_session' } }); expect(reloaded.original(f.b.locator)).toBeNull(); });
  it('retains independent kind/key originals and never overwrites changed same-key content', async () => { const f = await fixture(), store = storage(); storeCustodyReference(store, f.p.locator); storeCustodyReference(store, f.c.locator); const changed = { ...f.p.locator, requestHash: 'b'.repeat(64) }; expect(() => storeCustodyReference(store, changed)).toThrow(); expect(listCustodyReferences(store, f.scope).references).toEqual([f.p.locator, f.c.locator]); storeCustodyReference(store, f.p.locator); expect(store.length).toBe(2); });
  it('keeps readable originals beside corruption and storage failures', async () => { const f = await fixture(), store = storage(); storeCustodyReference(store, f.p.locator); store.setItem(CUSTODY_REFERENCE_PREFIX + 'broken', '{'); expect(listCustodyReferences(store, f.scope)).toEqual({ blocked: true, references: [f.p.locator] }); expect(listCustodyReferences(null, f.scope).blocked).toBe(true); expect(() => storeCustodyReference(null, f.p.locator)).toThrow(); const failing = { ...store, setItem() { throw new Error('storage secret'); } }; expect(() => storeCustodyReference(failing, f.c.locator)).toThrow('recovery storage needs attention'); expect(store.length).toBe(2); });
  it('rejects truncated readback and altered original without deleting it', async () => { const f = await fixture(), store = storage(), set = store.setItem; store.setItem = (key, value) => set(key, value.slice(0, -1)); expect(() => storeCustodyReference(store, f.p.locator)).toThrow(); expect(() => assertCustodyReference(store, f.p.locator)).toThrow(); expect(store.length).toBe(1); expect(listCustodyReferences(store, f.scope).blocked).toBe(true); });
  it('enforces total reference capacity without evicting unknown originals', async () => { const f = await fixture(), store = storage(); for (let i = 0; i < 64; i++) storeCustodyReference(store, { ...f.p.locator, key: `original_setup_key_${i}` }); expect(() => storeCustodyReference(store, f.c.locator)).toThrow(); expect(store.length).toBe(64); store.setItem(CUSTODY_REFERENCE_PREFIX + 'overflow', '{}'); expect(listCustodyReferences(store, f.scope).blocked).toBe(true); expect(store.length).toBe(65); });
  it('exact qualified settlement removes only its locator; missing result never settles', async () => { const f = await fixture(), store = storage(); storeCustodyReference(store, f.p.locator); storeCustodyReference(store, f.c.locator); await expect(settleCustodyReference(store, f.p.locator, f.cr)).rejects.toThrow(); expect(store.length).toBe(2); await settleCustodyReference(store, f.p.locator, f.pr, f.p); expect(listCustodyReferences(store, f.scope).references).toEqual([f.c.locator]); });
  it('pins a first recorded operation against substituted later result IDs', async () => { const f = await fixture(), memory = createCustodyMemory(f.scope); await memory.retain(f.p); await memory.record(f.p.locator, f.pr); const changed = structuredClone(f.pr); changed.id = uuid(91); if (changed.body.kind !== 'draft') throw new Error('draft'); changed.body.prepareOperationId = changed.id; changed.target.recordHash = await custodyRecordDigest(changed.body); await expect(memory.record(f.p.locator, changed)).rejects.toThrow(); expect(memory.recorded(f.p.locator)).toEqual(f.pr); });
  it('scope close purges private originals/results and rejects late retention while keeping durable refs', async () => { const f = await fixture(), memory = createCustodyMemory(f.scope), store = storage(); storeCustodyReference(store, f.b.locator); const pending = memory.retain(f.b); memory.close(); await expect(pending).rejects.toMatchObject({ code: 'scope' }); expect(() => memory.original(f.b.locator)).toThrow(); expect(listCustodyReferences(store, f.scope).references).toEqual([f.b.locator]); });
  it('rejects other actors, tenants and retained sessions without changing storage', async () => { const f = await fixture(), memory = createCustodyMemory(f.scope), store = storage(); storeCustodyReference(store, f.p.locator); await expect(memory.retain({ ...f.p, scope: { ...f.scope, owner: { ...f.scope.owner, sessionId: 'new_session' } } })).rejects.toThrow(); expect(() => memory.original({ ...f.p.locator, scope: { ...f.p.locator.scope, actorId: 'other_owner' } })).toThrow(); expect(listCustodyReferences(store, { ...f.scope, organizationId: 'other_org' }).references).toEqual([]); expect(store.length).toBe(1); });
});


describe('custody recorded locator regression', () => {
  it.each(['requestHash', 'draftIdentity', 'both'] as const)('rejects changed %s on inputless receipts without losing the first receipt', async field => {
    const f = await fixture(), memory = createCustodyMemory(f.scope);
    await memory.record(f.p.locator, f.pr);
    const changed = { ...f.p.locator, ...(field !== 'draftIdentity' ? { requestHash: 'b'.repeat(64) } : {}), ...(field !== 'requestHash' ? { draftIdentity: 'newer_draft' } : {}) };
    expect(memory.original(f.p.locator)).toBeNull();
    expect(() => memory.recorded(changed)).toThrow('recovery storage needs attention');
    await expect(memory.record(changed, f.pr)).rejects.toMatchObject({ code: 'storage' });
    expect(memory.recorded(f.p.locator)).toEqual(f.pr);
    await expect(memory.record(f.p.locator, f.pr)).resolves.toEqual(f.pr);
  });
  it('freezes the inputless receipt locator before waits and rejects a changed later retained original', async () => {
    const f = await fixture(), memory = createCustodyMemory(f.scope), locator = structuredClone(f.p.locator);
    const pending = memory.record(locator, f.pr); locator.draftIdentity = 'newer_draft';
    await pending;
    expect(memory.recorded(f.p.locator)).toEqual(f.pr);
    expect(() => memory.recorded(locator)).toThrow();
    const different = await createCustodyAttempt(f.scope, f.p.request, f.p.basis, 'newer_draft', at);
    await expect(memory.retain(different)).rejects.toMatchObject({ code: 'storage' });
    expect(memory.original(f.p.locator)).toBeNull(); expect(memory.recorded(f.p.locator)).toEqual(f.pr);
  });
});


describe('custody inputless receipt and original context reconciliation', () => {
  async function reconciliationFixture(kind: 'challenge' | 'confirm') {
    const f = await fixture(), original = kind === 'challenge' ? f.c : f.b, operation = kind === 'challenge' ? f.cr : f.br;
    const changed = structuredClone(operation);
    if (changed.body.kind === 'wallet_challenge') changed.body.wallet = f.specification.program.id;
    else if (changed.body.kind === 'owner_binding') { changed.commandHash = 'b'.repeat(64); changed.body.confirmOperation.commandHash = changed.commandHash; }
    else throw new Error('reconciliation fixture');
    changed.target.recordHash = await custodyRecordDigest(changed.body);
    const memory = createCustodyMemory(f.scope), store = storage(); storeCustodyReference(store, original.locator);
    return { ...f, original, operation, changed, memory, store };
  }
  it.each(['challenge', 'confirm'] as const)('refuses incompatible %s context after inputless recording while preserving the original lookup reference', async kind => {
    const f = await reconciliationFixture(kind);
    await f.memory.record(f.original.locator, f.changed);
    await expect(f.memory.retain(f.original)).rejects.toMatchObject({ code: 'unconfirmed' });
    expect(f.memory.original(f.original.locator)).toBeNull(); expect(f.memory.recorded(f.original.locator)).toEqual(f.changed);
    expect(listCustodyReferences(f.store, f.scope).references).toEqual([f.original.locator]);
    const historical = await qualifyCustodyRecovery(f.recovery(f.changed, f.original), f.original.locator, f.scope);
    expect(historical).toMatchObject({ historical: true, retainedRequest: false, permitsSigning: false });
    await expect(f.memory.record(f.original.locator, f.operation)).rejects.toMatchObject({ code: 'unconfirmed' });
    expect(f.memory.recorded(f.original.locator)).toEqual(f.changed);
  });
  it.each(['challenge', 'confirm'] as const)('rejects incompatible %s recording with an existing original and allows a later compatible recording', async kind => {
    const f = await reconciliationFixture(kind); await f.memory.retain(f.original);
    await expect(f.memory.record(f.original.locator, f.changed)).rejects.toMatchObject({ code: 'unconfirmed' });
    expect(f.memory.original(f.original.locator)).toEqual(f.original); expect(f.memory.recorded(f.original.locator)).toBeNull();
    await f.memory.record(f.original.locator, f.operation);
    const result = await qualifyCustodyRecovery(f.recovery(f.memory.recorded(f.original.locator), f.original), f.original.locator, f.scope, f.memory.original(f.original.locator)!);
    expect(result).toMatchObject({ retainedRequest: true, permitsSigning: false });
    expect(listCustodyReferences(f.store, f.scope).references).toEqual([f.original.locator]);
  });
  it.each([
    ['challenge', 'record-first'], ['challenge', 'retain-first'], ['confirm', 'record-first'], ['confirm', 'retain-first'],
  ] as const)('serializes incompatible %s updates %s without exposing a contradictory pair', async (kind, order) => {
    const f = await reconciliationFixture(kind);
    const work = order === 'record-first'
      ? [f.memory.record(f.original.locator, f.changed), f.memory.retain(f.original)]
      : [f.memory.retain(f.original), f.memory.record(f.original.locator, f.changed)];
    expect(f.memory.original(f.original.locator)).toBeNull(); expect(f.memory.recorded(f.original.locator)).toBeNull();
    const outcomes = await Promise.allSettled(work);
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    if (order === 'record-first') { expect(f.memory.original(f.original.locator)).toBeNull(); expect(f.memory.recorded(f.original.locator)).toEqual(f.changed); }
    else { expect(f.memory.original(f.original.locator)).toEqual(f.original); expect(f.memory.recorded(f.original.locator)).toBeNull(); }
    expect(listCustodyReferences(f.store, f.scope).references).toEqual([f.original.locator]);
  });
  it.each([
    ['challenge', 'sequential'], ['confirm', 'sequential'], ['challenge', 'record-first'], ['confirm', 'record-first'], ['challenge', 'retain-first'], ['confirm', 'retain-first'],
  ] as const)('keeps compatible %s updates usable in %s order', async (kind, order) => {
    const f = await reconciliationFixture(kind);
    if (order === 'sequential') { await f.memory.record(f.original.locator, f.operation); await f.memory.retain(f.original); }
    else if (order === 'record-first') await Promise.all([f.memory.record(f.original.locator, f.operation), f.memory.retain(f.original)]);
    else await Promise.all([f.memory.retain(f.original), f.memory.record(f.original.locator, f.operation)]);
    const result = await qualifyCustodyRecovery(f.recovery(f.memory.recorded(f.original.locator), f.original), f.original.locator, f.scope, f.memory.original(f.original.locator)!);
    expect(result).toMatchObject({ historical: true, retainedRequest: true, permitsSigning: false });
    expect(f.memory.recorded(f.original.locator)).toEqual(f.operation);
    expect(listCustodyReferences(f.store, f.scope).references).toEqual([f.original.locator]);
  });
  it.each(['challenge', 'confirm'] as const)('captures queued %s caller inputs before the queue yields', async kind => {
    const f = await reconciliationFixture(kind), original = structuredClone(f.original), locator = structuredClone(f.original.locator), operation = structuredClone(f.operation);
    const pending = Promise.all([f.memory.record(locator, operation), f.memory.retain(original)]);
    original.request.body.key = 'changed_after_queue'; locator.draftIdentity = 'changed_after_queue'; operation.commandHash = 'b'.repeat(64);
    await pending;
    expect(f.memory.original(f.original.locator)).toEqual(f.original); expect(f.memory.recorded(f.original.locator)).toEqual(f.operation);
  });
  it.each(['challenge', 'confirm'] as const)('close revokes active and queued %s updates without clearing durable references', async kind => {
    const f = await reconciliationFixture(kind), pending = Promise.allSettled([f.memory.record(f.original.locator, f.operation), f.memory.retain(f.original)]);
    await Promise.resolve(); f.memory.close();
    const outcomes = await pending; expect(outcomes.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(() => f.memory.original(f.original.locator)).toThrow(); expect(() => f.memory.recorded(f.original.locator)).toThrow();
    expect(listCustodyReferences(f.store, f.scope).references).toEqual([f.original.locator]);
  });
});
