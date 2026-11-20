import { commandDigest } from '../../../packages/domain/src/canonical.js';

export const EQUIPMENT_OPTIMIZER = 'equipment_optimizer_v1' as const;
export type EquipmentDemand = { seats: number; microphones: number; projectors: number; budgetMinor: number };
export type EquipmentOffer = { id: string; label: string; seats: number; microphones: number; projectors: number; priceMinor: number };
export type EquipmentCatalogue = { version: number; currency: 'USD'; provenance: 'controlled_demo_catalogue'; offers: EquipmentOffer[] };
export type EquipmentResult = { service: typeof EQUIPMENT_OPTIMIZER; provenance: 'controlled_demo_catalogue'; currency: 'USD';
  status: 'feasible' | 'no_feasible_package'; selectedOfferIds: string[]; totalMinor: number | null;
  supplied: { seats: number; microphones: number; projectors: number } | null; evaluatedPackages: number;
  requestHash: string; catalogueHash: string };

export class PaidToolInputError extends Error {
  constructor() { super('Use the exact bounded equipment request and controlled catalogue.'); this.name = 'PaidToolInputError'; }
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new PaidToolInputError();
  return value as Record<string, unknown>;
}
function integer(value: unknown, max: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new PaidToolInputError();
  return value;
}
export function parseEquipmentDemand(input: unknown): EquipmentDemand {
  const value = object(input, ['seats', 'microphones', 'projectors', 'budgetMinor']);
  return { seats: integer(value.seats, 500, 1), microphones: integer(value.microphones, 16),
    projectors: integer(value.projectors, 8), budgetMinor: integer(value.budgetMinor, 1_000_000_000) };
}
export function parseEquipmentCatalogue(input: unknown): EquipmentCatalogue {
  const value = object(input, ['version', 'currency', 'provenance', 'offers']);
  if (value.currency !== 'USD' || value.provenance !== 'controlled_demo_catalogue' || !Array.isArray(value.offers) ||
    !value.offers.length || value.offers.length > 12) throw new PaidToolInputError();
  const offers = value.offers.map(input => {
    const row = object(input, ['id', 'label', 'seats', 'microphones', 'projectors', 'priceMinor']);
    if (typeof row.id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(row.id) || typeof row.label !== 'string' ||
      !row.label.trim() || row.label.length > 120 || /[\u0000-\u001f]/.test(row.label)) throw new PaidToolInputError();
    const offer = { id: row.id, label: row.label, seats: integer(row.seats, 500), microphones: integer(row.microphones, 16),
      projectors: integer(row.projectors, 8), priceMinor: integer(row.priceMinor, 1_000_000_000) };
    if (offer.seats + offer.microphones + offer.projectors === 0) throw new PaidToolInputError();
    return offer;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(offers.map(offer => offer.id)).size !== offers.length) throw new PaidToolInputError();
  return { version: integer(value.version, 2_147_483_647, 1), currency: 'USD', provenance: 'controlled_demo_catalogue', offers };
}
export async function equipmentRequestHash(input: unknown): Promise<string> {
  return commandDigest({ namespace: 'pactwoven.paid-tools.equipment-request.v1', request: parseEquipmentDemand(input) });
}
export async function equipmentCatalogueHash(input: unknown): Promise<string> {
  return commandDigest({ namespace: 'pactwoven.paid-tools.equipment-catalogue.v1', catalogue: parseEquipmentCatalogue(input) });
}
export async function equipmentResourceHash(input: unknown): Promise<string> {
  return commandDigest({ namespace: 'pactwoven.paid-tools.resource.v1', service: EQUIPMENT_OPTIMIZER,
    computation: 'minimum_total_then_fewest_offers_then_sorted_ids', oneOfEachOffer: true, catalogueHash: await equipmentCatalogueHash(input) });
}

/** Actual bounded deterministic computation. No network, ordering, payment,
 * market-data claim or authority is created. The future provider transport
 * must gate access using independently verified payment/delivery records. */
export async function optimizeEquipment(requestInput: unknown, catalogueInput: unknown): Promise<EquipmentResult> {
  const request = parseEquipmentDemand(requestInput), catalogue = parseEquipmentCatalogue(catalogueInput);
  let best: { ids: string[]; price: number; seats: number; microphones: number; projectors: number } | null = null;
  const evaluatedPackages = (1 << catalogue.offers.length) - 1;
  for (let mask = 1; mask <= evaluatedPackages; mask++) {
    const selected = catalogue.offers.filter((_, index) => mask & (1 << index));
    const candidate = selected.reduce((result, row) => ({ ids: [...result.ids, row.id], price: result.price + row.priceMinor,
      seats: result.seats + row.seats, microphones: result.microphones + row.microphones, projectors: result.projectors + row.projectors }),
    { ids: [] as string[], price: 0, seats: 0, microphones: 0, projectors: 0 });
    if (candidate.price > request.budgetMinor || candidate.seats < request.seats || candidate.microphones < request.microphones ||
      candidate.projectors < request.projectors) continue;
    if (!best || candidate.price < best.price || candidate.price === best.price && (candidate.ids.length < best.ids.length ||
      candidate.ids.length === best.ids.length && candidate.ids.join('\0') < best.ids.join('\0'))) best = candidate;
  }
  return { service: EQUIPMENT_OPTIMIZER, provenance: 'controlled_demo_catalogue', currency: 'USD',
    status: best ? 'feasible' : 'no_feasible_package', selectedOfferIds: best?.ids ?? [], totalMinor: best?.price ?? null,
    supplied: best ? { seats: best.seats, microphones: best.microphones, projectors: best.projectors } : null,
    evaluatedPackages, requestHash: await equipmentRequestHash(request), catalogueHash: await equipmentCatalogueHash(catalogue) };
}
