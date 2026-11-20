import { assertDevelopmentWorkerDeployment } from './worker-deployment.js';

// Read the base configs and optional financial/supplier profiles, fresh sanitized
// Hyperdrive observations and Worker secret inventories on stdin. Supplier
// inventory entries must retain {name,type:'secret_text'} from the control plane;
// base/financial inventories retain their existing name-only contract.
// Never supply or echo secret values. Private lane JSON is validated, not logged.
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 1_048_576) throw new Error('Oversized configuration input');
  }
  assertDevelopmentWorkerDeployment(JSON.parse(input));
  console.info('Development Worker deployment configuration passed.');
} catch {
  console.error('Development Worker deployment configuration rejected; verify bindings, isolation, caching, TLS and development scope.');
  process.exitCode = 1;
}
