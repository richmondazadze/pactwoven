import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = path.join(root, 'programs/pactwoven');
const idlPath = path.join(root, 'target/idl/pactwoven.json');
const binaryPath = path.join(root, 'target/deploy/pactwoven.so');
const programAddress = '5UaivPxV8oQypy5mxmQCzvZXHVSMkPsZ2TKJvszyebVG';
const bytes = await readFile(idlPath);
if (bytes.byteLength > 1_048_576) throw new Error('IDL exceeds the bounded initialization contract');
const idl = JSON.parse(bytes.toString('utf8'));
if (idl.address !== programAddress) throw new Error('IDL program address does not match the reviewed program');
const expectedInstructions = new Map([
  ['initialize_program_config', '06833ded286e537c'],
  ['initialize_custody', 'e5dae478d0efdfea'],
]);
const expectedAccounts = new Map([
  ['ProgramConfig', 'c4d25ae790958c3f'],
  ['CustodyRegistration', '0b60a2459fd15947'],
]);
function validateDefinitions(definitions, expected, category) {
  if (!Array.isArray(definitions) || definitions.length !== expected.size) throw new Error(`Unexpected ${category} count`);
  const seen = new Set();
  for (const definition of definitions) {
    const target = expected.get(definition.name);
    const discriminator = definition.discriminator;
    if (!target || seen.has(definition.name) || !Array.isArray(discriminator) || discriminator.length !== 8
      || discriminator.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
      || Buffer.from(discriminator).toString('hex') !== target) {
      throw new Error(`Unexpected ${category} definition`);
    }
    seen.add(definition.name);
  }
}
validateDefinitions(idl.instructions, expectedInstructions, 'instruction');
validateDefinitions(idl.accounts, expectedAccounts, 'account');
const binary = await readFile(binaryPath);
if (binary.byteLength < 4 || binary.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error('An actual SBF ELF build is required');
const digest = (value) => createHash('sha256').update(value).digest('hex');
await createFromRoot(rootNodeFromAnchor(idl)).accept(renderVisitor(packageRoot, {
  generatedFolder: 'client/src/generated',
  syncPackageJson: false,
  deleteFolderBeforeRendering: true,
  kitImportStrategy: 'rootOnly',
  importExtension: 'js',
  erasableSyntax: true,
  formatCode: false,
}));
// Renderer 2.9.0 passes an explicitly undefined optional address in its plugin.
// Materialize the identical builder default without weakening exactOptionalPropertyTypes.
const pluginPath = path.join(packageRoot, 'client/src/generated/programs/pactwoven.ts');
const pluginSource = await readFile(pluginPath, 'utf8');
const optionalAddress = 'programAddress: instructionConfig?.programAddress ?? config.programAddress';
if (pluginSource.split(optionalAddress).length !== 3) throw new Error('Review changed Codama optional-address output');
const strictPlugin = pluginSource.replaceAll(optionalAddress, `${optionalAddress} ?? PACTWOVEN_PROGRAM_ADDRESS`);
await writeFile(pluginPath, strictPlugin);
await mkdir(path.join(root, '.local/chain-0b'), { recursive: true });
await writeFile(path.join(root, '.local/chain-0b/generation.json'), JSON.stringify({
  programAddress,
  idlSha256: digest(bytes),
  binarySha256: digest(binary),
  generatorSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  rendererPluginSha256: digest(pluginSource),
  strictPluginSha256: digest(strictPlugin),
  status: 'generated-from-local-build; independent review and runtime qualification pending',
}, null, 2) + '\n');
process.stdout.write('Generated the initialization client from the local build IDL.\n');
