import { assertDevelopmentWorkerDeployment } from './worker-deployment.js';

// Read the two configs, fresh sanitized Hyperdrive observations and Worker
// secret-name inventories on stdin. Never supply or echo secret values.
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
