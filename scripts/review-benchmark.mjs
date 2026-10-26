import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, release, totalmem } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from '../desktop/node_modules/vite/dist/node/index.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const diagnostics = process.argv.includes('--diagnostics');
const output = join(project, 'desktop/src-tauri/target/output/review-benchmark', `run-${Date.now()}`);
const site = join(output, 'site');
const edge = join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
const report = { status: 'running', output, coverage: 'Production ReviewStage in isolated headless Edge, synthetic props and local React state; excludes scanning, backend IPC, and disk operations',
  environment: { node: process.version, os: release(), cpu: cpus()[0].model, logicalProcessors: cpus().length, memoryBytes: totalmem(), viewport: { width: 1120, height: 720, deviceScaleFactor: 1 } },
  method: 'First component mount then two warm remounts per size; fixture generation and production build excluded. Input/click timings include loopback CDP dispatch and wait for asserted DOM plus two animation frames. Search inserts a whole query, not individual keystrokes. Each step has a 60s host timeout.',
  workload: 'Paginated review: expand-all changes the complete fixture state, but readiness and mounted counts describe the current page. Older full-mount reports render every group/file at once; their timings are not an equal-DOM-workload comparison.',
  sources: {}, scenarios: [], validations: {} };
if (diagnostics) {
  report.coverage = 'Production CleanupStage and ReviewStage in isolated headless Edge, synthetic 10,001-record props; excludes the whole App, native WebView, backend IPC and filesystem operations';
  report.method = 'One diagnostic interaction pass at 1120x720 and 560x480; fixture generation and harness production build excluded. Timings include CDP dispatch and asserted DOM plus two frames; no equal-workload before/after speed claim.';
  report.workload = 'Cleanup: 10,001 alternating failed/moved records, global filtered totals 5,001/5,000; scan: 10,001 issues with and without duplicate groups. Prior SSR evidence was 10,000 receipt rows / 70,012 tags and 30,011 tags for closed issues; this browser pass measures a different workload.';
}
await mkdir(output, { recursive: true });
async function frontendSources(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await frontendSources(path));
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) paths.push(relative(project, path).replaceAll('\\', '/'));
  }
  return paths;
}
for (const path of [...await frontendSources(join(project, 'desktop/src')), 'scripts/review-benchmark-ui.jsx', 'scripts/review-benchmark.mjs', 'scripts/review-benchmark.html']) {
  report.sources[path] = createHash('sha256').update(await readFile(join(project, path))).digest('hex');
}
assert.ok(report.sources['desktop/src/components/stages/ReviewGroup.tsx'] && report.sources['desktop/src/components/stages/ReviewPagination.tsx']);
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
await build({ root: join(project, 'scripts'), configFile: false, logLevel: 'warn',
  resolve: { alias: { 'react-dom': join(project, 'desktop/node_modules/react-dom'), react: join(project, 'desktop/node_modules/react') } },
  esbuild: { jsx: 'automatic' }, build: { outDir: site, emptyOutDir: false, rollupOptions: { input: join(project, 'scripts/review-benchmark.html') } } });
