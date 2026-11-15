import { BaseUnitsSchema, BudgetLimitSchema, BudgetSnapshotSchema, EconomicIntentSchema, ExposureSchema,
  FinancialComponentSchema, JournalEntrySchema, LedgerAccountSchema,
  type ActionBinding, type BudgetLimit, type BudgetSnapshot, type EconomicIntent, type Exposure, type FinancialComponent,
  type JournalEntry, type LedgerAccount } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';
import { immutable, instant, nextVersion } from './authority.js';
import { validateActionBinding } from './action-binding.js';
import { DomainError } from './errors.js';

const maximum = 18_446_744_073_709_551_615n;
export function units(value: string): bigint { return BigInt(BaseUnitsSchema.parse(value)); }
export function amount(value: bigint): string {
  if (value < 0n || value > maximum) throw new DomainError('AMOUNT_OVERFLOW', 422, 'Amount is outside the supported unsigned range.');
  return value.toString();
}
export function sumAmounts(values: readonly string[]): string { return amount(values.reduce((total, value) => total + units(value), 0n)); }

function checkedBudget(input: BudgetSnapshot): BudgetSnapshot {
  const snapshot = BudgetSnapshotSchema.parse(input);
  if (snapshot.asset.environment !== snapshot.environment || snapshot.exposures.some(exposure => exposure.assetId !== snapshot.asset.id) ||
      new Set(snapshot.exposures.map(exposure => exposure.id)).size !== snapshot.exposures.length ||
      new Set(snapshot.exposures.map(exposure => exposure.economicPortionId)).size !== snapshot.exposures.length ||
      new Set(snapshot.spend.map(spend => `${spend.responsibilityId}:${spend.category}`)).size !== snapshot.spend.length) {
    throw new DomainError('BUDGET_INCONSISTENT', 409, 'Asset scope and economic coverage must be unique.');
  }
  for (const exposure of snapshot.exposures) {
    if ((exposure.state === 'PAID') !== (exposure.paidAt !== null) || (exposure.paidAt && instant(exposure.paidAt) > instant(snapshot.verifiedAt))) {
      throw new DomainError('BUDGET_INCONSISTENT', 409, 'Paid exposure requires an observed payment time and non-paid exposure cannot carry one.');
    }
  }
  for (const spend of snapshot.spend) {
    const paid = snapshot.exposures.filter(item => item.state === 'PAID' && item.responsibilityId === spend.responsibilityId && item.category === spend.category);
    const periodPaid = paid.filter(item => instant(item.paidAt!) >= instant(spend.periodStartsAt) && instant(item.paidAt!) < instant(spend.periodEndsAt));
    if (instant(spend.periodStartsAt) >= instant(spend.periodEndsAt) || units(spend.periodBaseUnits) > units(spend.lifetimeBaseUnits) ||
        units(sumAmounts(paid.map(item => item.amountBaseUnits))) > units(spend.lifetimeBaseUnits) ||
        units(sumAmounts(periodPaid.map(item => item.amountBaseUnits))) > units(spend.periodBaseUnits)) {
      throw new DomainError('BUDGET_INCONSISTENT', 409, 'Spend counters cannot understate observed paid exposure or the active period.');
    }
  }
  if (snapshot.exposures.some(exposure => exposure.state === 'PAID' && !snapshot.spend.some(spend =>
    spend.responsibilityId === exposure.responsibilityId && spend.category === exposure.category))) {
    throw new DomainError('BUDGET_INCONSISTENT', 409, 'Every paid exposure requires reconciled spend counters.');
  }
  return snapshot;
}
const held = (exposure: Exposure) => exposure.state === 'HELD' || exposure.state === 'OUTCOME_UNKNOWN';
export function availableForNewCommitments(input: BudgetSnapshot): string {
  const snapshot = checkedBudget(input);
  const exposure = units(sumAmounts(snapshot.exposures.filter(held).map(item => item.amountBaseUnits)));
  const available = units(snapshot.verifiedSpendableBaseUnits) - exposure;
  if (available < 0n) throw new DomainError('BUDGET_INCONSISTENT', 409, 'Recorded obligations exceed verified spendable funds.');
  // Expected refunds are deliberately not part of this calculation.
  return amount(available);
}

