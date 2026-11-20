import type { Session } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { NativePaidEquipmentResponseSchema } from '../../../packages/contracts/src/native-paid-equipment';
import { commandDigest } from '../../../packages/contracts/src/canonical';
import { PaidToolHumanSnapshotSchema } from '../../../packages/db/src/paid-tool-schema';
import { PaidToolRootQuoteSchema } from '../../../packages/db/src/paid-tool-root-schema';
import type { PostgresPaidToolRootRepository } from '../../../packages/db/src/paid-tool-root-repository';
import type { PostgresPaidToolHumanRepository } from '../../../packages/db/src/paid-tool-repository';
import { equipmentRequestHash, equipmentResourceHash, optimizeEquipment } from '../../paid-tools/src/equipment-optimizer';
import { paidToolChallengeHash } from '../../paid-tools/src/quote-binding';
import { projectNativePaidTool } from './native-paid-tool-presentation';

const stale = () => new DomainError('EVIDENCE_STALE', 409, 'The selected equipment is not available under the current work evidence. The payment receipt is retained.');
/** Read-only enrichment of a delivered receipt. Labels and prices come from
 * its authorized stored catalogue, never a client lookup or model prose. */
export class NativePaidEquipmentService {
  constructor(private readonly roots: Pick<PostgresPaidToolRootRepository, 'quote'>,
    private readonly human: Pick<PostgresPaidToolHumanRepository, 'read'>,
    private readonly now = () => new Date().toISOString()) {}
  async read(session: Session, root: string, site: string, operation: string) {
    if (session.actor.environment !== 'development' || session.actor.principalKind !== 'human' ||
      !session.actor.siteIds.includes(site) || !session.sites.some(item => item.id === site))
      throw new DomainError('FORBIDDEN', 403, 'Current workspace access is required for this equipment result.');
    const raw = PaidToolHumanSnapshotSchema.parse(await this.human.read(session.actor, operation));
    if (raw.operationId !== operation) throw stale();
    const { currentInstructionRevision, evidenceAvailable, ...snapshot } = raw;
    const view = await projectNativePaidTool(session, root, site, snapshot, this.now(), { currentInstructionRevision, evidenceAvailable });
    if (view.state !== 'completed' || view.resultApplicability !== 'current' || !view.delivery) throw stale();
    const quote = PaidToolRootQuoteSchema.parse(await this.roots.quote(session.actor, root, site, snapshot.review.quoteId));
    const q = quote.quote, { hash, ...challenge } = q.challenge;
    if (quote.rootTaskId !== root || quote.quoteId !== snapshot.review.quoteId || quote.instructionRevision !== currentInstructionRevision ||
      hash !== snapshot.review.quoteHash || hash !== await paidToolChallengeHash(challenge) ||
      q.challenge.id !== quote.quoteId || q.providerId !== snapshot.review.providerId || q.challenge.providerId !== q.providerId ||
      q.challenge.payee.environment !== 'development' || q.challenge.payee.network !== 'solana-devnet' ||
      q.challenge.payee.recipient !== snapshot.review.destinationOwner || q.challenge.payee.mint !== snapshot.review.mint ||
      q.challenge.payee.tokenProgram !== snapshot.review.tokenProgram || q.challenge.amountBaseUnits !== snapshot.review.amountBaseUnits ||
      q.request.hash !== await equipmentRequestHash(quote.requestBody) || q.resource.hash !== await equipmentResourceHash(quote.resourceBody) ||
      q.challenge.requestHash !== q.request.hash || q.challenge.resourceHash !== q.resource.hash ||
      snapshot.delivery!.requestHash !== q.request.hash || snapshot.delivery!.resourceHash !== q.resource.hash) throw stale();
    const result = await optimizeEquipment(quote.requestBody, quote.resourceBody);
    if (await commandDigest(result) !== await commandDigest(view.delivery.result)) throw stale();
    const items = result.selectedOfferIds.map(id => quote.resourceBody.offers.find(item => item.id === id));
    if (items.some(item => !item)) throw stale();
    return NativePaidEquipmentResponseSchema.parse({ scope: view.scope, rootTaskId: root, operationId: operation,
      instructionRevision: currentInstructionRevision, selection: { status: result.status, currency: 'USD',
        provenance: 'controlled_demo_catalogue', catalogueHash: result.catalogueHash, requestHash: result.requestHash,
        budgetMinor: quote.requestBody.budgetMinor, totalMinor: result.totalMinor, items } });
  }
}
