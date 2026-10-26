import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from '../desktop/node_modules/vite/dist/node/index.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(project, 'desktop/src-tauri/target/output/single-cleanup-smoke', `run-${Date.now()}`);
const site = join(output, 'site');
const edge = join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
const report = { status: 'running', output,
  coverage: 'Production App in isolated headless Edge with synthetic DesktopApi; simulated completed-side-effect flag followed by rejected response. No real files, recycling, native IPC, WebView2, or installation.',
  sources: {}, scenarios: [], runtimeErrors: [] };
await mkdir(output, { recursive: true });
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
async function sourcePaths(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await sourcePaths(path));
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) paths.push(relative(project, path).replaceAll('\\', '/'));
  }
  return paths;
}
const hash = async path => createHash('sha256').update(await readFile(join(project, path))).digest('hex');
let server, browser, socket;
let nextId = 0;
const pending = new Map();
const call = (method, params = {}) => new Promise((accept, reject) => {
  const id = ++nextId;
  const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, { accept, reject, timeout });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (fn, ...args) => {
  const result = await call('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const wait = async (fn, ...args) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(fn, ...args)) return;
    await delay(50);
  }
  throw Error(`DOM assertion timed out: ${fn.toString()}`);
};
const click = async (selector, text) => {
  const point = await evaluate((selector, text) => {
    const node = [...document.querySelectorAll(selector)].find(node => text == null || node.textContent.trim() === text);
    if (!node || node.disabled) throw Error(`No enabled click target: ${selector} ${text}`);
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector, text);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
};
const target = name => `button[aria-label="仅回收此文件：${name}"]`;
const checkbox = name => `input[aria-label="移至回收站 ${name}"]`;
const dialog = () => evaluate(() => {
  const dialog = document.querySelector('[role=dialog]');
  return dialog ? { text: dialog.textContent, title: document.getElementById('single-cleanup-title')?.textContent,
    alert: dialog.querySelector('[role=alert]')?.textContent ?? null,
    buttons: [...dialog.querySelectorAll('button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled })),
    activeText: document.activeElement?.textContent?.trim(), focusInside: dialog.contains(document.activeElement),
    width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    rect: { left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right, top: dialog.getBoundingClientRect().top, bottom: dialog.getBoundingClientRect().bottom }, height: innerHeight,
  } : null;
});
const snapshot = () => evaluate(() => window.singleCleanupSmoke.snapshot());
async function closeAndCheck(name) {
  await key('Escape', 'Escape', 27);
  await wait(selector => !document.querySelector('[role=dialog]') && document.activeElement === document.querySelector(selector), target(name));
  assert.equal(await evaluate(selector => document.querySelector(selector).checked, checkbox('b-copy.txt')), false, 'manual choice remains');
}

try {
  for (const path of [...await sourcePaths(join(project, 'desktop/src')), 'scripts/single-cleanup-smoke-ui.tsx', 'scripts/single-cleanup-smoke.mjs', 'scripts/single-cleanup-smoke.html']) report.sources[path] = await hash(path);
  await save();
  await build({ root: join(project, 'scripts'), configFile: false, logLevel: 'warn',
    resolve: { alias: { 'react-dom': join(project, 'desktop/node_modules/react-dom'), react: join(project, 'desktop/node_modules/react') } },
    esbuild: { jsx: 'automatic' }, build: { outDir: site, emptyOutDir: false, rollupOptions: { input: join(project, 'scripts/single-cleanup-smoke.html') } } });
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const path = resolve(site, `.${pathname === '/' ? '/single-cleanup-smoke.html' : pathname}`);
      assert.ok(path.startsWith(site + sep));
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/single-cleanup-smoke.html`;
  browser = spawn(edge, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--disable-sync',
    `--user-data-dir=${join(output, 'profile')}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  await once(browser, 'spawn', { signal: AbortSignal.timeout(10000) });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(output, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
    if (browser.exitCode !== null) throw Error(`Edge exited during startup: ${browser.exitCode}`);
    await delay(100);
  }
  assert.ok(port, 'owned browser CDP endpoint must appear');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') report.runtimeErrors.push(message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timeout);
    if (message.error) request.reject(Error(message.error.message)); else request.accept(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(Error('owned browser closed')); }
    pending.clear();
  });
  await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
  await call('Runtime.enable');
  report.browserVersion = await call('Browser.getVersion');
  for (const viewport of [{ width: 1120, height: 720 }, { width: 560, height: 480 }]) {
    const scenario = { viewport, checks: {} };
    report.scenarios.push(scenario);
    await call('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url });
    await wait(() => !!window.singleCleanupSmoke && !!document.querySelector('.scope-picker-card__choose'));
    await click('button', '选择文件夹');
    await wait(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '开始分析' && !button.disabled));
    await click('button', '开始分析');
    await wait(() => document.querySelectorAll('.review-group').length === 2);
    await click('button', '全部展开');
    await click(checkbox('b-copy.txt'));
    await wait(selector => document.querySelector(selector)?.checked === false && !document.querySelector(selector)?.disabled, checkbox('b-copy.txt'));
    for (const mode of ['unknown', 'internal', 'refusal', 'report']) {
      await evaluate(mode => window.singleCleanupSmoke.setMode(mode), mode);
      await click(target('a-copy.txt'));
      await wait(() => document.querySelector('[role=dialog]')?.contains(document.activeElement));
      assert.equal((await dialog()).title, '仅回收此文件', `${mode}: new target clears unknown state`);
      assert.equal((await dialog()).alert, null);
      await click('[role=dialog] button', '移至回收站');
      await wait(() => window.singleCleanupSmoke.snapshot().pending);
      const before = await snapshot();
      assert.deepEqual((await dialog()).buttons.map(button => button.disabled), [true, true]);
      await key('Escape', 'Escape', 27);
      await key('Enter', 'Enter', 13);
      assert.ok(await dialog(), 'pending Escape keeps dialog');
      assert.equal((await snapshot()).calls.length, before.calls.length, 'pending does not repeat submit');
      await evaluate(() => window.singleCleanupSmoke.settle());
      await wait(() => !window.singleCleanupSmoke.snapshot().pending && [...document.querySelectorAll('[role=dialog] button')].some(button => !button.disabled));
      const result = await dialog();
      assert.ok(result.focusInside, `${mode}: enabled dialog control receives focus`);
      assert.ok(result.scrollWidth <= viewport.width, `${mode}: no document horizontal overflow`);
      assert.ok(result.rect.left >= 0 && result.rect.right <= viewport.width && result.rect.top >= 0 && result.rect.bottom <= viewport.height, `${mode}: dialog fits viewport`);
      if (mode === 'unknown' || mode === 'internal') {
        assert.equal(result.title, '未能确认清理结果');
        assert.ok(result.text.includes(mode === 'unknown' ? '结果返回失败' : '内部结果返回失败'));
        assert.ok(result.text.includes('先检查文件状态'));
        assert.ok(!/未开始|没有开始/.test(result.text), 'unknown does not claim no side effect');
        assert.deepEqual(result.buttons, [{ text: '返回检查', disabled: false }]);
        assert.equal(result.activeText, '返回检查');
        await key('Tab', 'Tab', 9);
        assert.equal((await dialog()).activeText, '返回检查');
        await key('Tab', 'Tab', 9, 8);
        assert.equal((await dialog()).activeText, '返回检查');
        assert.equal((await snapshot()).calls.length, before.calls.length, 'unknown has no direct repeat submit');
        assert.equal((await snapshot()).simulatedSideEffects, mode === 'unknown' ? 1 : 2);
        if (mode === 'unknown') {
          const filename = `unknown-${viewport.width}.png`;
          await writeFile(join(output, filename), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
          scenario.screenshot = filename;
          await click('[role=dialog] button', '返回检查');
          await wait(selector => !document.querySelector('[role=dialog]') && document.activeElement === document.querySelector(selector), target('a-copy.txt'));
          await click(target('b-extra.txt'));
          await wait(() => document.querySelector('[role=dialog]')?.contains(document.activeElement));
          assert.equal((await dialog()).title, '仅回收此文件');
          assert.equal((await dialog()).alert, null, 'different target clears issue');
          await closeAndCheck('b-extra.txt');
        } else await closeAndCheck('a-copy.txt');
      } else {
        assert.equal(result.title, '仅回收此文件');
        assert.ok(!result.text.includes('未能确认清理结果'));
        assert.ok(result.alert.includes(mode === 'refusal' ? '合成前置拒绝：目标不在当前组' : '合成逐项失败：文件被占用'));
        assert.ok(result.buttons.some(button => button.text === '移至回收站' && !button.disabled));
        await closeAndCheck('a-copy.txt');
        if (mode === 'report') assert.equal(await evaluate(selector => document.querySelector(selector).checked, checkbox('a-copy.txt')), false, 'trusted report returned session adopted');
      }
      scenario.checks[mode] = { ...result, calls: (await snapshot()).calls.length };
      await save();
    }
    scenario.fixture = await snapshot();
    assert.equal(scenario.fixture.scans, 1, 'no rescan');
    assert.equal(scenario.fixture.selectionUpdates, 1, 'manual choice requested once');
    assert.equal(scenario.fixture.calls.length, 4, 'one request per confirmed scenario');
    assert.ok(scenario.fixture.calls.every(call => call.groupId === 'a' && call.path.endsWith('\\a-copy.txt')));
    assert.equal(scenario.fixture.session.groups[1].files.find(file => file.name === 'b-copy.txt').cleanup, false);
  }
  assert.deepEqual(report.runtimeErrors, []);
  for (const [path, expected] of Object.entries(report.sources)) assert.equal(await hash(path), expected, `Source changed during run: ${path}`);
  report.sourceHashesUnchanged = true;
  report.status = 'passed';
} catch (error) { report.status = 'incomplete'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await call('Browser.close'); } catch {} }
  socket?.close();
  if (browser && browser.exitCode === null) {
    try { await once(browser, 'exit', { signal: AbortSignal.timeout(5000) }); } catch {
      browser.kill();
      try { await once(browser, 'exit', { signal: AbortSignal.timeout(5000) }); } catch {}
    }
  }
  report.browserProcess = browser ? { pid: browser.pid, exitCode: browser.exitCode, signalCode: browser.signalCode, closed: browser.exitCode !== null || browser.signalCode !== null } : null;
  if (browser && !report.browserProcess.closed) { report.status = 'incomplete'; report.error = 'Owned Edge process did not exit'; process.exitCode = 1; }
  if (server?.listening) await new Promise(accept => server.close(accept));
  report.serverClosed = !server?.listening;
  await save();
  console.log(JSON.stringify({ status: report.status, output, error: report.error }));
}
