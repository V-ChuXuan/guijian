import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewStage } from '../desktop/src/components/stages/ReviewStage';
import { CleanupStage } from '../desktop/src/components/stages/CleanupStage';
import '../desktop/src/App.css';

// Synthetic view data only: no desktop API, filesystem, or cleanup action is connected.
const root = createRoot(document.getElementById('root'));
const scanRoot = 'D:\\review-benchmark';
let started;
let count;
let filesPerGroup;
let mount = 0;
let decision;
let action;
let currentData = [];
let currentExpanded = new Set();
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const groups = () => document.querySelectorAll('.review-group');
const rows = () => document.querySelectorAll('.review-file-row');

function Fixture({ initial }) {
  const [data, setData] = useState(initial);
  const [expanded, setExpanded] = useState(() => new Set([initial[0].id]));
  currentData = data;
  currentExpanded = expanded;
  return <main className="app-shell app-shell--review">
    <header className="review-command-bar">合成审阅数据渲染基准</header>
    <section className="workspace workspace--review"><div className="stage-viewport stage-viewport--review">
      <ReviewStage root={scanRoot} groups={data} scannedFiles={count * filesPerGroup}
        scannedBytes={count * filesPerGroup * 1024} issues={[]} issue={null} selectionPending={false}
        expandedGroupIds={expanded}
        onToggleGroup={id => setExpanded(current => {
          const next = new Set(current); if (!next.delete(id)) next.add(id); return next;
        })}
        onToggleAllGroups={expand => setExpanded(new Set(expand ? data.map(group => group.id) : []))}
        onDecision={(id, path, cleanup) => {
          setData(current => current.map(group => {
            if (group.id !== id) return group;
            const files = group.files.map(file => file.path === path ? { ...file, cleanup } : file);
            return { ...group, files, reclaimableBytes: files.filter(file => file.cleanup).length * group.sizeBytes };
          }));
          decision = { id, path, cleanup };
        }}
        onCopyPath={path => { action = { kind: 'copy', path }; }}
        onRevealFile={path => { action = { kind: 'reveal', path }; }} onRequestSingleCleanup={() => {}}
        onKeepAll={id => setData(current => current.map(group => group.id === id
          ? { ...group, reclaimableBytes: 0, files: group.files.map(file => ({ ...file, cleanup: false })) } : group))}
        onRestoreAll={() => setData(initial)} />
    </div></section>
  </main>;
}

function snapshot() {
  const names = [...document.querySelectorAll('.review-group__name strong')].map(node => node.textContent);
  const paths = [...document.querySelectorAll('.file-copy small')].map(node => node.textContent);
  return { totalGroups: currentData.length, totalFiles: currentData.reduce((sum, group) => sum + group.files.length, 0),
    selectedFiles: currentData.reduce((sum, group) => sum + group.files.filter(file => file.cleanup).length, 0),
    expandedGroups: currentExpanded.size, mountedGroups: groups().length, mountedFiles: rows().length,
    firstGroupName: names[0] ?? null, lastGroupName: names.at(-1) ?? null,
    firstFilePath: paths[0] ?? null, lastFilePath: paths.at(-1) ?? null,
    secondFileSelected: rows()[1]?.querySelector('input').checked ?? null,
    query: document.querySelector('[type=search]')?.value ?? '',
    focusConnected: !!document.activeElement?.isConnected,
    focusOnGroupHeader: document.activeElement?.matches('.review-group__head') ?? false,
    domNodes: document.getElementsByTagName('*').length };
}

function DiagnosticsFixture({ receipt, issues, data, openGroup }) {
  const review = !receipt;
  return <main className={`app-shell ${review ? 'app-shell--review' : ''}`}>
    <header className="stage-rail">合成诊断组件验证</header>
    <section className={`workspace ${review ? 'workspace--review' : ''}`}>
      {!review && <header className="workspace-header"><h1 id="page-title">处理结果</h1></header>}
      <div className={`stage-viewport ${review ? 'stage-viewport--review' : ''}`}>
        {receipt ? <CleanupStage view="complete" session={{ root: scanRoot, groups: [], issues: [], scannedFiles: 0, scannedBytes: 0 }}
          report={receipt} issue={null} onCopyPath={path => { action = { kind: 'copy', path }; }}
          onRevealFile={path => { action = { kind: 'reveal', path }; }} />
          : <ReviewStage root={scanRoot} groups={data} scannedFiles={10001} scannedBytes={10241024}
            issues={issues} issue={null} selectionPending={false} expandedGroupIds={new Set(openGroup ? data.map(group => group.id) : [])}
            onToggleGroup={() => {}} onToggleAllGroups={() => {}} onDecision={() => {}}
            onCopyPath={() => {}} onRevealFile={() => {}} onRequestSingleCleanup={() => {}}
            onKeepAll={() => {}} onRestoreAll={() => {}} />}
      </div>
      {!review && <footer className="action-dock">合成夹具，无文件操作</footer>}
    </section>
  </main>;
}