/** Pure validation/projection only. Persistence must lock the shared budget and compare version. */
export function reserveBudget(input: BudgetSnapshot, componentsInput: FinancialComponent[], context: {
  expectedVersion: number; responsibilityId: string; limits: BudgetLimit[]; now: string; notObservedBefore: string;
}): BudgetSnapshot {
  const snapshot = checkedBudget(input);
  const components = componentsInput.map(component => FinancialComponentSchema.parse(component));
  if (snapshot.version !== context.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'Refresh the current shared budget.');
  if (instant(snapshot.verifiedAt) < instant(context.notObservedBefore) || instant(snapshot.verifiedAt) > instant(context.now) || instant(context.notObservedBefore) > instant(context.now)) {
    throw new DomainError('FUNDS_STALE', 409, 'A current verified funds observation is required.');
  }
  if (!components.length || components.some(component => component.assetId !== snapshot.asset.id || units(component.amountBaseUnits) === 0n) ||
      new Set(components.map(component => component.id)).size !== components.length ||
      new Set(components.map(component => component.economicPortionId)).size !== components.length ||
      components.some(component => snapshot.exposures.some(exposure => exposure.id === component.id || exposure.economicPortionId === component.economicPortionId))) {
    throw new DomainError('ALLOCATION_CONFLICT', 409, 'Each allocation requires a new exact economic portion in the same asset.');
  }
  const total = units(sumAmounts(components.map(component => component.amountBaseUnits)));
  if (total > units(availableForNewCommitments(snapshot))) throw new DomainError('INSUFFICIENT_RESERVE', 422, 'Verified unencumbered funds are insufficient.');
  const limits = context.limits.map(limit => BudgetLimitSchema.parse(limit));
  if (new Set(limits.map(limit => `${limit.assetId}:${limit.category}`)).size !== limits.length) throw new DomainError('VALIDATION_FAILED', 422, 'Budget dimensions must be unique.');
  for (const category of new Set(components.map(component => component.category))) {
    const limit = limits.find(item => item.assetId === snapshot.asset.id && item.category === category);
    if (!limit || instant(limit.periodStartsAt) > instant(context.now) || instant(limit.periodEndsAt) <= instant(context.now)) {
      throw new DomainError('APPROVAL_REQUIRED', 403, 'A current explicit limit for each asset and fee category is required.');
    }
    const spend = snapshot.spend.filter(item => item.category === category);
    if (spend.some(item => instant(item.periodStartsAt) !== instant(limit.periodStartsAt) || instant(item.periodEndsAt) !== instant(limit.periodEndsAt))) {
      throw new DomainError('BUDGET_INCONSISTENT', 409, 'Spend counters must be reconciled to the active budget period.');
    }
    const requested = units(sumAmounts(components.filter(item => item.category === category).map(item => item.amountBaseUnits)));
    const active = snapshot.exposures.filter(item => item.category === category && held(item));
    const responsibilityExposure = units(sumAmounts(active.filter(item => item.responsibilityId === context.responsibilityId).map(item => item.amountBaseUnits)));
    const responsibilitySpent = units(sumAmounts(spend.filter(item => item.responsibilityId === context.responsibilityId).map(item => item.lifetimeBaseUnits)));
    const periodCommitted = units(sumAmounts(spend.map(item => item.periodBaseUnits))) + units(sumAmounts(active.map(item => item.amountBaseUnits)));
    if (requested > units(limit.perOperation) || responsibilitySpent + responsibilityExposure + requested > units(limit.perResponsibility) ||
        periodCommitted + requested > units(limit.periodMaximum)) {
      throw new DomainError('APPROVAL_REQUIRED', 403, `The ${category} operation, responsibility or period limit would be exceeded.`);
    }
  }
  return immutable(BudgetSnapshotSchema.parse({ ...snapshot, version: nextVersion(snapshot.version), exposures: [...snapshot.exposures,
    ...components.map(component => ({ ...component, responsibilityId: context.responsibilityId, kind: 'ALLOCATION', state: 'HELD', paidAt: null }))] }));
}

export function retainUnknownExposure(input: BudgetSnapshot, exposureId: string): BudgetSnapshot {
  const snapshot = checkedBudget(input);
  const exposure = snapshot.exposures.find(item => item.id === exposureId);
  if (!exposure || !held(exposure)) throw new DomainError('EXPOSURE_CONFLICT', 409, 'Only a still-encumbered economic portion can have an unknown result.');
  if (exposure.state === 'OUTCOME_UNKNOWN') return immutable(snapshot);
  return immutable({ ...snapshot, version: nextVersion(snapshot.version), exposures: snapshot.exposures.map(item => item.id === exposureId
    ? ExposureSchema.parse({ ...item, state: 'OUTCOME_UNKNOWN' }) : item) });
}

export function requiredFutureLiquidity(unpaidObligations: string[], additionalScenarioCosts: string[], networkAndRecoveryBuffer: string): string {
  if (!additionalScenarioCosts.length) throw new DomainError('VALIDATION_FAILED', 422, 'Enumerated possible scenarios are required; do not assume branch exclusivity.');
  const greatest = additionalScenarioCosts.map(units).reduce((left, right) => left > right ? left : right, 0n);
  return amount(units(sumAmounts(unpaidObligations)) + greatest + units(networkAndRecoveryBuffer));
}

