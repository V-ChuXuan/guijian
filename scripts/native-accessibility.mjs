import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = join(project, 'desktop/src-tauri/target/release/guijian-desktop.exe');
const helper = join(project, 'scripts/native-accessibility-tree.ps1');
const hash = data => createHash('sha256').update(data).digest('hex');

function parseScale(args) {
  assert.ok(args.length <= 1 && args.every(arg => ['--scale=1', '--scale=2'].includes(arg)), 'Only --scale=1 or --scale=2 is accepted');
  return args[0] === '--scale=2' ? 2 : 1;
}

async function powershell(args) {
  return new Promise((accept, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    const timeout = setTimeout(() => { child.kill(); reject(Error('Own-window helper timed out')); }, 25000);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(Error(`Own-window helper exit ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
      else accept(Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '').trim());
    });
  });
}

async function sourceFingerprint() {
  const entries = [];
  async function visit(path) {
    for (const entry of (await readdir(join(project, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) entries.push([child, hash(await readFile(join(project, child)))]);
    }
  }
  await visit('desktop/src');
  await visit('desktop/src-tauri/src');
  for (const path of ['desktop/package.json', 'desktop/pnpm-lock.yaml', 'desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/Cargo.lock', 'desktop/src-tauri/tauri.conf.json']) entries.push([path, hash(await readFile(join(project, path)))]);
  return { sha256: hash(JSON.stringify(entries)), files: entries };
}

async function run(scale) {
  assert.equal(process.platform, 'win32', 'Windows is required');
  const executableSha256 = hash(await readFile(executable));
  const sourceBefore = await sourceFingerprint();
  const output = join(project, 'desktop/src-tauri/target/output/native-accessibility', `run-${Date.now()}-scale-${scale}`);
  await mkdir(output, { recursive: true });
  const report = {
    status: 'running', startedAt: new Date().toISOString(), executable, executableSha256, output,
    sourceBefore, driverSha256: hash(await readFile(fileURLToPath(import.meta.url))), helperSha256: hash(await readFile(helper)),
    coverage: 'Read-only initial scope window: native Windows UIA labels, renderer layout and actual window DPI only',
    rendererScaleOverride: scale === 2 ? 2 : null, scenes: [],
    gaps: ['No picker, scanning, review, dialogs or cleanup exercised', 'Keyboard interaction and native focus movement are not exercised', 'Narrator speech is not exercised', 'Installation lifecycle is not exercised'],
  };
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  report.profile = join(output, 'profile');
  report.browserArguments = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}${scale === 2 ? ' --force-device-scale-factor=2' : ''}`;
  const child = spawn(executable, [], { cwd: dirname(executable), windowsHide: true, stdio: 'ignore', env: {
    ...process.env, WEBVIEW2_USER_DATA_FOLDER: report.profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: report.browserArguments,
  } });
  report.pid = child.pid;
  let socket;
  let nextId = 0;
  const pending = new Map();
  const call = (method, params = {}) => new Promise((accept, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { accept, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const capture = async name => {
    const uia = JSON.parse(await powershell(['-File', helper, '-ProcessId', String(child.pid), '-Executable', executable]));
    assert.equal(uia.processId, child.pid);
    const response = await call('Runtime.evaluate', { expression: `(() => {
      const invoke = Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__, 'invoke');
      return { title: document.querySelector('#page-title')?.textContent,
        devicePixelRatio, width: innerWidth, height: innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        invokeDescriptor: { writable: invoke?.writable, configurable: invoke?.configurable } };
    })()`, returnByValue: true });
    if (response.exceptionDetails) throw Error(response.exceptionDetails.text);
    const scene = { name, uia, dom: response.result.value };
    report.scenes.push(scene);
    await writeFile(join(output, `${name}.json`), JSON.stringify(scene, null, 2));
    await writeFile(join(output, `${name}.png`), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    console.log(`Captured ${name}: ${uia.nodes.length} UIA controls, DPI ${uia.dpi}`);
    return scene;
  };
  try {
    await once(child, 'spawn', { signal: AbortSignal.timeout(10000) });
    let page;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error(`Own EXE exited: ${child.exitCode}`);
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })).json()).find(target => target.type === 'page' && target.url.includes('tauri')); } catch { /* WebView is starting. */ }
      if (page) break;
      await delay(100);
    }
    assert.ok(page, 'Own native WebView must start');
    report.page = { title: page.title, url: page.url };
    socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timeout);
      if (message.error) request.reject(Error(message.error.message)); else request.accept(message.result);
    });
    socket.addEventListener('close', () => { for (const { reject, timeout } of pending.values()) { clearTimeout(timeout); reject(Error('Own CDP connection closed')); } pending.clear(); });
    await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
    await call('Runtime.enable');
    await delay(300);
    let scene = await capture('01-scope');
    const picker = scene => scene.uia.nodes.find(node => node.name === '选择文件夹' && node.controlType === 'ControlType.Button');
    // The first UIA client query can activate a lazy renderer accessibility tree.
    if (!picker(scene)) { await delay(1000); scene = await capture('01-scope-after-uia-query'); }
    report.actualWindowDpi = scene.uia.dpi;
    if (scene.uia.dpi !== 192) report.gaps.push(`Actual window DPI is ${scene.uia.dpi}; real 200% system scaling remains unverified`);
    if (!scene.dom.invokeDescriptor.writable) report.gaps.push('Runtime invoke is immutable; picker substitution is unavailable, so this probe performs no UI actions');
    assert.equal(scene.dom.title, '选择文件夹', 'Only the initial scope window is inspected');
    assert.ok(picker(scene)?.isKeyboardFocusable, 'Picker must expose a named focusable Button to Windows UIA');
    assert.ok(report.scenes.every(item => !item.dom.horizontalOverflow), 'Initial scope must have no horizontal overflow');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
  } finally {
    socket?.close();
    if (child.exitCode === null && child.pid) {
      try {
        const accepted = await powershell(['-Command', `$owned=Get-Process -Id ${child.pid}; if ($owned.Path -ne '${executable.replaceAll("'", "''")}') { throw 'Own process mismatch' }; $owned.CloseMainWindow()`]);
        for (let attempt = 0; child.exitCode === null && attempt < 50; attempt++) await delay(100);
        report.normalClose = { accepted, exitCode: child.exitCode, signal: child.signalCode };
        assert.equal(accepted, 'True');
        assert.equal(child.exitCode, 0, 'Own EXE must close normally');
      } catch (error) { report.status = 'failed'; report.closeError = String(error); process.exitCode = 1; }
    } else { report.status = 'failed'; report.closeError = 'Own EXE exited before normal close was requested'; process.exitCode = 1; }
    if (child.exitCode === null && child.pid) { report.forcedTermination = true; child.kill(); await once(child, 'close', { signal: AbortSignal.timeout(5000) }).catch(() => {}); }
    report.processExited = child.exitCode !== null || child.signalCode !== null;
    try {
      report.sourceAfter = await sourceFingerprint();
      assert.equal(report.sourceAfter.sha256, sourceBefore.sha256, 'Product source must remain unchanged');
      assert.equal(hash(await readFile(executable)), executableSha256, 'EXE must remain unchanged');
    } catch (error) { report.status = 'failed'; report.integrityError = String(error); process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, coverage: report.coverage, output, pid: report.pid, actualWindowDpi: report.actualWindowDpi, rendererScaleOverride: report.rendererScaleOverride, normalClose: report.normalClose, error: report.error, integrityError: report.integrityError, gaps: report.gaps }, null, 2));
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    assert.equal(parseScale([]), 1);
    assert.equal(parseScale(['--scale=2']), 2);
    for (const invalid of [['--scale=3'], ['--force-renderer-accessibility'], ['foreign.exe'], ['--scale=1', '--scale=2']]) assert.throws(() => parseScale(invalid));
    console.log('native-accessibility self-test passed: fixed own EXE, bounded renderer scale, unknown options rejected');
  } else await run(parseScale(args));
} catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
