import type {
  SupplierAvailabilityQuery, SupplierDurableReceipt, SupplierMessageAction, SupplierOriginalEffectIdentity,
  UntrustedSupplierAvailabilityObservation, UntrustedSupplierCapabilityManifest,
  UntrustedSupplierDomainAcknowledgement, UntrustedSupplierEffectResult, UntrustedSupplierMessage,
} from '@pactwoven/contracts';

/**
 * Interface-only seam for a future private server verifier. This package provides no verifier,
 * context constructor, cast helper or authentication flag. A structural value of this type
 * does not prove authentication. ServerContext must be owned and validated by the server;
 * models, browsers, wire payloads and adapter declarations must never supply that context.
 */
export type SupplierIngressDelivery<ServerContext> = Readonly<{
  message: UntrustedSupplierMessage;
  serverContext: ServerContext;
}>;
export interface SupplierIngressVerifier<ServerContext> {
  verifyAndDeliver<T>(
    input: UntrustedSupplierMessage,
    consume: (delivery: SupplierIngressDelivery<ServerContext>) => Promise<T>,
  ): Promise<T>;
}

export type SupplierAdapterRequest<Action extends SupplierMessageAction> = Readonly<{
  message: Extract<UntrustedSupplierMessage, { action: Action }>;
  originalIdentity: SupplierOriginalEffectIdentity;
}>;
export type SupplierExternalOperationLookup = Readonly<{
  originalIdentity: SupplierOriginalEffectIdentity;
  externalReference: UntrustedSupplierEffectResult['externalReference'];
}>;
export type SupplierIngressReceipts = Readonly<{
  durableReceipt: SupplierDurableReceipt;
  domainAcknowledgement: UntrustedSupplierDomainAcknowledgement | null;
}>;

/**
 * No implementation or effects exist in this packet. Every future method must validate the
 * private context, current capability, scope, payload/operation affinity and original digest.
 * Unsupported capability returns an explicit UNSUPPORTED result before execution. Timeouts
 * preserve original identity; declaration/receipt/result parsing never authenticates a claim.
 */
export interface SupplierAdapter<ServerContext> {
  capabilities(context: ServerContext): Promise<UntrustedSupplierCapabilityManifest>;
  getAvailability(context: ServerContext, input: SupplierAvailabilityQuery): Promise<readonly UntrustedSupplierAvailabilityObservation[]>;
  requestQuote(context: ServerContext, input: SupplierAdapterRequest<'quote_request'>): Promise<UntrustedSupplierEffectResult>;
  reserve(context: ServerContext, input: SupplierAdapterRequest<'hold_request'>): Promise<UntrustedSupplierEffectResult>;
  activate(context: ServerContext, input: SupplierAdapterRequest<'activation_request'>): Promise<UntrustedSupplierEffectResult>;
  amend(context: ServerContext, input: SupplierAdapterRequest<'amendment_proposal'>): Promise<UntrustedSupplierEffectResult>;
  cancel(context: ServerContext, input: SupplierAdapterRequest<'cancellation_request'>): Promise<UntrustedSupplierEffectResult>;
  requestRefund(context: ServerContext, input: SupplierAdapterRequest<'refund_request'>): Promise<UntrustedSupplierEffectResult>;
  updateDispatch(context: ServerContext, input: SupplierAdapterRequest<'dispatch_update'>): Promise<UntrustedSupplierEffectResult>;
  recordFulfillment(context: ServerContext, input: SupplierAdapterRequest<'fulfillment_evidence'>): Promise<UntrustedSupplierEffectResult>;
  reconcile(context: ServerContext, input: SupplierExternalOperationLookup): Promise<UntrustedSupplierEffectResult>;
  resolveManually(context: ServerContext, input: SupplierExternalOperationLookup): Promise<UntrustedSupplierEffectResult>;
}
