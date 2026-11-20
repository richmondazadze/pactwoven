import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { address, createKeyPairSignerFromBytes } from '@solana/kit';
import { base58, publicKeyBytes } from './independent-layout.js';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const localEvidenceDirectory = path.join(repositoryRoot, '.local/chain-0b');
export const executionManifestPath = path.join(localEvidenceDirectory, 'execution-manifest.json');

export function assertLoopbackRpc(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('Local tests require an explicit numeric-loopback RPC port');
  return url.origin;
}

export interface LocalExecutionManifest {
  schema: 'pactwoven-chain0-local-v1';
  rpcUrl: string;
  expectedGenesis: string;
  signers: { rentPayer: string; bootstrapAuthority: string; registrar: string; owner: string; intruder: string };
}

export async function loadExecutionManifest(): Promise<LocalExecutionManifest> {
  if (process.env['PACTWOVEN_CHAIN0_LOCAL_EXECUTION'] !== '1') throw new Error('Local chain execution is not enabled');
  const parsed: unknown = JSON.parse(await readFile(executionManifestPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid local execution manifest');
  const input = parsed as Record<string, unknown>;
  if (input['schema'] !== 'pactwoven-chain0-local-v1' || typeof input['rpcUrl'] !== 'string'
    || typeof input['expectedGenesis'] !== 'string' || !input['signers'] || typeof input['signers'] !== 'object') {
    throw new Error('Invalid local execution manifest');
  }
  const genesis = base58(publicKeyBytes(input['expectedGenesis']));
  if (genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
    || genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2d6t') throw new Error('Public clusters are forbidden in local tests');
  const signers = input['signers'] as Record<string, unknown>;
  for (const role of ['rentPayer', 'bootstrapAuthority', 'registrar', 'owner', 'intruder']) {
    if (typeof signers[role] !== 'string') throw new Error('A required local signer path is missing');
  }
  return {
    schema: 'pactwoven-chain0-local-v1', rpcUrl: assertLoopbackRpc(input['rpcUrl']), expectedGenesis: genesis,
    signers: signers as LocalExecutionManifest['signers'],
  };
}

export async function loadProtectedTestSigner(file: string) {
  const root = path.join(repositoryRoot, '.local');
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Test keys must remain under ignored .local');
  // Check every path component: a protected leaf must not escape through a symlink.
  const relative = path.relative(repositoryRoot, absolute);
  let current = repositoryRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Test key paths may not contain symlinks');
  }
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 1024) throw new Error('Test key file is not private and bounded');
  const value: unknown = JSON.parse(await readFile(absolute, 'utf8'));
  if (!Array.isArray(value) || value.length !== 64 || value.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
    throw new Error('Invalid local test key encoding');
  }
  return createKeyPairSignerFromBytes(new Uint8Array(value));
}

// Genesis fixtures are synthetic test bytes. This function creates no keys or accounts.
export function syntheticMintFixture(overrides: { decimals?: number; mintAuthority?: string; freezeAuthority?: string } = {}) {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0);
  data.set(publicKeyBytes(overrides.mintAuthority ?? 'GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz'), 4);
  data.writeBigUInt64LE(0n, 36);
  data[44] = overrides.decimals ?? 6;
  data[45] = 1;
  data.writeUInt32LE(1, 46);
  data.set(publicKeyBytes(overrides.freezeAuthority ?? 'CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT'), 50);
  return { pubkey: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', account: {
    lamports: 10_000_000, data: [data.toString('base64'), 'base64'],
    owner: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    executable: false, rentEpoch: 0,
  } };
}