function diagnosticsSnapshot() {
  const receiptRows = [...document.querySelectorAll('.receipt-details li')];
  const issueRows = [...document.querySelectorAll('.scan-issues li')];
  const focus = document.activeElement;
  const warnings = [...document.querySelectorAll('.review-file-row__warning')];
  const warningRect = warnings[0]?.getBoundingClientRect();
  const scrollRegions = [...document.querySelectorAll('body *')].filter(node => {
    const style = getComputedStyle(node);
    return /^(auto|scroll)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
  });
  return {
    receiptRows: receiptRows.length, issueRows: issueRows.length,
    firstReceiptPath: receiptRows[0]?.querySelector('p')?.textContent ?? null,
    lastReceiptPath: receiptRows.at(-1)?.querySelector('p')?.textContent ?? null,
    firstIssuePath: issueRows[0]?.querySelector('span')?.textContent ?? null,
    lastIssuePath: issueRows.at(-1)?.querySelector('span')?.textContent ?? null,
    receiptRange: document.querySelector('nav[aria-label="处理记录分页"] span')?.textContent ?? null,
    issueRange: document.querySelector('nav[aria-label="扫描问题分页"] span')?.textContent ?? null,
    activeFilter: document.querySelector('.receipt-stats [aria-pressed="true"]')?.textContent ?? null,
    issueSummary: document.querySelector('.scan-issues summary')?.textContent ?? null,
    issuesOpen: document.querySelector('.scan-issues')?.open ?? false,
    noGroups: !!document.querySelector('.clean-empty'),
    warningCount: warnings.length, warningText: warnings[0]?.textContent ?? null,
    warningVisible: !!warningRect && warningRect.height > 0 && warningRect.top >= 0 && warningRect.bottom <= innerHeight
      && warningRect.left >= 0 && warningRect.right <= innerWidth,
    warningOverflow: warnings.some(node => node.scrollWidth > node.clientWidth + 1),
    revealButtons: receiptRows.reduce((sum, row) => sum + [...row.querySelectorAll('button')].filter(button => button.textContent === '在资源管理器中显示').length, 0),
    focusConnected: !!focus?.isConnected, focusTag: focus?.tagName ?? null, focusText: focus?.textContent ?? null,
    focusInReceipt: !!focus?.closest('.receipt-details'), focusInIssues: !!focus?.closest('.scan-issues'),
    domNodes: document.getElementsByTagName('*').length, width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollRegions: scrollRegions.map(node => ({ className: node.className, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })),
    contentScrollRegions: document.querySelectorAll('[data-scroll-region="content"]').length,
  };
}

async function diagnosticsCheck(expected) {
  const deadline = performance.now() + 45000;
  while (true) {
    const actual = diagnosticsSnapshot();
    if (Object.entries(expected).every(([key, value]) => actual[key] === value)) break;
    if (performance.now() > deadline) throw Error(`Diagnostics assertion timed out: ${JSON.stringify({ expected, actual })}`);
    await frame();
  }
  await frame(); await frame();
  const actual = diagnosticsSnapshot();
  if (!Object.entries(expected).every(([key, value]) => actual[key] === value)) throw Error('Diagnostics changed during frame settlement');
  return { milliseconds: performance.now() - started, ...actual };
}

async function check(expected) {
  const deadline = performance.now() + 45000;
  while (true) {
    const actual = snapshot();
    if (Object.entries(expected).every(([key, value]) => actual[key] === value)) break;
    if (performance.now() > deadline) throw Error(`State/DOM assertion timed out: ${JSON.stringify({ expected, actual })}`);
    await frame();
  }
  await frame(); await frame();
  document.querySelector('.review-stage').getBoundingClientRect();
  const actual = snapshot();
  if (!Object.entries(expected).every(([key, value]) => actual[key] === value)) throw Error('State changed during frame settlement');
  return { milliseconds: performance.now() - started, ...actual };
}

