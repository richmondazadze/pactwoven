import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const forbiddenDirectories = new Set([
  'docs', 'documentation', 'evidence', '.local', 'secrets', '.secrets', 'credentials',
  'node_modules', '.git', '.next', '.open-next', '.turbo', '.wrangler', '.vercel', 'coverage',
  'playwright-report', 'test-results', 'dist', 'build', 'target',
]);
const sourceExtensions = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss',
  '.html', '.json', '.sql', '.rs', '.toml', '.yaml', '.yml', '.sh', '.py', '.tf',
  '.hcl', '.graphql', '.gql', '.wasm', '.svg', '.png', '.jpg', '.jpeg', '.webp',
  '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf',
]);
const binaryExtensions = new Set(['.wasm', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf']);
const rootFiles = new Set([
  '.gitignore', '.gitattributes', '.node-version', '.nvmrc', '.npmrc', '.dockerignore',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json', 'Dockerfile',
  'Makefile', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'Anchor.toml',
]);
const codeRoots = new Set(['apps', 'services', 'packages', 'programs', 'scripts', 'infra', 'tests']);

// Legal notices must accompany shipped assets. This deliberately does not allow .md.
function isLegalNotice(name) {
  return /^(?:(?:[a-z0-9][a-z0-9._-]*)[-.])?(?:license|licence|notice|copying|copyright)(?:\.txt)?$/i.test(name)
    || /^third[-_]party[-_]notices(?:\.txt)?$/i.test(name);
}

export function inspectPath(file) {
  if (!file || path.posix.isAbsolute(file) || file.includes('\\') || /[\x00-\x1f\x7f]/.test(file)) return 'invalid repository path';
  const parts = file.split('/');
  if (parts.some((part) => part === '.' || part === '..' || !part)) return 'path traversal or noncanonical path';
  const lower = parts.map((part) => part.toLowerCase());
  const name = lower.at(-1);
  if (lower.slice(0, -1).some((part) => forbiddenDirectories.has(part))) return 'local, documentation, secret, or generated directory';
  if (/\.(?:md|mdx|markdown|rst|adoc|docx?|pdf|rtf|odt|pptx?|xlsx?|csv|tsv|log|bak|tmp|tsbuildinfo)$/i.test(name)) return 'documentation, evidence, or generated artifact';
  if (/^(?:\.env(?:\.|$)|\.envrc(?:\.|$)|\.dev\.vars(?:\.|$)|dotenv(?:\.|$))/.test(name)
    || /\.env(?:\.|$)/.test(name)
    || /^(?:env|environment)[._-](?:example|sample|template|local|development|production|staging)(?:[._-]|$)/.test(name)) return 'environment file (including examples)';
  if (/\.(?:pem|key|p12|pfx|keystore|jks)$/.test(name)
    || /(?:^|[-_.])(?:keypair|private[-_]?key|service[-_]?account|credentials?)(?:[-_.]|$)/.test(name)
    || /^(?:id(?:_rsa|_dsa|_ecdsa|_ed25519)?|wallet)\.json$/.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name)) return 'credential or wallet material';
  if (isLegalNotice(name)) return null;
  if (parts.length === 1) {
    if (rootFiles.has(file) || /^(?:tsconfig(?:\.[\w-]+)?\.json|(?:vitest|eslint|prettier)\.config\.[cm]?[jt]s)$/.test(file)) return null;
    return 'unreviewed root artifact type';
  }
  if (parts[0] === '.github') return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) ? null : 'unreviewed GitHub artifact';
  if (!codeRoots.has(parts[0])) return 'outside approved implementation directories';
  if (file === 'apps/web/wrangler.jsonc' || file === 'apps/web/public/_headers') return null;
  if (/^(?:Dockerfile(?:\.[\w-]+)?|Makefile|Cargo\.lock|\.gitignore|\.dockerignore)$/.test(parts.at(-1))) return null;
  return sourceExtensions.has(path.posix.extname(name)) ? null : 'unreviewed artifact type';
}

