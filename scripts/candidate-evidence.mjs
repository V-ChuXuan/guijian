import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const coreChecks = ['node_tests', 'frontend_tests', 'frontend_build', 'rust_fmt', 'rust_clippy', 'rust_tests', 'installer_build'];
const requiredChecks = [...coreChecks, 'windows_shell', 'native_smoke', 'native_close', 'installation'];
const statuses = new Set(['passed', 'failed', 'not_run', 'skipped', 'unknown']);
const hash = (data) => createHash('sha256').update(data).digest('hex');

function validateVerification(report) {
  if (!report || !Array.isArray(report.checks)) throw new Error('Verification must contain a checks array');
  const checks = new Map();
  for (const check of report.checks) {
    if (!check || typeof check.name !== 'string' || !check.name.trim() || !statuses.has(check.status)) {
      throw new Error('Each verification check needs a name and a supported status');
    }
    if (checks.has(check.name)) throw new Error(`Duplicate verification check: ${check.name}`);
    checks.set(check.name, check.status);
  }
  for (const name of requiredChecks) {
    if (!checks.has(name)) throw new Error(`Missing verification check: ${name}`);
  }
  for (const name of coreChecks) {
    if (checks.get(name) !== 'passed') throw new Error(`Required verification check did not pass: ${name}`);
  }
}

function tomlValue(text, section, key) {
  const body = text.split(`[${section}]`)[1]?.split(/^\[/m)[0];
  const value = body?.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1];
  if (!value) throw new Error(`Missing ${section}.${key} version metadata`);
  return value;
}

export async function createCandidate({ installer, verification, output, projectRoot = projectDirectory }) {
  for (const [name, value] of Object.entries({ installer, verification, output })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing --${name}`);
  }
  projectRoot = path.resolve(projectRoot);
  installer = path.resolve(projectRoot, installer);
  verification = path.resolve(projectRoot, verification);
  output = path.resolve(projectRoot, output);
  const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await lstat(output);
    throw new Error('Candidate output already exists; choose a new directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const relativeOutput = path.relative(projectRoot, output);
  if (!relativeOutput || relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)) {
    throw new Error('Candidate output must be inside a Git-ignored project directory');
  }
  try {
    git('check-ignore', '--quiet', '--', `${relativeOutput.replaceAll(path.sep, '/')}/`);
  } catch {
    throw new Error('Candidate output must be Git-ignored to keep source fingerprints independent');
  }
  const installerStat = await lstat(installer);
  if (!installerStat.isFile() || installerStat.size === 0) throw new Error('Installer must be a nonempty regular file');
  if (path.extname(installer).toLowerCase() !== '.exe' || /[\r\n]/.test(path.basename(installer))) {
    throw new Error('Installer must have a single-line .exe filename');
  }
  if (!(await lstat(verification)).isFile()) throw new Error('Verification must be a regular JSON file');
  const verificationBytes = await readFile(verification);
  validateVerification(JSON.parse(verificationBytes.toString('utf8')));

  const tracked = new Set(git('ls-files', '--cached', '-z').split('\0').filter(Boolean));
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  const files = [];
  for (const name of [...new Set([...tracked, ...untracked])].sort()) {
    try {
      const file = path.join(projectRoot, name);
      const stat = await lstat(file);
      const bytes = stat.isSymbolicLink() ? await readlink(file) : await readFile(file);
      files.push({ path: name, status: tracked.has(name) ? 'tracked' : 'untracked', sha256: hash(bytes) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      files.push({ path: name, status: 'deleted', sha256: null });
    }
  }
  const readText = (name) => readFile(path.join(projectRoot, name), 'utf8');
  const frontend = JSON.parse(await readText('desktop/package.json'));
  const tauri = JSON.parse(await readText('desktop/src-tauri/tauri.conf.json'));
  const source = {
    schemaVersion: 1,
    head: git('rev-parse', 'HEAD').trim(),
    dirty: git('status', '--porcelain=v1', '--untracked-files=all', '-z').length > 0,
    versions: {
      frontend: frontend.version,
      tauri: tauri.version,
      rust: tomlValue(await readText('desktop/src-tauri/Cargo.toml'), 'package', 'version'),
      node: (await readText('desktop/.node-version')).trim(),
      packageManager: frontend.packageManager,
      rustToolchain: tomlValue(await readText('desktop/src-tauri/rust-toolchain.toml'), 'toolchain', 'channel'),
    },
    fingerprintSha256: hash(JSON.stringify(files)),
    files,
    ci: Object.fromEntries([
      ['repository', 'GITHUB_REPOSITORY'], ['commit', 'GITHUB_SHA'], ['runId', 'GITHUB_RUN_ID'],
      ['runAttempt', 'GITHUB_RUN_ATTEMPT'], ['workflow', 'GITHUB_WORKFLOW'],
    ].filter(([, key]) => process.env[key]).map(([name, key]) => [name, process.env[key]])),
  };

  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const installerName = path.basename(installer);
  await copyFile(installer, path.join(output, installerName), constants.COPYFILE_EXCL);
  await writeFile(path.join(output, 'source.json'), `${JSON.stringify(source, null, 2)}\n`, { flag: 'wx' });
  await writeFile(path.join(output, 'verification.json'), verificationBytes, { flag: 'wx' });
  const checksums = [];
  for (const name of [installerName, 'source.json', 'verification.json']) {
    checksums.push(`${hash(await readFile(path.join(output, name)))}  ${name}\n`);
  }
  await writeFile(path.join(output, 'SHA256SUMS.txt'), checksums.join(''), { flag: 'wx' });
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index].slice(2);
      if (!['installer', 'verification', 'output'].includes(name) || args[index] !== `--${name}` || !args[index + 1] || options[name]) {
        throw new Error('Usage: node scripts/candidate-evidence.mjs --installer <NSIS.exe> --verification <checks.json> --output <new-ignored-directory>');
      }
      options[name] = args[index + 1];
    }
    console.log(`Candidate evidence: ${await createCandidate(options)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
