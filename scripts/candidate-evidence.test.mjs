import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCandidate } from './candidate-evidence.mjs';

const coreChecks = ['node_tests', 'frontend_tests', 'frontend_build', 'rust_fmt', 'rust_clippy', 'rust_tests', 'installer_build'];
const specialtyChecks = ['windows_shell', 'native_smoke', 'native_close', 'installation'];
const hash = (data) => createHash('sha256').update(data).digest('hex');

async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'guijian-candidate-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=.git/fixture-no-hooks', ...args], { cwd: projectRoot, encoding: 'utf8' }).trim();
  await mkdir(path.join(projectRoot, 'desktop/src-tauri'), { recursive: true });
  const files = {
    '.gitignore': '/release/\n.env\n',
    'desktop/package.json': JSON.stringify({ version: '0.1.0', packageManager: 'pnpm@12.8.1' }),
    'desktop/.node-version': '24.12.0\n',
    'desktop/src-tauri/tauri.conf.json': JSON.stringify({ version: '0.1.0' }),
    'desktop/src-tauri/Cargo.toml': '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    'desktop/src-tauri/rust-toolchain.toml': '[toolchain]\nchannel = "1.97.0"\n',
    'tracked.txt': 'original',
    'deleted.txt': 'will be deleted',
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(projectRoot, name), content);
  git('init', '--quiet');
  git('-c', 'core.autocrlf=false', 'add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  await mkdir(path.join(projectRoot, 'release'));
  const installer = path.join(projectRoot, 'release/归简_0.1.0_x64-setup.exe');
  const verification = path.join(projectRoot, 'release/checks.json');
  const report = {
    checks: [
      ...coreChecks.map((name) => ({ name, status: 'passed', command: `synthetic ${name}` })),
      ...specialtyChecks.map((name) => ({ name, status: 'not_run', reason: 'synthetic test' })),
    ],
  };
  await writeFile(installer, Buffer.from([0x4d, 0x5a, 0, 1, 255]));
  await writeFile(verification, JSON.stringify(report));
  return { projectRoot, git, installer, verification, output: path.join(projectRoot, 'release/candidate'), report };
}

test('candidate hashes the exact package and records clean source, versions and explicit evidence', async (t) => {
  const input = await fixture(t);
  await createCandidate(input);
  assert.deepEqual((await readdir(input.output)).sort(), [path.basename(input.installer), 'SHA256SUMS.txt', 'source.json', 'verification.json'].sort());
  const source = JSON.parse(await readFile(path.join(input.output, 'source.json'), 'utf8'));
  assert.equal(source.head, input.git('rev-parse', 'HEAD'));
  assert.equal(source.dirty, false);
  assert.deepEqual(source.versions, { frontend: '0.1.0', tauri: '0.1.0', rust: '0.1.0', node: '24.12.0', packageManager: 'pnpm@12.8.1', rustToolchain: '1.97.0' });
  assert.deepEqual(await readFile(path.join(input.output, 'verification.json')), await readFile(input.verification));
  const checksums = await readFile(path.join(input.output, 'SHA256SUMS.txt'), 'utf8');
  for (const name of [path.basename(input.installer), 'source.json', 'verification.json']) {
    assert.ok(checksums.includes(`${hash(await readFile(path.join(input.output, name)))}  ${name}\n`));
  }
  assert.equal(input.git('status', '--porcelain'), '');
});

test('dirty source fingerprints include modified, deleted and nonignored untracked files deterministically', async (t) => {
  const input = await fixture(t);
  await writeFile(path.join(input.projectRoot, 'tracked.txt'), 'changed');
  await rm(path.join(input.projectRoot, 'deleted.txt'));
  await writeFile(path.join(input.projectRoot, '新文件.txt'), 'untracked');
  await writeFile(path.join(input.projectRoot, '.env'), 'DO_NOT_EXPORT=sentinel');
  await createCandidate(input);
  const source = JSON.parse(await readFile(path.join(input.output, 'source.json'), 'utf8'));
  assert.equal(source.dirty, true);
  assert.deepEqual(source.files.find((file) => file.path === 'tracked.txt'), { path: 'tracked.txt', status: 'tracked', sha256: hash('changed') });
  assert.deepEqual(source.files.find((file) => file.path === 'deleted.txt'), { path: 'deleted.txt', status: 'deleted', sha256: null });
  assert.deepEqual(source.files.find((file) => file.path === '新文件.txt'), { path: '新文件.txt', status: 'untracked', sha256: hash('untracked') });
  assert.ok(source.files.every((file) => file.path !== '.env' && !file.path.startsWith('release/')));
  assert.deepEqual(source.files.map((file) => file.path), source.files.map((file) => file.path).sort());
  await createCandidate({ ...input, output: path.join(input.projectRoot, 'release/second') });
  const second = JSON.parse(await readFile(path.join(input.projectRoot, 'release/second/source.json'), 'utf8'));
  assert.deepEqual(second.files, source.files);
  assert.equal(second.fingerprintSha256, hash(JSON.stringify(source.files)));
});

