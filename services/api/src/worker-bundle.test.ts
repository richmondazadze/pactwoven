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
  async function bundle(role: 'api' | 'provisioner' | 'mandate' | 'financial'): Promise<string> {
    const config = fileURLToPath(new URL(`../wrangler.${role}.json`, import.meta.url));
    const output = join(directory, role);
    await run(process.execPath, [wrangler, 'deploy', '--dry-run', '--config', config, '--outdir', output], { timeout: 20_000 });
    return readFile(join(output, role === 'api' ? 'worker.js' : `${role}-worker.js`), 'utf8');
  }
  try {
    const publicBundle = await bundle('api'), privateBundle = await bundle('provisioner'), mandateBundle = await bundle('mandate');
    for (const marker of ['createClerkClient', 'createClerkStepUpVerifier', 'createClerkMembershipDirectory', 'createAccessGateway',
      'SELECT pactwoven.bootstrap_organization(', 'SELECT pactwoven.change_member_access(', 'SELECT pactwoven.read_member_access(', 'SELECT pactwoven.read_access_operation(']) {
      expect(publicBundle, `Public bundle contains ${marker}`).not.toContain(marker);
      expect(privateBundle, `Private bundle lost ${marker}`).toContain(marker);
    }
    expect(publicBundle).toContain('internal/access/dispatch');
    expect(publicBundle).toContain('serviceAccessGateway');
    for (const marker of ['createAccessRecoveryGateway', 'createClerkAccessRecoveryStepUpVerifier',
      'PostgresAccessRecoveryRepository', 'SELECT pactwoven.read_access_recovery(', 'SELECT pactwoven.close_access_recovery(']) {
      expect(publicBundle, `Public bundle contains ${marker}`).not.toContain(marker);
      expect(privateBundle, `Identity bundle lost ${marker}`).toContain(marker);
      expect(mandateBundle, `Mandate bundle contains ${marker}`).not.toContain(marker);
    }
    expect(publicBundle).toContain('internal/access-recovery/dispatch');
    expect(publicBundle).toContain('serviceAccessRecoveryGateway');
    for (const marker of ['createMandateGateway', 'createClerkMandateStepUpVerifier', 'createMandatePool',
      'PostgresMandateRepository', 'pactwoven.mandate_resolve_context(']) {
      expect(publicBundle, `Public bundle contains ${marker}`).not.toContain(marker);
      expect(privateBundle, `Identity bundle contains ${marker}`).not.toContain(marker);
      expect(mandateBundle, `Mandate bundle lost ${marker}`).toContain(marker);
    }
    for (const marker of ['SELECT pactwoven.bootstrap_organization(', 'SELECT pactwoven.change_member_access(',
      'SELECT pactwoven.read_member_access(', 'SELECT pactwoven.read_access_operation(']) {
      expect(mandateBundle, `Mandate bundle contains ${marker}`).not.toContain(marker);
    }
    expect(publicBundle).toContain('internal/mandates/dispatch');
    expect(publicBundle).toContain('serviceMandateGateway');
    for (const marker of ['createClerkFinancialPolicyVerifier', 'createClerkCustodySetupVerifier',
      'createSupplierRelationshipService', 'PostgresFinancialPolicyRepository', 'PostgresCustodySetupRepository',
      'PostgresSupplierRelationshipRepository', 'SELECT pactwoven.financial_policy_attest(', 'SELECT pactwoven.supplier_record_evidence(']) {
      expect(publicBundle, `Public bundle contains ${marker}`).not.toContain(marker);
    }
    expect(publicBundle).toContain('internal/financial/dispatch');
    expect(publicBundle).toContain('serviceFinancialGateways');
    expect(publicBundle).toContain('serviceSupplierRelationshipGateway');
    const financialBundle = await bundle('financial');
    for (const marker of ['createFinancialPolicyClosureGateway', 'PostgresFinancialPolicyClosureRepository',
      'SELECT pactwoven.financial_policy_close_original(', 'SELECT pactwoven.financial_policy_original_status(']) {
      expect(publicBundle, `Public bundle contains ${marker}`).not.toContain(marker);
      expect(financialBundle, `Private financial bundle lost ${marker}`).toContain(marker);
    }
    expect(publicBundle).toContain('policy-close-original');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 45_000);
