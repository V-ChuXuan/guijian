import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { assertNormalClose } from './native-smoke-exit.mjs';

// Explicit native smoke: only the new synthetic fixture is sent to the real Recycle Bin.
// WebView2/CDP setup: https://learn.microsoft.com/microsoft-edge/webview2/how-to/debug-visual-studio-code
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? join(project, 'desktop/src-tauri/target/release/guijian-desktop.exe'));
const closeDuringCleanup = process.argv.includes('--close-during-cleanup');
const output = join(project, 'desktop/src-tauri/target/output/native-smoke', `run-${Date.now()}`);
const root = join(output, 'fixtures');
await mkdir(root, { recursive: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const report = { executable, executableSha256: hash(await readFile(executable)), output, status: 'running', coverage: 'real WebView2 and registered Tauri IPC; system directory picker is not automated' };
const small = Buffer.from('native-smoke retained duplicate\n');
const large = Buffer.alloc((closeDuringCleanup ? 128 : 32) * 1024 * 1024, 0x67);
const contents = new Map();
for (const [prefix, count, bytes] of [['keep', 3, small], ['clean', 4, large]]) {
  for (let index = 0; index < count; index++) {
    const path = join(root, `${prefix}-${index}.bin`);
    await writeFile(path, bytes);
    contents.set(path, hash(bytes));
  }
}
const server = createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
const child = spawn(executable, [], {
  cwd: dirname(executable), windowsHide: true, stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(output, 'profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` },
});
report.pid = child.pid;
report.cdpPort = port;
let socket;
let nativeClose;
const closeOwnWindow = async () => {
  const request = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$process=Get-Process -Id ${child.pid}; $process.CloseMainWindow()`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  request.stdout.on('data', chunk => output.push(chunk));
  const [code] = await once(request, 'exit', { signal: AbortSignal.timeout(10000) });
  return { requestExitCode: code, closeMainWindowAccepted: Buffer.concat(output).toString().trim() };
};
let nextId = 0;
const pending = new Map();
const call = (method, params = {}) => new Promise((accept, reject) => {
  const id = ++nextId;
  const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 60000);
  pending.set(id, { accept, reject, timeout });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (fn, ...args) => {
  const response = await call('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
};
try {
  await once(child, 'spawn', { signal: AbortSignal.timeout(10000) });
  let page;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error(`native executable exited before CDP was ready: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
      page = (await response.json()).find(target => target.type === 'page' && target.url.includes('tauri'));
      if (page) break;
    } catch { /* Native WebView2 is still starting. */ }
    await delay(100);
  }
  assert.ok(page, 'own native WebView2 CDP page must become available within 10 seconds');
  report.page = { title: page.title, url: page.url };
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.bindingCalled' && message.params.name === '__nativeSmokeCurrentFile' && !nativeClose) {
      report.closeDuringCleanup = { progressAtRequest: JSON.parse(message.params.payload) };
      nativeClose = closeOwnWindow();
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(Error(message.error.message));
    else request.accept(message.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject, timeout } of pending.values()) { clearTimeout(timeout); reject(Error('native WebView2 connection closed')); }
    pending.clear();
  });
  await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
  await call('Runtime.enable');
  for (let attempt = 0; attempt < 100; attempt++) {
    report.runtime = await evaluate(() => ({ tauri: typeof window.__TAURI_INTERNALS__?.invoke, text: document.querySelector('h1')?.textContent }));
    if (report.runtime.tauri === 'function' && report.runtime.text) break;
    await delay(100);
  }
  assert.equal(report.runtime.tauri, 'function');
  assert.equal(report.runtime.text, '选择文件夹');
  await writeFile(join(output, 'native-start.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  if (closeDuringCleanup) await call('Runtime.addBinding', { name: '__nativeSmokeCurrentFile' });
  report.flow = await evaluate(async (root, closeDuringCleanup) => {
    const tauri = window.__TAURI_INTERNALS__;
    const events = { scan: [], cleanup: [], closeBlocked: [] };
    let cancellation;
    let closeRequested = false;
    const subscriptions = [];
    for (const event of ['scan-progress', 'cleanup-progress', 'operation-close-blocked']) {
      const handler = tauri.transformCallback(({ payload }) => {
        if (event === 'scan-progress') events.scan.push(payload);
        else if (event === 'operation-close-blocked') {
          events.closeBlocked.push(payload);
          cancellation = tauri.invoke('cancel_cleanup');
        } else {
          events.cleanup.push(payload);
          if (payload.currentPath && !cancellation && !closeRequested) {
            if (closeDuringCleanup) {
              closeRequested = true;
              window.__nativeSmokeCurrentFile(JSON.stringify(payload));
            } else cancellation = tauri.invoke('cancel_cleanup');
          }
        }
      });
      const id = await tauri.invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler });
      subscriptions.push({ event, id, handler });
    }
    const initial = await tauri.invoke('start_scan', { path: root });
    const retained = initial.result.groups.find(group => group.size < 1024);
    const cleared = await tauri.invoke('keep_group', { groupId: retained.id });
    const outcome = await tauri.invoke('confirm_cleanup', { target: null });
    const accepted = cancellation ? await cancellation : false;
    const final = await tauri.invoke('get_session');
    const idleCancel = await tauri.invoke('cancel_cleanup');
    for (const { event, id, handler } of subscriptions) {
      window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, id);
      await tauri.invoke('plugin:event|unlisten', { event, eventId: id });
      tauri.unregisterCallback(handler);
    }
    return { events, initial, retainedId: retained.id, cleared, outcome, final, accepted, idleCancel, closeBlockedToast: document.querySelector('.toast')?.textContent };
  }, root, closeDuringCleanup);
  if (closeDuringCleanup) {
    assert.ok(nativeClose, 'native close must be requested after an actual cleanup event');
    Object.assign(report.closeDuringCleanup, await nativeClose);
    report.closeDuringCleanup.processAliveAfterReport = child.exitCode === null;
    report.closeDuringCleanup.reportReceived = true;
    report.closeDuringCleanup.toast = report.flow.closeBlockedToast;
    assert.equal(report.closeDuringCleanup.requestExitCode, 0);
    assert.equal(report.closeDuringCleanup.closeMainWindowAccepted, 'True');
    assert.equal(report.closeDuringCleanup.processAliveAfterReport, true);
    assert.ok(report.flow.events.closeBlocked.length > 0);
    assert.match(report.closeDuringCleanup.toast, /操作进行中.*停止.*关闭/);
    await writeFile(join(output, 'native-close-blocked.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  const flow = report.flow;
  assert.equal(flow.initial.result.groups.length, 2);
  assert.ok(flow.events.scan.length > 0);
  assert.ok(flow.events.scan.some(event => event.stage === 'full_hash' && event.currentPath === null));
  assert.deepEqual(flow.cleared.cleanupPaths, []);
  assert.equal(flow.accepted, true);
  assert.equal(flow.outcome.report.cancelled, true);
  assert.ok(flow.outcome.report.remainingFiles > 0);
  assert.equal(flow.outcome.report.items.length + flow.outcome.report.remainingFiles, 3);
  assert.ok(flow.outcome.report.items.some(item => item.status === 'moved_to_trash'));
  assert.equal(flow.idleCancel, false);
  assert.deepEqual(flow.final, flow.outcome.session);
  assert.deepEqual(flow.final.selections.find(selection => selection.groupId === flow.retainedId).cleanupPaths, []);
  const moved = new Set(flow.outcome.report.items.filter(item => item.status === 'moved_to_trash').map(item => item.path));
  for (const [path, digest] of contents) {
    if (moved.has(path)) await assert.rejects(readFile(path), { code: 'ENOENT' });
    else assert.equal(hash(await readFile(path)), digest, 'all unselected and not-started synthetic files must remain intact');
  }
  report.status = 'passed';
  report.assertions = ['real scan and terminal progress', 'registered keep_group', 'real cleanup and event-triggered stop', 'remaining session and retained group unchanged', 'source and keeper integrity', 'idle cancellation false'];
  const closeResult = await closeOwnWindow();
  for (let attempt = 0; child.exitCode === null && attempt < 30; attempt++) await delay(100);
  report.idleWindowClose = { ...closeResult, exited: child.exitCode !== null, exitCode: child.exitCode };
  assertNormalClose(report.idleWindowClose);
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  socket?.close();
  for (const { reject, timeout } of pending.values()) { clearTimeout(timeout); reject(Error('native smoke terminated')); }
  if (child.exitCode === null && child.pid) child.kill();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, error: report.error, moved: report.flow?.outcome.report.items.length, remaining: report.flow?.outcome.report.remainingFiles, idleWindowClose: report.idleWindowClose, closeDuringCleanup: report.closeDuringCleanup }, null, 2));
}
