import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = path.join(root, 'services/native-host');
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];

// Workspace packages export TypeScript for local development. Bundle them here
// so a deployed Node launcher never depends on a transpiler's path remapping.
export async function buildNativeHost(outdir = path.join(host, 'dist'), service = 'native-host') {
  if (!['native-api', 'native-host', 'paid-signer'].includes(service)) throw Error('Unknown native service.');
  const sourceHost = path.join(root, 'services', service);
  const entries = service === 'native-host' ? ['index', 'consume', 'consume-delegated', 'consume-paid', 'recover'] : ['index'];
  const manifest = JSON.parse(await readFile(path.join(sourceHost, 'package.json'), 'utf8'));
  const external = Object.entries(manifest.dependencies)
    .filter(([name]) => !name.startsWith('@pactwoven/')).map(([name]) => name);
  const result = await build({
    absWorkingDir: root,
    entryPoints: Object.fromEntries(entries.map(name =>
      [name, path.join(sourceHost, 'src/handlers', `${name}.ts`)])),
    outdir, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node',
    // Prefer the package's ESM entry when bundling into ESM. jsonc-parser's
    // legacy UMD entry retains dynamic require calls that cannot run here.
    target: 'node24', format: 'esm', mainFields: ['module', 'main'], external, metafile: true, write: false,
    sourcemap: false, legalComments: 'inline', logLevel: 'silent',
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    if (path.isAbsolute(input) || input.startsWith('../') || /(?:^|\/)\.env(?:\.|$)/.test(input)) {
      throw Error('Native bundle contains an unreviewed input path.');
    }
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (!dependency.external || (!builtins.has(dependency.path) && !external.includes(packageName(dependency.path)))) {
        throw Error('Native bundle contains an undeclared runtime dependency.');
      }
    }
  }
  for (const file of result.outputFiles) {
    if (file.text.includes(root) || file.text.includes('sourceMappingURL=')) {
      throw Error('Native bundle contains a local path or source map.');
    }
  }
  await mkdir(outdir, { recursive: true });
  await Promise.all(result.outputFiles.map(file => writeFile(file.path, file.contents)));
  return { entries: result.outputFiles.length, workspaceInputs: Object.keys(result.metafile.inputs)
    .filter(input => /^(?:services|packages)\//.test(input)).length,
  outputs: Object.fromEntries(Object.entries(result.metafile.outputs).map(([name, output]) =>
    [path.basename(name), { bytes: output.bytes, imports: [...new Set(output.imports.map(item => item.path))] }])) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = process.argv[2] ?? 'native-host';
  console.log(JSON.stringify(await buildNativeHost(path.join(root, 'services', service, 'dist'), service), null, 2));
}
