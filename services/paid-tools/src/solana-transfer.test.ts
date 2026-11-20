import { describe, expect, it } from 'vitest';
import { buildPaidTransferMessage, decodePaidTransferMessage, verifyPaidTransferWire, inspectPaidTransferAccounts } from './solana-transfer.js';
import { inspectPaidTransferFinality } from './solana-finality.js';
import { transferFixture, accountFixture, readFixture, publicAddress, finalityFixture, transactionFixture, now } from './solana-fixtures.test-support.js';

describe('strict offline SPL paid transfer', () => {
  it.each([false, true])('builds and verifies exact legacy message with separate payer=%s', separate => {
    const f = transferFixture(separate);
    expect(decodePaidTransferMessage(f.messageBytes)).toMatchObject({ sourceAccount: f.intent.sourceAccount, destinationAccount: f.intent.destinationAccount,
      sourceOwner: f.intent.sourceOwner, feePayer: f.intent.feePayer, amountBaseUnits: '10000', blockhash: f.intent.blockhash });
    expect(verifyPaidTransferWire(f.wireBytes, f.intent).signature).toBe(f.signatures[0]);
    expect(f.message.signerAddresses).toHaveLength(separate ? 2 : 1);
  });
  it('rejects changed recipient, amount, blockhash and signer', () => {
    const f = transferFixture();
    for (const change of [{ destinationAccount: publicAddress(5) }, { amountBaseUnits: '10001' }, { blockhash: publicAddress(5) }, { sourceOwner: publicAddress(5) }]) {
      expect(() => verifyPaidTransferWire(f.wireBytes, { ...f.intent, ...change })).toThrow();
    }
    const bad = Buffer.from(f.wireBytes); bad[2] ^= 1;
    expect(() => verifyPaidTransferWire(bad, f.intent)).toThrow();
  });
  it('rejects extra instruction/trailing bytes/versioned/extra privilege encodings', () => {
    const f = transferFixture();
    const readonly = Buffer.from(f.messageBytes); readonly[2] = 1;
    const versioned = Buffer.concat([Buffer.from([128]), f.messageBytes]);
    const extra = Buffer.concat([f.messageBytes, Buffer.from([0])]);
    const overlongCount = Buffer.concat([f.messageBytes.subarray(0, 3), Buffer.from([133, 0]), f.messageBytes.subarray(4)]);
    for (const bytes of [readonly, versioned, extra, overlongCount]) expect(() => decodePaidTransferMessage(bytes)).toThrow();
  });
  it('rejects alias/self payment, non-devnet assets, zero amount and fee over cap', () => {
    const f = transferFixture();
    for (const change of [{ destinationAccount: f.intent.sourceAccount }, { destinationOwner: f.intent.sourceOwner }, { genesis: publicAddress(5) },
      { mint: publicAddress(5) }, { decimals: 9 }, { amountBaseUnits: '0' }, { amountBaseUnits: '18446744073709551616' }, { maximumFeeLamports: '4999' }]) {
      expect(() => buildPaidTransferMessage({ ...f.intent, ...change } as typeof f.intent)).toThrow();
    }
  });
  it('verifies every signature with separate payer', () => {
    const f = transferFixture(true), bytes = Buffer.from(f.wireBytes); bytes[70] ^= 1;
    expect(() => verifyPaidTransferWire(bytes, f.intent)).toThrow();
  });
});
describe('qualified account evidence comparison', () => {
  it.each([false, true])('requires pinned mint and exact source/destination/payer accounts %s', async separate => {
    const f = transferFixture(separate), accounts = accountFixture(f.intent);
    const genesis = await readFixture('genesis', { method: 'getGenesisHash' }, f.intent.genesis);
    const evidence = await readFixture('accounts', { method: 'getMultipleAccounts', addresses: accounts.addresses }, accounts.result);
    expect(await inspectPaidTransferAccounts(f.intent, genesis, evidence, now)).toMatchObject({ authority: 'none', sourceBalanceBaseUnits: '500000', slot: '120' });
    await expect(inspectPaidTransferAccounts(f.intent, genesis, evidence, f.intent.validUntil)).rejects.toThrow();
  });
  it('rejects frozen/delegated/close authority, wrong owners and insufficient funds', async () => {
    const f = transferFixture(), genesis = await readFixture('genesis', { method: 'getGenesisHash' }, f.intent.genesis);
    for (const mutation of [
      (a: ReturnType<typeof accountFixture>) => { a.source[108] = 2; a.result.value[1]!.data[0] = a.source.toString('base64'); },
      (a: ReturnType<typeof accountFixture>) => { a.source.writeUInt32LE(1, 72); a.result.value[1]!.data[0] = a.source.toString('base64'); },
      (a: ReturnType<typeof accountFixture>) => { a.destination.writeUInt32LE(1, 129); a.result.value[2]!.data[0] = a.destination.toString('base64'); },
      (a: ReturnType<typeof accountFixture>) => { a.result.value[1]!.owner = publicAddress(7); },
      (a: ReturnType<typeof accountFixture>) => { a.source.writeBigUInt64LE(9999n, 64); a.result.value[1]!.data[0] = a.source.toString('base64'); },
      (a: ReturnType<typeof accountFixture>) => { a.result.value[3]!.lamports = 4999; },
    ]) {
      const accounts = accountFixture(f.intent); mutation(accounts);
      const evidence = await readFixture('accounts', { method: 'getMultipleAccounts', addresses: accounts.addresses }, accounts.result);
      await expect(inspectPaidTransferAccounts(f.intent, genesis, evidence, now)).rejects.toThrow();
    }
  });
});
describe('exact finalized transfer evidence', () => {
  it.each([false, true])('accepts exact confirmed ledger and token deltas with separate payer=%s', async separate => {
    const f = transferFixture(separate), evidence = await finalityFixture(f);
    expect(await inspectPaidTransferFinality(f.wire, evidence.genesis, evidence.status, evidence.transaction, now)).toMatchObject({
      status: 'finalized_transfer', signature: f.wire.signature, amountBaseUnits: '10000', feeLamports: f.intent.feeLamports });
  });
  it('rejects recipient delta, hidden fee delta, header/blockhash and extra instruction changes', async () => {
    const f = transferFixture();
    for (const mutation of [
      (tx: ReturnType<typeof transactionFixture>) => { tx.meta.postTokenBalances[1]!.uiTokenAmount.amount = '9999'; },
      (tx: ReturnType<typeof transactionFixture>) => { tx.meta.postBalances[1]! -= 1; },
      (tx: ReturnType<typeof transactionFixture>) => { tx.transaction.message.header.numReadonlyUnsignedAccounts = 1; },
      (tx: ReturnType<typeof transactionFixture>) => { tx.transaction.message.recentBlockhash = publicAddress(7); },
      (tx: ReturnType<typeof transactionFixture>) => { tx.transaction.message.instructions.push(tx.transaction.message.instructions[0]!); },
    ]) {
      const evidence = await finalityFixture(f, mutation);
      await expect(inspectPaidTransferFinality(f.wire, evidence.genesis, evidence.status, evidence.transaction, now)).rejects.toThrow();
    }
  });
  it('rejects confirmed-only/null/failed status and forged projected flags', async () => {
    const f = transferFixture(), evidence = await finalityFixture(f);
    for (const row of [null, { slot: 123, confirmations: 1, err: null, confirmationStatus: 'confirmed' },
      { slot: 123, confirmations: null, err: 'AccountNotFound', confirmationStatus: 'finalized' }]) {
      const status = await readFixture('bad_status', { method: 'getSignatureStatuses', signatures: [f.wire.signature] }, { context: { slot: 130 }, value: [row] });
      // Even an internal caller substituting successful projection flags cannot
      // override retained raw provider evidence.
      const forged = { ...status, outcome: evidence.status.outcome };
      await expect(inspectPaidTransferFinality(f.wire, evidence.genesis, forged, evidence.transaction, now)).rejects.toThrow();
    }
  });
  it('rejects tampered evidence bytes and unverified wire-shaped objects', async () => {
    const f = transferFixture(), evidence = await finalityFixture(f);
    const corrupt = { ...evidence.transaction, evidence: { ...evidence.transaction.evidence!, sha256: 'a'.repeat(64) } };
    await expect(inspectPaidTransferFinality(f.wire, evidence.genesis, evidence.status, corrupt, now)).rejects.toThrow();
    await expect(inspectPaidTransferFinality({ ...f.wire }, evidence.genesis, evidence.status, evidence.transaction, now)).rejects.toThrow();
  });
});