export async function prepareEconomicIntent(context: { id: string; paymentAuthorizationId: string; approvalId: string; now: string }, input: ActionBinding): Promise<EconomicIntent> {
  const action = validateActionBinding(input);
  if (instant(action.expiresAt) <= instant(context.now)) throw new DomainError('TERMS_EXPIRED', 409, 'The exact action has expired.');
  const economicKey = await commandDigest({ namespace: 'pactwoven.economic-operation.v1', environment: action.authority.environment,
    organizationId: action.authority.organizationId, paymentAuthorizationId: context.paymentAuthorizationId });
  return immutable(EconomicIntentSchema.parse({ id: context.id, economicKey, paymentAuthorizationId: context.paymentAuthorizationId, action,
    actionHash: await commandDigest(action), approvalId: context.approvalId, state: 'PREPARED', createdAt: context.now }));
}

export function deduplicateEconomicIntent(existingInput: EconomicIntent[], proposedInput: EconomicIntent): EconomicIntent {
  const proposed = EconomicIntentSchema.parse(proposedInput);
  const existing = existingInput.map(intent => EconomicIntentSchema.parse(intent)).find(intent =>
    intent.action.authority.environment === proposed.action.authority.environment && intent.action.authority.organizationId === proposed.action.authority.organizationId &&
    intent.paymentAuthorizationId === proposed.paymentAuthorizationId);
  if (existing && (existing.economicKey !== proposed.economicKey || existing.actionHash !== proposed.actionHash || existing.approvalId !== proposed.approvalId ||
      canonicalJson(existing.action) !== canonicalJson(proposed.action))) {
    throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'The authorized economic operation cannot be reused for a changed payment.');
  }
  return immutable(existing ?? proposed);
}

export function validateJournal(input: JournalEntry, accountsInput: LedgerAccount[]): JournalEntry {
  const entry = JournalEntrySchema.parse(input);
  const accounts = accountsInput.map(account => LedgerAccountSchema.parse(account));
  const definitions = new Map(accounts.map(account => [account.id, account]));
  if (definitions.size !== accounts.length || new Set(entry.lines.map(line => line.id)).size !== entry.lines.length) {
    throw new DomainError('JOURNAL_INVALID', 422, 'Journal lines and account definitions require unique identities.');
  }
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  for (const line of entry.lines) {
    const account = definitions.get(line.accountId);
    if (!account || account.organizationId !== entry.organizationId || account.environment !== entry.environment || account.assetId !== line.assetId || units(line.amountBaseUnits) === 0n) {
      throw new DomainError('JOURNAL_INVALID', 422, 'Every nonzero journal line must belong to the exact organization, environment and asset.');
    }
    const total = totals.get(line.assetId) ?? { debit: 0n, credit: 0n };
    if (line.direction === 'DEBIT') total.debit += units(line.amountBaseUnits); else total.credit += units(line.amountBaseUnits);
    if (total.debit > maximum || total.credit > maximum) throw new DomainError('AMOUNT_OVERFLOW', 422, 'Journal totals exceed the supported range.');
    totals.set(line.assetId, total);
  }
  if ([...totals.values()].some(total => total.debit !== total.credit)) throw new DomainError('JOURNAL_UNBALANCED', 422, 'Journal debits and credits must balance independently per asset.');
  return immutable(entry);
}

function postingIdentity(entry: JournalEntry): string {
  const { id: _id, postedAt: _postedAt, ...content } = entry;
  return canonicalJson(content);
}
export function appendJournal(existingInput: readonly JournalEntry[], proposedInput: JournalEntry, accounts: LedgerAccount[]): readonly JournalEntry[] {
  const entry = validateJournal(proposedInput, accounts);
  const existing = existingInput.map(item => JournalEntrySchema.parse(item));
  const duplicate = existing.find(item => item.environment === entry.environment && item.organizationId === entry.organizationId && item.economicEventKey === entry.economicEventKey);
  if (duplicate) {
    if (postingIdentity(duplicate) !== postingIdentity(entry)) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'The economic posting already has a different immutable result.');
    return immutable(existing);
  }
  if (existing.some(item => item.id === entry.id)) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'The journal identity already exists.');
  if (entry.correctionOf) {
    const original = existing.find(item => item.id === entry.correctionOf && item.organizationId === entry.organizationId && item.environment === entry.environment);
    if (!original || existing.some(item => item.correctionOf === original.id) || original.lines.length !== entry.lines.length ||
        original.lines.some((line, index) => {
          const correction = entry.lines[index];
          return !correction || correction.accountId !== line.accountId || correction.assetId !== line.assetId ||
            correction.amountBaseUnits !== line.amountBaseUnits || correction.direction === line.direction;
        })) throw new DomainError('CORRECTION_INVALID', 409, 'A correction must be a single linked full reversal of the original posting.');
  }
  return immutable([...existing, entry]);
}
