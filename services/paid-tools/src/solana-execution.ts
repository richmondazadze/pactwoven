import { createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { encodeSolanaBase58 } from '../../../packages/contracts/src/finance-provenance.js';
import { PaidToolPrivateReadSchema, PaidToolFinalityInputSchema, type PaidToolSnapshot } from '../../../packages/db/src/paid-tool-schema.js';
import type { PostgresPaidToolPrivateRepository } from '../../../packages/db/src/paid-tool-repository.js';
import { buildPaidTransferMessage, validatePaidTransferIntent, verifyPaidTransferWire, type PaidTransferIntent } from './solana-transfer.js';
import { QuickNodePaidToolTransport, type PaidTransferReadiness } from './solana-transport.js';

type Repository = Pick<PostgresPaidToolPrivateRepository, 'read' | 'apply' | 'quarantine'>;
type Observer = Pick<PostgresPaidToolPrivateRepository, 'observe'>;
/** Owner-supplied private configuration, never deserialized from HTTP/task text.
 * SQL independently binds sourceKey/feeKey to enrolled physical accounts. */
export type PaidToolCustodyRoute = Readonly<{ sourceKey: string; feeKey: string; sourceAccount: string; sourceOwner: string;
  destinationAccount: string; destinationOwner: string; feePayer: string; minimumSlot: string }>;
export type PaidToolHeightObservation = { id:string; operationId: string; messageHash: string; blockhash: string; lastValidBlockHeight: string;
  currentBlockHeight: string; observedAt: string; evidenceRef: string; evidenceHash: string };
export class PaidToolExecutionError extends Error {
  constructor(readonly code: 'STATE_REQUIRES_RECONCILIATION' | 'CONFIGURATION_INVALID' | 'ORIGINAL_MESSAGE_MISMATCH' | 'ABORTED') {
    super(`Paid-tool execution stopped: ${code}`); this.name = 'PaidToolExecutionError';
  }
}
const fail = (code: PaidToolExecutionError['code']): never => { throw new PaidToolExecutionError(code); };
function active(signal: AbortSignal) { if (signal.aborted) fail('ABORTED'); }
function routeFor(snapshot: PaidToolSnapshot, routes: readonly PaidToolCustodyRoute[]) {
  const r = snapshot.review, matches = routes.filter(route => route.sourceAccount === r.sourceAccount && route.sourceOwner === r.sourceOwner &&
    route.destinationAccount === r.destinationAccount && route.destinationOwner === r.destinationOwner && route.feePayer === r.feePayer);
  if (matches.length !== 1) return fail('CONFIGURATION_INVALID'); return matches[0]!;
}
function intentFor(snapshot: PaidToolSnapshot, route: PaidToolCustodyRoute, message: {blockhash:string;lastValidBlockHeight:string;feeLamports:string}): PaidTransferIntent {
  const r=snapshot.review;
  return validatePaidTransferIntent({genesis:r.genesis,mint:r.mint,tokenProgram:r.tokenProgram,decimals:6,
    sourceAccount:r.sourceAccount,sourceOwner:r.sourceOwner,destinationAccount:r.destinationAccount,destinationOwner:r.destinationOwner,
    feePayer:r.feePayer,amountBaseUnits:r.amountBaseUnits,maximumFeeLamports:r.maximumFeeLamports,validUntil:r.expiresAt,
    minimumAccountSlot:route.minimumSlot,blockhash:message.blockhash,lastValidBlockHeight:message.lastValidBlockHeight,feeLamports:message.feeLamports});
}
function storedIntent(snapshot: PaidToolSnapshot, route: PaidToolCustodyRoute) {
  if (!snapshot.message) return fail('ORIGINAL_MESSAGE_MISMATCH');
  const intent=intentFor(snapshot,route,snapshot.message), message=buildPaidTransferMessage(intent);
  if (message.messageHash!==snapshot.message.messageHash || message.messageBase64!==snapshot.message.messageBase64) return fail('ORIGINAL_MESSAGE_MISMATCH');
  return intent;
}
async function observations(observer: Observer,route:PaidToolCustodyRoute,ready:PaidTransferReadiness) {
  const common={slot:ready.balances.slot,observedAt:ready.observedAt,evidenceRef:ready.balances.evidenceRef,evidenceHash:ready.balances.evidenceHash};
  const source=await observer.observe({...common,id:randomUUID(),accountKey:route.sourceKey,amountBaseUnits:ready.balances.sourceBalanceBaseUnits});
  const fee=await observer.observe({...common,id:randomUUID(),accountKey:route.feeKey,amountBaseUnits:ready.balances.feePayerLamports});
  return {sourceObservationId:source.id,feeObservationId:fee.id};
}
function retainedWire(record: ReturnType<typeof PaidToolPrivateReadSchema.parse>, route: PaidToolCustodyRoute) {
  if (!record.wireBase64 || !record.snapshot.attempt) return fail('STATE_REQUIRES_RECONCILIATION');
  const wire=verifyPaidTransferWire(Buffer.from(record.wireBase64,'base64'),storedIntent(record.snapshot,route));
  if (wire.wireHash!==record.snapshot.attempt.wireHash || wire.messageHash!==record.snapshot.attempt.messageHash || wire.signature!==record.snapshot.attempt.signature) return fail('ORIGINAL_MESSAGE_MISMATCH');
  return wire;
}
/** No general signing endpoint. The sole input is an existing stored operation
 * selector. Exactly one successful SQL transition permits one signing attempt.
 * A thrown/unknown persistence result is never retried by this producer. */
export class PrivatePaidToolSigner {
  readonly #routes: readonly PaidToolCustodyRoute[]; readonly #keys: ReadonlyMap<string,KeyObject>;
  constructor(private readonly repository: Repository, private readonly observer: Observer,
    private readonly transport: QuickNodePaidToolTransport, routes: readonly PaidToolCustodyRoute[], keys: ReadonlyMap<string,KeyObject>) {
    this.#routes=structuredClone(routes); this.#keys=new Map(keys);
    for (const [address,key] of this.#keys) {
      if (key.type!=='private' || key.asymmetricKeyType!=='ed25519' || encodeSolanaBase58(createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32))!==address) fail('CONFIGURATION_INVALID');
    }
  }
  /** Restart recovery only: validate quarantined original bytes, never sign again.
   * Late byte retention does not restore expired/revoked broadcast permission. */
  async recoverRetained(operationId:string,signal:AbortSignal) {
    active(signal);const record=PaidToolPrivateReadSchema.parse(await this.repository.read(operationId)),snapshot=record.snapshot;
    if(snapshot.operationId!==operationId || !['signing','outcome_unknown'].includes(snapshot.status) || !record.wireBase64 || snapshot.attempt)return fail('STATE_REQUIRES_RECONCILIATION');
    const intent=storedIntent(snapshot,routeFor(snapshot,this.#routes)),wire=verifyPaidTransferWire(Buffer.from(record.wireBase64,'base64'),intent);
    return this.repository.apply({operationId,commandKey:randomUUID(),expectedVersion:snapshot.version,kind:'retain_signed',attempt:{
      id:randomUUID(),messageHash:wire.messageHash,wireHash:wire.wireHash,signature:wire.signature,blockhash:intent.blockhash,lastValidBlockHeight:intent.lastValidBlockHeight}});
  }
  async prepareAndSign(operationId:string,signal:AbortSignal) {
    active(signal); const record=PaidToolPrivateReadSchema.parse(await this.repository.read(operationId)), snapshot=record.snapshot;
    if (snapshot.operationId!==operationId || snapshot.status!=='reserved' || snapshot.message || snapshot.attempt || record.wireBase64) return fail('STATE_REQUIRES_RECONCILIATION');
    const route=routeFor(snapshot,this.#routes), prefix=randomUUID();
    const blockhash=await this.transport.latestBlockhash(route.minimumSlot,`${prefix}_blockhash`,signal);
    const provisional=intentFor(snapshot,route,{...blockhash,feeLamports:snapshot.review.maximumFeeLamports});
    const fee=await this.transport.quoteFee(provisional,`${prefix}_fee_quote`,signal);
    const intent=validatePaidTransferIntent({...provisional,feeLamports:fee.feeLamports}), message=buildPaidTransferMessage(intent);
    const keys=message.signerAddresses.map(address=>{const key=this.#keys.get(address);if(!key)return fail('CONFIGURATION_INVALID');return key;});
    const ready=await this.transport.inspectReady(intent,`${prefix}_ready`,signal), ids=await observations(this.observer,route,ready);
    active(signal);
    const fenced=await this.repository.apply({operationId,commandKey:randomUUID(),expectedVersion:snapshot.version,kind:'prepare_sign',message:{
      messageHash:message.messageHash,messageBase64:message.messageBase64,blockhash:intent.blockhash,lastValidBlockHeight:intent.lastValidBlockHeight,feeLamports:intent.feeLamports,currentBlockHeight:ready.blockHeight,heightObservedAt:ready.heightObservedAt,
      heightEvidenceRef:ready.heightEvidence.reference,heightEvidenceHash:ready.heightEvidence.sha256,...ids}});
    if (fenced.snapshot.operationId!==operationId || fenced.snapshot.status!=='signing' || fenced.snapshot.version!==snapshot.version+1 ||
      fenced.snapshot.message?.messageHash!==message.messageHash || fenced.snapshot.message?.messageBase64!==message.messageBase64) return fail('STATE_REQUIRES_RECONCILIATION');
    active(signal);this.transport.assertFreshReadiness(ready);
    const bytes=Buffer.from(message.messageBase64,'base64'), wireBytes=Buffer.concat([Buffer.from([keys.length]),...keys.map(key=>sign(null,bytes,key)),bytes]);
    // Persist the original bytes BEFORE parsing/signature checking. If this fails,
    // the signing fence remains held and no replacement signing is attempted.
    const quarantined=await this.repository.quarantine(operationId,wireBytes.toString('base64'));
    const wire=verifyPaidTransferWire(wireBytes,intent);
    if(quarantined.wireHash!==wire.wireHash)return fail('ORIGINAL_MESSAGE_MISMATCH');
    return this.repository.apply({operationId,commandKey:randomUUID(),expectedVersion:fenced.snapshot.version,kind:'retain_signed',attempt:{
      id:randomUUID(),messageHash:wire.messageHash,wireHash:wire.wireHash,signature:wire.signature,blockhash:intent.blockhash,lastValidBlockHeight:intent.lastValidBlockHeight}});
  }
}
/** Broadcaster has no signing keys. It may send only already retained original
 * bytes after current preflight and an independently persisted dispatch fence. */
export class PrivatePaidToolBroadcaster {
  readonly #routes: readonly PaidToolCustodyRoute[];
  constructor(private readonly repository: Repository, private readonly observer: Observer,
    private readonly transport: QuickNodePaidToolTransport, routes: readonly PaidToolCustodyRoute[],
    private readonly recordHeight:(value:PaidToolHeightObservation)=>Promise<unknown>) {this.#routes=structuredClone(routes);}
  async broadcast(operationId:string,signal:AbortSignal) {
    active(signal);const record=PaidToolPrivateReadSchema.parse(await this.repository.read(operationId)), snapshot=record.snapshot;
    if(snapshot.operationId!==operationId || snapshot.status!=='signed')return fail('STATE_REQUIRES_RECONCILIATION');
    const route=routeFor(snapshot,this.#routes),wire=retainedWire(record,route),intent=storedIntent(snapshot,route),prefix=randomUUID();
    await this.transport.simulate(wire,`${prefix}_simulation`,signal);
    const ready=await this.transport.inspectReady(intent,`${prefix}_ready`,signal);await observations(this.observer,route,ready);
    await this.recordHeight({id:randomUUID(),operationId,messageHash:wire.messageHash,blockhash:intent.blockhash,lastValidBlockHeight:intent.lastValidBlockHeight,
      currentBlockHeight:ready.blockHeight,observedAt:ready.heightObservedAt,evidenceRef:ready.heightEvidence.reference,evidenceHash:ready.heightEvidence.sha256});
    active(signal);const fenced=await this.repository.apply({operationId,commandKey:randomUUID(),expectedVersion:snapshot.version,kind:'prepare_broadcast'});
    if(fenced.snapshot.operationId!==operationId || fenced.snapshot.status!=='submitting' || fenced.snapshot.version!==snapshot.version+1 ||
      fenced.snapshot.attempt?.wireHash!==wire.wireHash || fenced.snapshot.message?.messageHash!==wire.messageHash)return fail('STATE_REQUIRES_RECONCILIATION');
    this.transport.assertFreshReadiness(ready);
    const outcome=await this.transport.submit(wire,`${prefix}_submit`,signal);
    return this.repository.apply({operationId,commandKey:randomUUID(),expectedVersion:fenced.snapshot.version,kind:outcome.disposition==='submitted'?'mark_submitted':'mark_unknown'});
  }
}
/** Finality observation can retain facts after expiry/revocation. It cannot
 * sign, broadcast, extend permission or release a provider result. */
export class PrivatePaidToolFinalityObserver {
  readonly #routes:readonly PaidToolCustodyRoute[];
  constructor(private readonly repository:Repository,private readonly transport:QuickNodePaidToolTransport,routes:readonly PaidToolCustodyRoute[]){this.#routes=structuredClone(routes);}
  async reconcile(operationId:string,signal:AbortSignal){
    active(signal);const record=PaidToolPrivateReadSchema.parse(await this.repository.read(operationId)),snapshot=record.snapshot;
    if(snapshot.operationId!==operationId || !['submitting','payment_pending','outcome_unknown'].includes(snapshot.status))return fail('STATE_REQUIRES_RECONCILIATION');
    const wire=retainedWire(record,routeFor(snapshot,this.#routes)), result=await this.transport.observeFinality(wire,randomUUID(),signal);
    if(result.disposition==='unknown')return {disposition:'unknown' as const};
    return {disposition:'recorded' as const,result:await this.repository.apply({operationId,commandKey:randomUUID(),expectedVersion:snapshot.version,kind:'confirm_payment',payment:PaidToolFinalityInputSchema.parse(result.payment)})};
  }
}