for (const missing of ['installer', 'verification']) {
  test(`rejects missing ${missing} before creating output`, async (t) => {
    const input = await fixture(t);
    await rm(input[missing]);
    await assert.rejects(createCandidate(input));
    await assert.rejects(readFile(path.join(input.output, 'source.json')), { code: 'ENOENT' });
  });
}

test('rejects invalid or incomplete evidence and nonpassed core checks without creating output', async (t) => {
  const input = await fixture(t);
  for (const invalid of [
    '{', '{}',
    JSON.stringify({ checks: input.report.checks.slice(1) }),
    JSON.stringify({ checks: [...input.report.checks, input.report.checks[0]] }),
    JSON.stringify({ checks: input.report.checks.map((check, index) => index === 0 ? { ...check, status: 'not_run' } : check) }),
    JSON.stringify({ checks: input.report.checks.map((check, index) => index === 7 ? { ...check, status: 'success' } : check) }),
  ]) {
    await writeFile(input.verification, invalid);
    await assert.rejects(createCandidate(input));
    await assert.rejects(readdir(input.output), { code: 'ENOENT' });
  }
});

test('refuses an existing output without changing its contents or the installer', async (t) => {
  const input = await fixture(t);
  await mkdir(input.output);
  await writeFile(path.join(input.output, 'keep.txt'), 'keep');
  const original = await readFile(input.installer);
  await assert.rejects(createCandidate(input), /exist/i);
  assert.deepEqual(await readdir(input.output), ['keep.txt']);
  assert.deepEqual(await readFile(input.installer), original);
});

test('requires a new Git-ignored output and a nonempty exe installer', async (t) => {
  const input = await fixture(t);
  await assert.rejects(createCandidate({ ...input, output: path.join(input.projectRoot, 'candidate') }), /ignor/i);
  await writeFile(input.installer, '');
  await assert.rejects(createCandidate(input), /empty/i);
  await writeFile(input.installer, 'package');
  const other = path.join(input.projectRoot, 'release/package.zip');
  await writeFile(other, 'package');
  await assert.rejects(createCandidate({ ...input, installer: other }), /exe/i);
});

test('CLI rejects absent, duplicate and unknown arguments; records only whitelisted CI metadata', async (t) => {
  const input = await fixture(t);
  await mkdir(path.join(input.projectRoot, 'scripts'));
  const script = path.join(input.projectRoot, 'scripts/candidate-evidence.mjs');
  await copyFile(fileURLToPath(new URL('./candidate-evidence.mjs', import.meta.url)), script);
  const args = ['--installer', input.installer, '--verification', input.verification, '--output', input.output];
  for (const invalid of [[], [...args, '--output', input.output], [...args, '--unknown', 'x']]) {
    assert.notEqual(spawnSync(process.execPath, [script, ...invalid], { encoding: 'utf8' }).status, 0);
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', env: { ...process.env, GITHUB_SHA: input.git('rev-parse', 'HEAD'), GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_WORKFLOW: 'CI', PRIVATE_SENTINEL: 'never-copy-this' },
  });
  assert.equal(result.status, 0, result.stderr);
  const sourceText = await readFile(path.join(input.output, 'source.json'), 'utf8');
  assert.deepEqual(JSON.parse(sourceText).ci, { repository: 'owner/repo', commit: input.git('rev-parse', 'HEAD'), runId: '123', runAttempt: '2', workflow: 'CI' });
  assert.ok(!sourceText.includes('never-copy-this'));
});
