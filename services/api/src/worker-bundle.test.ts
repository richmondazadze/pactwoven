import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('keeps administrative Clerk, MFA issuance and privileged SQL out of the compiled public Worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pactwoven-worker-bundle-'));
  const wrangler = fileURLToPath(new URL('../../../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  async function bundle(role: 'api' | 'provisioner'): Promise<string> {
    const config = fileURLToPath(new URL(`../wrangler.${role}.json`, import.meta.url));
    const output = join(directory, role);
    await run(process.execPath, [wrangler, 'deploy', '--dry-run', '--config', config, '--outdir', output], { timeout: 20_000 });
    return readFile(join(output, role === 'api' ? 'worker.js' : 'provisioner-worker.js'), 'utf8');
  }
  try {
    const publicBundle = await bundle('api'), privateBundle = await bundle('provisioner');
    for (const marker of ['createClerkClient', 'createClerkStepUpVerifier', 'createClerkMembershipDirectory', 'createAccessGateway',
      'SELECT pactwoven.bootstrap_organization(', 'SELECT pactwoven.change_member_access(', 'SELECT pactwoven.read_member_access(', 'SELECT pactwoven.read_access_operation(']) {
      expect(publicBundle, `Public bundle contains ${marker}`).not.toContain(marker);
      expect(privateBundle, `Private bundle lost ${marker}`).toContain(marker);
    }
    expect(publicBundle).toContain('internal/access/dispatch');
    expect(publicBundle).toContain('serviceAccessGateway');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 45_000);