const server = createServer(async (request, response) => {
  try {
    const path = resolve(site, `.${new URL(request.url, 'http://localhost').pathname === '/' ? '/review-benchmark.html' : new URL(request.url, 'http://localhost').pathname}`);
    assert.ok(path.startsWith(site + sep));
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/review-benchmark.html`;
const browser = spawn(edge, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--disable-sync',
  `--user-data-dir=${join(output, 'profile')}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
let nextId = 0;
const pending = new Map();
const call = (method, params = {}) => new Promise((accept, reject) => {
  const id = ++nextId;
  const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 60000);
  pending.set(id, { accept, reject, timeout, method });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (fn, ...args) => {
  const result = await call('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const click = async (selector, text) => {
  const point = await evaluate((selector, text) => {
    const node = [...document.querySelectorAll(selector)].find(node => !text || node.textContent === text);
    if (!node) throw Error(`No click target: ${selector} ${text}`);
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector, text);
  await evaluate(() => window.reviewBenchmark.start());
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const key = async (key, code, windowsVirtualKeyCode) => {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
};
const keyboardActivate = async (selector) => {
  await evaluate(selector => {
    const node = document.querySelector(selector);
    if (!node || node.disabled) throw Error(`No enabled keyboard target: ${selector}`);
    node.focus();
    if (document.activeElement !== node) throw Error(`Keyboard target did not receive focus: ${selector}`);
    window.reviewBenchmark.start();
  }, selector);
  await key('Enter', 'Enter', 13);
};
const search = async (text) => {
  await evaluate(() => { document.querySelector('[type=search]').focus(); document.querySelector('[type=search]').select(); window.reviewBenchmark.start(); });
  if (text) await call('Input.insertText', { text });
  else await key('Backspace', 'Backspace', 8);
};
const check = expected => evaluate(expected => window.reviewBenchmark.check(expected), expected);
const groupPage = direction => `nav[aria-label="重复组分页"] button[aria-label="重复组：${direction}"]`;
const filePage = direction => `nav[aria-label^="文件分页 "] button[aria-label="文件：${direction}"]`;
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
try {
  await once(browser, 'spawn', { signal: AbortSignal.timeout(10000) });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(output, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
    if (browser.exitCode !== null) throw Error(`Edge exited during startup: ${browser.exitCode}`);
    await delay(100);
  }
  assert.ok(port, 'isolated browser CDP endpoint must appear');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timeout);
    if (message.error) request.reject(Error(`${request.method}: ${message.error.message}`)); else request.accept(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(Error('isolated browser closed')); } pending.clear();
  });
  await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
  report.environment.browser = await call('Browser.getVersion');
  await call('Emulation.setDeviceMetricsOverride', { ...report.environment.viewport, mobile: false });
  await call('Performance.enable');
  async function runDiagnostics() {
    await call('Page.navigate', { url });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(() => typeof window.reviewBenchmark?.diagnosticsEnter === 'function')) break;
      await delay(100);
    }
    const page = (label, direction) => `nav[aria-label="${label}分页"] button[aria-label="${label}：${direction}"]`;
    const verify = async (name, expected) => {
      const result = await evaluate(expected => window.reviewBenchmark.diagnosticsCheck(expected), expected);
      report.validations[name] = result;
      await save();
      return result;
    };
    const screenshot = async name => {
      await evaluate(() => { for (const node of document.querySelectorAll('body *')) {
        if (/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) node.scrollTop = 0;
      } });
      await delay(200);
      await writeFile(join(output, `${name}.png`), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    };
    const layout = async name => {
      const result = await verify(name, { focusConnected: true });
      assert.ok(result.scrollWidth <= result.width, `${name}: document must not overflow horizontally`);
      assert.equal(result.scrollRegions.length, 1, `${name}: exactly one content scroll region`);
      assert.ok(result.scrollRegions.every(region => region.scrollWidth <= region.clientWidth + 1), `${name}: content must not overflow horizontally`);
      await screenshot(name);
    };
    report.validations.receiptEntry = await evaluate(() => window.reviewBenchmark.diagnosticsEnter('receipt'));
    await verify('receiptDefault', { receiptRows: 50, firstReceiptPath: 'D:\\review-benchmark\\receipt-00000.txt', lastReceiptPath: 'D:\\review-benchmark\\receipt-00098.txt', activeFilter: '未处理 5001 个', revealButtons: 50, receiptRange: '第 1–50 / 5001 条 · 第 1 / 101 页' });
    await keyboardActivate(page('处理记录', '最后一页'));
    await verify('receiptFilteredLast', { receiptRows: 1, firstReceiptPath: 'D:\\review-benchmark\\receipt-10000.txt', focusInReceipt: true });
    assert.equal(await evaluate(() => document.activeElement?.textContent), '复制完整路径');
    await key('Enter', 'Enter', 13);
    report.validations.receiptCopy = await evaluate(() => window.reviewBenchmark.lastAction());
    assert.deepEqual(report.validations.receiptCopy, { kind: 'copy', path: 'D:\\review-benchmark\\receipt-10000.txt' });
    await key('Tab', 'Tab', 9);
    assert.equal(await evaluate(() => document.activeElement?.textContent), '在资源管理器中显示');
    await key('Enter', 'Enter', 13);
    report.validations.receiptReveal = await evaluate(() => window.reviewBenchmark.lastAction());
    assert.deepEqual(report.validations.receiptReveal, { kind: 'reveal', path: 'D:\\review-benchmark\\receipt-10000.txt' });
    await click('.receipt-stats button', '已移入回收站 5000 个');
    await verify('receiptMovedReset', { receiptRows: 50, firstReceiptPath: 'D:\\review-benchmark\\receipt-00001.txt', lastReceiptPath: 'D:\\review-benchmark\\receipt-00099.txt', revealButtons: 0 });
    await keyboardActivate(page('处理记录', '最后一页'));
    await verify('receiptMovedLast', { receiptRows: 50, lastReceiptPath: 'D:\\review-benchmark\\receipt-09999.txt', revealButtons: 0 });
    await click('.receipt-stats button', '全部 10001 个');
    await verify('receiptAllReset', { receiptRows: 50, firstReceiptPath: 'D:\\review-benchmark\\receipt-00000.txt', lastReceiptPath: 'D:\\review-benchmark\\receipt-00049.txt' });
    await keyboardActivate(page('处理记录', '最后一页'));
    await verify('receiptAllLast', { receiptRows: 1, firstReceiptPath: 'D:\\review-benchmark\\receipt-10000.txt', focusInReceipt: true, receiptRange: '第 10001–10001 / 10001 条 · 第 201 / 201 页' });
    await keyboardActivate(page('处理记录', '第一页'));
    await layout('receipt-desktop');
    await call('Emulation.setDeviceMetricsOverride', { width: 560, height: 480, deviceScaleFactor: 1, mobile: false });
    await layout('receipt-narrow');
    for (const hasGroups of [true, false]) {
      const name = hasGroups ? 'issuesWithGroups' : 'issuesWithoutGroups';
      await call('Emulation.setDeviceMetricsOverride', { ...report.environment.viewport, mobile: false });
      report.validations[`${name}Entry`] = await evaluate(hasGroups => window.reviewBenchmark.diagnosticsEnter('issues', 10001, hasGroups), hasGroups);
      await verify(`${name}Closed`, { issueRows: 0, issuesOpen: false, issueSummary: '有 10,001 项未完成检查', noGroups: !hasGroups });
      await keyboardActivate('.scan-issues summary');
      await verify(`${name}Open`, { issueRows: 50, issuesOpen: true, firstIssuePath: 'D:\\review-benchmark\\issue-00000.txt', lastIssuePath: 'D:\\review-benchmark\\issue-00049.txt' });
      await key('Tab', 'Tab', 9);
      assert.equal(await evaluate(() => document.activeElement?.getAttribute('aria-label')), '扫描问题：下一页');
      await key('Enter', 'Enter', 13);
      await verify(`${name}KeyboardNext`, { issueRows: 50, firstIssuePath: 'D:\\review-benchmark\\issue-00050.txt', focusInIssues: true });
      await keyboardActivate(page('扫描问题', '最后一页'));
      await verify(`${name}Last`, { issueRows: 1, firstIssuePath: 'D:\\review-benchmark\\issue-10000.txt', focusInIssues: true, issueRange: '第 10001–10001 / 10001 项 · 第 201 / 201 页' });
      await keyboardActivate(page('扫描问题', '第一页'));
      await layout(`${name}-desktop`);
      await call('Emulation.setDeviceMetricsOverride', { width: 560, height: 480, deviceScaleFactor: 1, mobile: false });
      await layout(`${name}-narrow`);
      await keyboardActivate('.scan-issues summary');
      await verify(`${name}ClosedAgain`, { issueRows: 0, issuesOpen: false, focusTag: 'SUMMARY' });
    }
    report.validations.longPathEntry = await evaluate(() => window.reviewBenchmark.diagnosticsEnter('longpath'));
    await verify('longPathNarrow', { warningCount: 1, warningVisible: true, warningOverflow: false });
    const warningLayout = await evaluate(() => window.reviewBenchmark.diagnosticsSnapshot());
    assert.equal(warningLayout.width, 560);
    assert.ok(warningLayout.scrollWidth <= warningLayout.width, 'long-path warning must not overflow the narrow viewport');
    await screenshot('long-path-narrow');
  }
  async function runReview() {
  for (const count of [1000, 10000]) {
    await call('Page.navigate', { url });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(() => typeof window.reviewBenchmark?.enter === 'function')) break;
      await delay(100);
    }
    for (let iteration = 0; iteration < 3; iteration++) {
      const scenario = { count, files: count * 2, iteration: iteration === 0 ? 'first-mount' : `warm-${iteration}`, timings: {} };
      report.scenarios.push(scenario);
      scenario.timings.enter = await evaluate(count => window.reviewBenchmark.enter(count), count);
      const query = `unique-${String(count - 1).padStart(5, '0')}`;
      await search(query);
      scenario.timings.search = await evaluate(query => window.reviewBenchmark.finish('search', query), query);
      await search('');
      scenario.timings.restoreSearch = await evaluate(() => window.reviewBenchmark.finish('restore'));
      await click('.review-toolbar button', '全部展开');
      scenario.timings.expandAll = await evaluate(() => window.reviewBenchmark.finish('expand'));
      await click('.review-file-row input:not(:disabled)');
      scenario.timings.selection = await evaluate(() => window.reviewBenchmark.finish('selection'));
      const metrics = await call('Performance.getMetrics');
      scenario.metrics = metrics.metrics.filter(metric => ['Nodes', 'JSHeapUsedSize', 'LayoutDuration', 'ScriptDuration', 'TaskDuration'].includes(metric.name));
      await save();
      assert.ok(scenario.timings.expandAll.domNodes < 10000, 'ordinary two-file groups must mount fewer than 10,000 DOM elements');
      assert.ok(scenario.metrics.find(metric => metric.name === 'JSHeapUsedSize').value < 768 * 1024 * 1024, 'JS heap resource guard');
      await evaluate(() => window.reviewBenchmark.clear());
      console.log(JSON.stringify(scenario));
    }
  }
  report.warmTargets = [1000, 10000].flatMap(count => ['enter', 'search', 'restoreSearch', 'expandAll', 'selection'].map(operation => {
    const samples = report.scenarios.filter(scenario => scenario.count === count && scenario.iteration !== 'first-mount').map(scenario => scenario.timings[operation].milliseconds);
    const meanMilliseconds = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    return { count, operation, samples, meanMilliseconds, targetMilliseconds: 1000, passed: meanMilliseconds < 1000 };
  }));
  await save();
  assert.ok(report.warmTargets.every(target => target.passed), 'normal current-page warm actions must average below 1 second');

  // Boundary checks are separate from the six timed two-file-group scenarios.
  await evaluate(() => window.reviewBenchmark.enter(10001));
  await click('.review-toolbar button', '全部展开');
  await evaluate(() => window.reviewBenchmark.finish('expand'));
  await keyboardActivate(groupPage('最后一页'));
  report.validations.groupLastPage = await check({ totalGroups: 10001, totalFiles: 20002, mountedGroups: 1, mountedFiles: 2, firstGroupName: 'unique-10000.txt', expandedGroups: 10001, focusOnGroupHeader: true });
  await click('.review-file-row input:not(:disabled)');
  await check({ selectedFiles: 10000, secondFileSelected: false });
  assert.equal(await evaluate(() => window.reviewBenchmark.choice('group-10000', 1)), false);
  await keyboardActivate(groupPage('第一页'));
  await check({ mountedGroups: 50, mountedFiles: 100, firstGroupName: 'unique-00000.txt', selectedFiles: 10000, focusOnGroupHeader: true });
  assert.equal(await evaluate(() => window.reviewBenchmark.choice('group-0', 1)), true);
  await keyboardActivate(groupPage('最后一页'));
  report.validations.crossPageChoice = await check({ mountedGroups: 1, secondFileSelected: false, selectedFiles: 10000 });
  await search('unique-00000');
  report.validations.offPageGroupSearch = await check({ mountedGroups: 1, firstGroupName: 'unique-00000.txt', selectedFiles: 10000, expandedGroups: 10001 });
  await evaluate(() => window.reviewBenchmark.clear());
  await save();

  report.validations.largeGroupEntry = await evaluate(() => window.reviewBenchmark.enter(1, 20000, 19999));
  assert.equal(await evaluate(() => document.querySelectorAll('.review-file-row input:disabled').length), 0, 'a keeper on a hidden page must not disable a selected visible file');
  await keyboardActivate(filePage('最后一页'));
  report.validations.largeGroupLastPage = await check({ totalFiles: 20000, mountedFiles: 50, firstFilePath: 'copy-19950\\unique-00000.txt', lastFilePath: 'copy-19999\\unique-00000.txt', selectedFiles: 19999, focusOnGroupHeader: true });
  assert.equal(await evaluate(() => document.querySelectorAll('.review-file-row input')[49].disabled), true, 'the last keeper must remain protected after paging');
  await click('.review-file-row input:not(:disabled)');
  await check({ selectedFiles: 19998 });
  await keyboardActivate(filePage('第一页'));
  await check({ firstFilePath: 'copy-0\\unique-00000.txt', selectedFiles: 19998 });
  assert.equal(await evaluate(() => window.reviewBenchmark.choice('group-0', 19950)), false);
  await search('copy-50\\unique-00000.txt');
  report.validations.file51Search = await check({ mountedGroups: 1, mountedFiles: 50, firstFilePath: 'copy-50\\unique-00000.txt', selectedFiles: 19998 });
  assert.equal(await evaluate(() => document.activeElement?.matches('[type=search]')), true);
  await search('copy-19999\\unique-00000.txt');
  report.validations.lastFileSearch = await check({ firstFilePath: 'copy-19950\\unique-00000.txt', lastFilePath: 'copy-19999\\unique-00000.txt', selectedFiles: 19998 });
  await evaluate(() => window.reviewBenchmark.clear());
  await save();

  const stress = { totalGroups: 50, totalFiles: 25000, filesPerGroup: 500, timings: {} };
  stress.timings.enter = await evaluate(() => window.reviewBenchmark.enter(50, 500));
  await click('.review-toolbar button', '全部展开');
  stress.timings.expandAll = await evaluate(() => window.reviewBenchmark.finish('expand'));
  await click('.review-file-row input:not(:disabled)');
  stress.timings.selection = await evaluate(() => window.reviewBenchmark.finish('selection'));
  assert.equal(stress.timings.expandAll.mountedFiles, 2500);
  assert.equal(stress.timings.selection.selectedFiles, 24949);
  assert.ok(stress.timings.expandAll.domNodes < 200000, 'large-group page resource guard');
  report.validations.largeGroupsStress = stress;
  await evaluate(() => window.reviewBenchmark.clear());
  await save();

  await evaluate(() => window.reviewBenchmark.enter(51));
  await click('.review-toolbar button', '全部展开');
  await evaluate(() => window.reviewBenchmark.finish('expand'));
  await keyboardActivate(groupPage('最后一页'));
  await check({ mountedGroups: 1, mountedFiles: 2, firstGroupName: 'unique-00050.txt', focusOnGroupHeader: true });
  await keyboardActivate('.review-row-menu summary');
  assert.equal(await evaluate(() => document.querySelector('.review-row-menu').open), true);
  await key('Tab', 'Tab', 9);
  await key('Tab', 'Tab', 9);
  assert.equal(await evaluate(() => document.activeElement?.textContent), '复制完整路径');
  await key('Enter', 'Enter', 13);
  report.validations.keyboardMenu = await evaluate(() => ({ action: window.reviewBenchmark.lastAction(), open: document.querySelector('.review-row-menu').open, focusOnSummary: document.activeElement === document.querySelector('.review-row-menu summary'), connected: document.activeElement?.isConnected }));
  assert.equal(report.validations.keyboardMenu.action.kind, 'copy');
  assert.equal(report.validations.keyboardMenu.open, false);
  assert.equal(report.validations.keyboardMenu.focusOnSummary, true);
  assert.equal(report.validations.keyboardMenu.connected, true);
  await writeFile(join(output, 'review-desktop.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await call('Emulation.setDeviceMetricsOverride', { width: 560, height: 480, deviceScaleFactor: 1, mobile: false });
  await keyboardActivate(groupPage('第一页'));
  await check({ mountedGroups: 50, mountedFiles: 100, focusOnGroupHeader: true });
  report.validations.narrow = await evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, focusConnected: document.activeElement?.isConnected, contentScrollRegions: document.querySelectorAll('[data-scroll-region="content"]').length }));
  assert.ok(report.validations.narrow.scrollWidth <= report.validations.narrow.width, 'narrow viewport must not overflow the page horizontally');
  assert.equal(report.validations.narrow.contentScrollRegions, 1);
  await writeFile(join(output, 'review-narrow.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  if (diagnostics) await runDiagnostics(); else await runReview();
  for (const [path, hash] of Object.entries(report.sources)) assert.equal(createHash('sha256').update(await readFile(join(project, path))).digest('hex'), hash, `Source changed during browser run: ${path}`);
  report.sourceHashesUnchanged = true;
  report.status = 'passed';
} catch (error) { report.status = 'incomplete'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await call('Browser.close'); } catch {}
  }
  socket?.close();
  if (browser.exitCode === null) {
    try { await once(browser, 'exit', { signal: AbortSignal.timeout(5000) }); } catch {
      browser.kill();
      try { await once(browser, 'exit', { signal: AbortSignal.timeout(5000) }); } catch {}
    }
  }
  report.browserProcess = { pid: browser.pid, exitCode: browser.exitCode, signalCode: browser.signalCode, closed: browser.exitCode !== null || browser.signalCode !== null };
  if (!report.browserProcess.closed) { report.status = 'incomplete'; report.error = 'Owned Edge process did not exit'; process.exitCode = 1; }
  await new Promise(accept => server.close(accept));
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, error: report.error }));
}
