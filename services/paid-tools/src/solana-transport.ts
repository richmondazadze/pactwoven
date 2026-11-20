import { createHash, randomUUID } from 'node:crypto';
import { InstantSchema } from '../../../packages/contracts/src/core.js';
import { prepareSolanaRead, decodeSolanaReadResponse } from '../../../packages/adapters/src/solana/rpc-read.js';
import { SOLANA_RPC_MAX_BYTES, type SolanaReadCommand, type SolanaReadEvidence } from '../../../packages/adapters/src/solana/types.js';
import { preparePaidToolRpc, decodePaidToolRpc, type PaidToolRpcCommand } from './solana-rpc.js';
import { inspectPaidTransferAccounts, validatePaidTransferIntent, verifiedPaidTransferIntent, type PaidTransferIntent, type VerifiedPaidTransferWire } from './solana-transfer.js';
import { inspectPaidTransferFinality, PaidTransferFinalityError } from './solana-finality.js';

export class PaidToolTransportError extends Error {
  constructor(readonly code: 'CONFIGURATION_INVALID' | 'SOURCE_UNAVAILABLE' | 'SOURCE_INVALID' | 'EXPIRED' | 'FEE_CHANGED') {
    super(`Paid-tool provider unavailable: ${code}`); this.name = 'PaidToolTransportError';
  }
}
const fail = (code: PaidToolTransportError['code']): never => { throw new PaidToolTransportError(code); };
function endpoint(input: string) {
  let url: URL; try { url = new URL(input); } catch { return fail('CONFIGURATION_INVALID'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]*\.(?:solana-devnet\.)?quiknode\.pro$/.test(url.hostname) ||
    url.username || url.password || url.hash || url.port || url.search || !/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return fail('CONFIGURATION_INVALID');
  return url.href;
}
export type PaidRpcCapture = { reference: string; method: string; requestPayload:string; requestHash: string; observedAt: string; payloadHex: string; sha256: string };
export type PaidTransferReadiness = Awaited<ReturnType<QuickNodePaidToolTransport['inspectReady']>>;

/** Private fixed-endpoint transport. No public route or caller URL exists.
 * Construction makes no request. Each request is prepared by a closed RPC
 * method helper; callbacks retain raw evidence before trusting its contents.
 * A broadcaster MUST hold a current persisted dispatch fence before submit. */
export class QuickNodePaidToolTransport {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #capture: (evidence: PaidRpcCapture) => Promise<void>;
  constructor(options: { endpointUrl: string; capture: (evidence: PaidRpcCapture) => Promise<void>; fetch?: typeof fetch; now?: () => string }) {
    this.#url = endpoint(options.endpointUrl); this.#fetch = options.fetch ?? fetch; this.#capture = options.capture;
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  async #post(request: { method: string; payload: string }, reference: string, parent: AbortSignal): Promise<{bytes:Uint8Array;observedAt:string}> {
    const controller = new AbortController(), abort = () => controller.abort();
    if (parent.aborted) return fail('SOURCE_UNAVAILABLE'); parent.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 8000); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let responseBody: ReadableStream<Uint8Array> | null = null;
    let rejectAborted!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    const reject = () => rejectAborted(new PaidToolTransportError('SOURCE_UNAVAILABLE'));
    controller.signal.addEventListener('abort', reject, { once: true });
    try {
      const response = await Promise.race([this.#fetch(this.#url, { method: 'POST', body: request.payload,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, redirect: 'error', credentials: 'omit', signal: controller.signal }), aborted]);
      responseBody = response.body;
      if (response.status !== 200 || response.redirected || response.url && response.url !== this.#url ||
        !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) return fail('SOURCE_UNAVAILABLE');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(SOLANA_RPC_MAX_BYTES))) return fail('SOURCE_UNAVAILABLE');
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted]); if (chunk.done) break;
        count += chunk.value.length; if (count > SOLANA_RPC_MAX_BYTES) return fail('SOURCE_UNAVAILABLE'); chunks.push(new Uint8Array(chunk.value));
      }
      const bytes = Buffer.concat(chunks); const observedAt = InstantSchema.parse(this.#now());
      await Promise.race([this.#capture({ reference, method: request.method, requestPayload:request.payload, requestHash: createHash('sha256').update(request.payload).digest('hex'),
        observedAt, payloadHex: bytes.toString('hex'), sha256: createHash('sha256').update(bytes).digest('hex') }), aborted]);
      return {bytes,observedAt};
    } catch { return fail('SOURCE_UNAVAILABLE'); }
    finally {
      clearTimeout(timer); parent.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', reject);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else if (responseBody) void responseBody.cancel().catch(() => {});
    }
  }
  async #read(command: SolanaReadCommand, reference: string, signal: AbortSignal): Promise<SolanaReadEvidence> {
    const request = prepareSolanaRead(randomUUID(), command), bytes = await this.#post(request, reference, signal);
    return decodeSolanaReadResponse(request, bytes.bytes, reference);
  }
  async #rpc(command: PaidToolRpcCommand, reference: string, signal: AbortSignal) {
    const request = preparePaidToolRpc(randomUUID(), command), bytes = await this.#post(request, reference, signal);
    try { const result=decodePaidToolRpc(request, bytes.bytes, reference); if(!result)return fail('SOURCE_INVALID'); return {...result,observedAt:bytes.observedAt}; } catch { return fail('SOURCE_INVALID'); }
  }
  /** Intended for a trusted preparation producer, never direct browser input. */
  async latestBlockhash(minimumSlot: string, reference: string, signal: AbortSignal) {
    const result = await this.#rpc({ method: 'getLatestBlockhash', minimumSlot }, reference, signal);
    if (result?.method !== 'getLatestBlockhash') return fail('SOURCE_INVALID'); return result;
  }
  async quoteFee(intent: PaidTransferIntent, reference: string, signal: AbortSignal) {
    const result = await this.#rpc({ method: 'getFeeForMessage', intent }, reference, signal);
    if (result?.method !== 'getFeeForMessage') return fail('SOURCE_INVALID'); return result;
  }
  async inspectReady(input: PaidTransferIntent, prefix: string, signal: AbortSignal) {
    const intent = validatePaidTransferIntent(input), startedAt = InstantSchema.parse(this.#now());
    if (Date.parse(startedAt) >= Date.parse(intent.validUntil)) return fail('EXPIRED');
    const addresses = [intent.mint, intent.sourceAccount, intent.destinationAccount, intent.feePayer, ...(intent.sourceOwner === intent.feePayer ? [] : [intent.sourceOwner])];
    const [genesis, accounts, height, fee] = await Promise.all([
      this.#read({ method: 'getGenesisHash' }, `${prefix}_genesis`, signal),
      this.#read({ method: 'getMultipleAccounts', addresses, minContextSlot: intent.minimumAccountSlot }, `${prefix}_accounts`, signal),
      this.#rpc({ method: 'getBlockHeight', minimumSlot: intent.minimumAccountSlot }, `${prefix}_height`, signal),
      this.#rpc({ method: 'getFeeForMessage', intent }, `${prefix}_fee`, signal),
    ]);
    if (height?.method !== 'getBlockHeight' || fee?.method !== 'getFeeForMessage') return fail('SOURCE_INVALID');
    if (BigInt(height.blockHeight) > BigInt(intent.lastValidBlockHeight)) return fail('EXPIRED');
    if (fee.feeLamports !== intent.feeLamports) return fail('FEE_CHANGED');
    const observedAt = InstantSchema.parse(this.#now());
    if (Date.parse(observedAt) < Date.parse(startedAt) || Date.parse(observedAt) >= Date.parse(intent.validUntil) || Date.parse(observedAt) - Date.parse(startedAt) > 8000) return fail('EXPIRED');
    const balances = await inspectPaidTransferAccounts(intent, genesis, accounts, observedAt);
    return Object.freeze({ intent, startedAt, observedAt, validUntil: intent.validUntil, balances, blockHeight: height.blockHeight,
      feeLamports: fee.feeLamports, genesis, accounts, heightEvidence: height.evidence, heightObservedAt: height.observedAt, feeEvidence: fee.evidence });
  }
  /** A final local freshness check after a persisted fence response. This is
   * not authority; SQL independently validates its own current timestamp. */
  assertFreshReadiness(ready: PaidTransferReadiness) {
    const current=Date.parse(InstantSchema.parse(this.#now())),height=Date.parse(ready.heightObservedAt);
    if(current>=Date.parse(ready.intent.validUntil) || current<height || current-height>5000 || current-Date.parse(ready.startedAt)>30000) return fail('EXPIRED');
  }
  async simulate(wire: VerifiedPaidTransferWire, reference: string, signal: AbortSignal) {
    verifiedPaidTransferIntent(wire); const result = await this.#rpc({ method: 'simulateTransaction', wire }, reference, signal);
    if (result?.method !== 'simulateTransaction') return fail('SOURCE_INVALID'); return result;
  }
  /** Exactly one HTTP attempt. Unknown acknowledgement never triggers resend.
   * The caller has already persisted original bytes and a dispatch fence. */
  async submit(wire: VerifiedPaidTransferWire, reference: string, signal: AbortSignal) {
    verifiedPaidTransferIntent(wire);
    try {
      const result = await this.#rpc({ method: 'sendTransaction', wire }, reference, signal);
      if (result?.method !== 'sendTransaction') return { disposition: 'unknown' as const };
      return { disposition: 'submitted' as const, signature: result.signature, evidence: result.evidence };
    } catch { return { disposition: 'unknown' as const }; }
  }
  async observeFinality(wire: VerifiedPaidTransferWire, prefix: string, signal: AbortSignal) {
    verifiedPaidTransferIntent(wire);
    const [genesis, status, transaction] = await Promise.all([
      this.#read({ method: 'getGenesisHash' }, `${prefix}_genesis`, signal),
      this.#read({ method: 'getSignatureStatuses', signatures: [wire.signature] }, `${prefix}_status`, signal),
      this.#read({ method: 'getTransaction', signature: wire.signature }, `${prefix}_transaction`, signal),
    ]);
    try { return { disposition: 'finalized' as const, payment: await inspectPaidTransferFinality(wire, genesis, status, transaction, this.#now()) }; }
    catch (error) {
      if (error instanceof PaidTransferFinalityError && error.code === 'NOT_FINALIZED') return { disposition: 'unknown' as const };
      return fail('SOURCE_INVALID');
    }
  }
}