// Signatures identify concrete credential formats, not arbitrary high-entropy code.
// Findings contain rule names only; never return matched credential bytes.
const secretRules = [
  ['private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['service secret key', /\b(?:sk_(?:live|test)_[A-Za-z0-9]{20,}|sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|whsec_[A-Za-z0-9]{20,})\b/],
  ['Google API or OAuth secret', /\b(?:AIza[A-Za-z0-9_-]{35}|GOCSPX-[A-Za-z0-9_-]{20,})\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['signed bearer token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/],
  ['credential-bearing connection URI', /\b(?:postgres(?:ql)?|mysql|redis|rediss|amqps?):\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['cloud connection secret', /\b(?:AccountKey|SharedAccessKey)\s*=\s*[A-Za-z0-9+/]{24,}={0,2}/],
  ['literal private scalar', /["']?(?:private[_-]?key|secret[_-]?key)["']?\s*[:=]\s*["'](?:0x)?[a-f0-9]{64}["']/i],
];

export function inspectContent(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
  const findings = secretRules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  // Solana CLI secret keypairs are 64-byte JSON arrays; public keys are not.
  for (const match of text.matchAll(/\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/g)) {
    const bytes = match[0].slice(1, -1).split(',').map(Number);
    if (bytes.every((byte) => byte >= 0 && byte <= 255)) { findings.push('64-byte wallet keypair'); break; }
  }
  return [...new Set(findings)];
}

export function inspectSupplyChain(file, content) {
  const findings = [];
  if (path.posix.basename(file) === 'package.json') {
    let manifest;
    try { manifest = JSON.parse(content); } catch { return ['invalid package manifest']; }
    for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
      if (['preinstall', 'install', 'postinstall', 'prepare'].includes(name)) findings.push('automatic package lifecycle script requires review');
      if (typeof script !== 'string' || /(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|fi)?sh\b/.test(script)) findings.push('unreviewed remote script execution');
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const version of Object.values(manifest[section] ?? {})) {
        if (typeof version !== 'string' || !/^(?:\d+\.\d+\.\d+(?:-[\w.-]+)?|workspace:(?:\*|\^|~|\d+\.\d+\.\d+)|npm:(?:@[^/]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(version)) findings.push('dependency must use a reviewed exact version or workspace reference');
      }
    }
    if (Object.keys(manifest.pnpm ?? {}).some((key) => /build|script|pnpmfile/i.test(key))) findings.push('dependency build policy belongs in the reviewed workspace configuration');
  }
  if (file === 'pnpm-workspace.yaml') {
    if (/^\s*["']?(?:dangerouslyAllowAllBuilds|onlyBuiltDependencies|onlyBuiltDependenciesFile|neverBuiltDependencies|ignoredBuiltDependencies|pnpmfile|globalPnpmfile)["']?\s*:/m.test(content)) findings.push('unreviewed dependency build policy');
    if ((content.match(/^[ \t]*["']?allowBuilds["']?[ \t]*:/gm) ?? []).length !== 1) findings.push('dependency build approval must be declared exactly once');
    const block = /^allowBuilds:[ \t]*\r?\n((?:[ \t]+[^\n]*\r?\n?)*)/m.exec(content)?.[1];
    if (!block || block.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).some((line) => !/^\s+(?:esbuild|workerd@1\.20261113\.1):\s*true\s*$/.test(line))) findings.push('only reviewed esbuild and pinned workerd dependency builds are permitted');
  }
  if (file === '.npmrc' && /(?:allow[-_]?build|built[-_]?depend|pnpmfile|ignore[-_]?scripts|enable[-_]?pre[-_]?post[-_]?scripts)/i.test(content)) findings.push('dependency execution configuration requires review');
  return [...new Set(findings)];
}

function git(cwd, args, encoding = 'utf8') {
  const result = spawnSync('git', args, { cwd, encoding, maxBuffer: 16 * 1024 * 1024, shell: false });
  if (result.error || result.status !== 0) throw new Error('Git inspection failed; no publication verdict is available.');
  return result.stdout;
}

export function checkPublication({ root = process.cwd(), tracked = false } = {}) {
  const selected = tracked ? null : new Set(git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z', '--']).split('\0').filter(Boolean));
  const records = git(root, ['ls-files', '--stage', '-z', '--']).split('\0').filter(Boolean);
  const findings = [];
  let count = 0;
  for (const record of records) {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) (\d)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Invalid Git index entry; no publication verdict is available.');
    const [, mode, oid, stage, file] = match;
    if (selected && !selected.has(file)) continue;
    count += 1;
    const add = (rule) => findings.push({ file, rule });
    const pathProblem = inspectPath(file);
    if (pathProblem) add(pathProblem);
    if (stage !== '0') { add('unmerged index entry'); continue; }
    if (mode !== '100644' && mode !== '100755') { add('symlink or submodule cannot be inspected as implementation source'); continue; }
    const size = Number(git(root, ['cat-file', '-s', oid]).trim());
    if (!Number.isSafeInteger(size) || size > 12 * 1024 * 1024) { add('artifact exceeds publication inspection limit'); continue; }
    const content = git(root, ['cat-file', 'blob', oid], null);
    for (const rule of inspectContent(content)) add(rule);
    for (const rule of inspectSupplyChain(file, content.toString('utf8'))) add(rule);
    if (content.includes(0) && !binaryExtensions.has(path.posix.extname(file).toLowerCase())) add('unexpected binary content in source');
  }
  return { mode: tracked ? 'tracked index' : 'staged changes', count, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--tracked') || args.length > 1) {
    process.stderr.write('Usage: node scripts/check-publication.mjs [--tracked]\n');
    process.exitCode = 2;
  } else {
    try {
      const result = checkPublication({ tracked: args.includes('--tracked') });
      for (const finding of result.findings) process.stderr.write(`${JSON.stringify(finding.file)}: ${finding.rule}\n`);
      process.stdout.write(`Publication check: ${result.count} ${result.mode} files inspected; ${result.findings.length} findings.\n`);
      process.exitCode = result.findings.length ? 1 : 0;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    }
  }
}
