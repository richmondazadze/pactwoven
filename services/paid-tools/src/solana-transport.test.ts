import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickNodePaidToolTransport, type PaidRpcCapture } from './solana-transport.js';
import { transferFixture, accountFixture, transactionFixture, now } from './solana-fixtures.test-support.js';
const endpointUrl = 'https://test.solana-devnet.quiknode.pro/synthetic-token/';
const signal = () => new AbortController().signal;
function fixture(overrides: Record<string, unknown> = {}) {
  const f = transferFixture(), captures: PaidRpcCapture[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const result = ({ getGenesisHash: f.intent.genesis, getMultipleAccounts: accountFixture(f.intent).result,
      getBlockHeight: 200, getFeeForMessage: { context: { slot: 120 }, value: 5000 },
      getLatestBlockhash: { context: { slot: 120 }, value: { blockhash: f.intent.blockhash, lastValidBlockHeight: 300 } },
      simulateTransaction: { context: { slot: 120 }, value: { err: null } }, sendTransaction: f.wire.signature,
      getSignatureStatuses: { context: { slot: 130 }, value: [{ slot: 123, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: 'finalized' }] },
      getTransaction: transactionFixture(f), ...overrides } as Record<string,unknown>)[request.method];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
  });
  const transport = new QuickNodePaidToolTransport({ endpointUrl, fetch: fetcher as typeof fetch, now: () => now, capture: async value => { captures.push(value); } });
  return { ...f, captures, fetcher, transport };
}
afterEach(() => vi.useRealTimers());
describe('private paid-tool transport (synthetic fetch only)', () => {
  it('rejects arbitrary hosts, plain HTTP, absent token and query credentials without requests', () => {
    for (const url of ['http://test.quiknode.pro/token/', 'https://example.com/token/', 'https://test.quiknode.pro/', 'https://test.quiknode.pro/token/?key=a', 'https://user@test.quiknode.pro/token/']) {
      expect(() => new QuickNodePaidToolTransport({ endpointUrl: url, capture: async () => {} })).toThrow('CONFIGURATION_INVALID');
    }
  });
  it('prepares exact current readiness and captures every response before returning evidence', async () => {
    const f = fixture(); expect(f.fetcher).not.toHaveBeenCalled();
    const value = await f.transport.inspectReady(f.intent, 'ready', signal());
    expect(value.balances.sourceBalanceBaseUnits).toBe('500000'); expect(value.balances.feePayerLamports).toBe('1000000000');
    expect(f.captures).toHaveLength(4); expect(f.captures.map(x => x.method).sort()).toEqual(['getBlockHeight','getFeeForMessage','getGenesisHash','getMultipleAccounts']);
    for (const [url, options] of f.fetcher.mock.calls) { expect(url).toBe(endpointUrl); expect(options?.redirect).toBe('error'); expect(options?.credentials).toBe('omit'); }
  });
  it('rejects stale blockheight, changed fee, wrong genesis and expired intent', async () => {
    for (const overrides of [{getBlockHeight:301}, {getFeeForMessage:{context:{slot:120},value:6000}}, {getGenesisHash:'wrong'}]) {
      const f=fixture(overrides); await expect(f.transport.inspectReady(f.intent,'bad',signal())).rejects.toThrow();
    }
    const f=fixture(); await expect(f.transport.inspectReady({...f.intent,validUntil:now},'expired',signal())).rejects.toThrow('EXPIRED'); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('returns fee/blockhash candidates and simulation without payment claims', async () => {
    const f=fixture(); expect((await f.transport.latestBlockhash('100','hash',signal())).blockhash).toBe(f.intent.blockhash);
    expect((await f.transport.quoteFee(f.intent,'fee',signal())).feeLamports).toBe('5000');
    expect((await f.transport.simulate(f.wire,'simulation',signal())).finalized).toBe(false);
  });
  it('submits original bytes once, with no RPC retries and no finality inference', async () => {
    const f=fixture(); expect((await f.transport.submit(f.wire,'submit',signal())).disposition).toBe('submitted');
    expect(f.fetcher).toHaveBeenCalledTimes(1); const request=JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
    expect(request.params[0]).toBe(f.wire.wireBase64); expect(request.params[1]).toMatchObject({maxRetries:0,skipPreflight:false});
  });
  it('retains uncertain submission on acknowledgement mismatch or capture failure', async () => {
    const f=fixture({sendTransaction:transferFixture().wire.signature}); expect(await f.transport.submit(f.wire,'wrong',signal())).toEqual({disposition:'unknown'}); expect(f.fetcher).toHaveBeenCalledTimes(1);
    const t=new QuickNodePaidToolTransport({endpointUrl,fetch:f.fetcher as typeof fetch,now:()=>now,capture:async()=>{throw Error('offline');}});
    expect(await t.submit(f.wire,'capture',signal())).toEqual({disposition:'unknown'}); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('requires exact finalized transfer observations', async () => {
    const f=fixture(); const result=await f.transport.observeFinality(f.wire,'final',signal()); expect(result.disposition).toBe('finalized');
    const pending=fixture({getTransaction:null}); expect(await pending.transport.observeFinality(pending.wire,'pending',signal())).toEqual({disposition:'unknown'});
  });
  it('rejects non200/wrong type/oversize and cancels response bodies', async () => {
    for (const options of [{status:503},{headers:{'content-type':'text/html'}},{headers:{'content-type':'application/json','content-length':'131073'}}] as ResponseInit[]) {
      const cancelled=vi.fn(); const body=new ReadableStream<Uint8Array>({cancel:cancelled});
      const t=new QuickNodePaidToolTransport({endpointUrl,fetch:vi.fn(async()=>new Response(body,options)) as typeof fetch,capture:async()=>{}});
      await expect(t.latestBlockhash('0','bad',signal())).rejects.toThrow(); expect(cancelled).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds stalled fetch, body and evidence capture to eight seconds', async () => {
    vi.useFakeTimers();
    for (const stage of ['fetch','body','capture']) {
      const f=fixture(); const fetcher=stage==='fetch'?vi.fn(()=>new Promise<Response>(()=>{})):stage==='body'?vi.fn(async()=>new Response(new ReadableStream(),{headers:{'content-type':'application/json'}})):f.fetcher;
      const t=new QuickNodePaidToolTransport({endpointUrl,fetch:fetcher as typeof fetch,now:()=>now,capture:stage==='capture'?()=>new Promise(()=>{}):async()=>{}});
      const promise=t.submit(f.wire,'timeout',signal()); await vi.advanceTimersByTimeAsync(8001); expect(await promise).toEqual({disposition:'unknown'}); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('stops pre-aborted requests without making a network call', async () => {
    const f=fixture(), abort=new AbortController(); abort.abort(); expect(await f.transport.submit(f.wire,'abort',abort.signal)).toEqual({disposition:'unknown'}); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