function finish(kind, query) {
  const expected = { totalGroups: count, totalFiles: count * filesPerGroup };
  if (kind === 'entry' || kind === 'restore') return check({ ...expected, mountedGroups: Math.min(count, 50), mountedFiles: Math.min(filesPerGroup, 50) });
  if (kind === 'search') return check({ ...expected, mountedGroups: 1, firstGroupName: `${query}.txt`, query });
  if (kind === 'expand') return check({ ...expected, expandedGroups: count, mountedGroups: Math.min(count, 50), mountedFiles: Math.min(count, 50) * Math.min(filesPerGroup, 50) });
  if (kind === 'selection') {
    if (decision?.id !== 'group-0' || decision.cleanup !== false) throw Error('Expected first-group selection action');
    return check({ ...expected, selectedFiles: count * (filesPerGroup - 1) - 1, secondFileSelected: false });
  }
  throw Error(`Unknown benchmark step: ${kind}`);
}

window.reviewBenchmark = {
  async diagnosticsEnter(kind, size = 10001, hasGroups = true) {
    action = undefined;
    const receipt = kind === 'receipt' ? {
      cancelled: false, remainingFiles: 0, reclaimableBytes: Math.floor(size / 2) * 1024,
      movedCount: Math.floor(size / 2), failedCount: Math.ceil(size / 2), skippedCount: 0,
      items: Array.from({ length: size }, (_, index) => ({ path: `${scanRoot}\\receipt-${String(index).padStart(5, '0')}.txt`,
        status: index % 2 === 0 ? 'failed' : 'moved_to_trash', message: `合成处理原因 ${index}` })),
    } : null;
    const issues = receipt || kind === 'longpath' ? [] : Array.from({ length: size }, (_, index) => ({
      path: `${scanRoot}\\issue-${String(index).padStart(5, '0')}.txt`, message: `合成扫描原因 ${index}`,
    }));
    const data = hasGroups ? [{ id: 'diagnostics-group', digest: 'synthetic', sizeBytes: 1024, reclaimableBytes: 1024,
      recommendationReason: '合成样本', files: [0, 1].map(copy => ({ path: kind === 'longpath' && copy === 1
        ? `${scanRoot}\\${'long-directory\\'.repeat(20)}example.txt` : `${scanRoot}\\copy-${copy}\\example.txt`, name: 'example.txt',
        sizeBytes: 1024, modifiedAt: '2026-01-01T00:00:00Z', cleanup: copy === 1, recommendedKeeper: copy === 0 })) }] : [];
    started = performance.now();
    root.render(<DiagnosticsFixture key={++mount} receipt={receipt} issues={issues} data={data} openGroup={kind === 'longpath'} />);
    return diagnosticsCheck(receipt ? { receiptRows: Math.min(50, Math.ceil(size / 2)) }
      : kind === 'longpath' ? { warningCount: 1, warningVisible: true }
      : { issueRows: 0, issuesOpen: false, noGroups: !hasGroups });
  },
  diagnosticsCheck,
  diagnosticsSnapshot,
  async enter(size, copies = 2, keeper = 0) {
    count = size; filesPerGroup = copies; decision = undefined; action = undefined;
    const initial = Array.from({ length: size }, (_, index) => {
      const name = `unique-${String(index).padStart(5, '0')}.txt`;
      return { id: `group-${index}`, digest: String(index), sizeBytes: 1024, reclaimableBytes: (copies - 1) * 1024,
        recommendationReason: '合成样本', files: Array.from({ length: copies }, (_, copy) => ({ name, sizeBytes: 1024,
          path: `${scanRoot}\\copy-${copy}\\${name}`, modifiedAt: '2026-01-01T00:00:00.000Z',
          cleanup: copy !== keeper, recommendedKeeper: copy === keeper })) };
    });
    started = performance.now();
    root.render(<Fixture key={++mount} initial={initial} />);
    return finish('entry');
  },
  start() { started = performance.now(); },
  finish,
  check,
  snapshot,
  choice(id, copy) { return currentData.find(group => group.id === id)?.files[copy]?.cleanup; },
  lastAction() { return action; },
  async clear() { root.render(null); await frame(); await frame(); },
};
