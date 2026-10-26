import { useId, useLayoutEffect, useRef, useState } from "react";

import type { CleanupProgress, CleanupReport, ScanSession } from "../../api/desktopApi";
import { formatBytes } from "../../lib/format";
import { getRecyclePathIssue } from "../../lib/recycle";
import { Icon } from "../Icon";
import { REVIEW_PAGE_SIZE, ReviewPagination } from "./ReviewPagination";

export type CleanupView = "confirm" | "running" | "complete" | "failed";

interface CleanupStageProps {
  view: CleanupView;
  session: ScanSession;
  report: CleanupReport | null;
  issue: string | null;
  progress?: CleanupProgress | null;
  progressIssue?: string | null;
  stopping?: boolean;
  onCopyPath(path: string): void;
  onRevealFile(path: string): void;
}

function cleanupSummary(session: ScanSession) {
  return session.groups.reduce(
    (summary, group) => {
      let groupFiles = 0;
      for (const file of group.files) {
        if (file.cleanup) {
          summary.files += 1;
          if (getRecyclePathIssue(file.path)) summary.restrictedFiles += 1;
          groupFiles += 1;
        }
      }
      if (groupFiles > 0) {
        summary.groups += 1;
      }
      summary.bytes += group.reclaimableBytes;
      return summary;
    },
    { files: 0, groups: 0, bytes: 0, restrictedFiles: 0 },
  );
}

export function CleanupStage({
  view,
  session,
  report,
  issue,
  onCopyPath,
  onRevealFile,
  progress = null,
  progressIssue = null,
  stopping = false,
}: CleanupStageProps) {
  const summary = cleanupSummary(session);
  const [result, setResult] = useState<{ report: CleanupReport | null; filter: "unprocessed" | "moved" | "all" | null; page: number }>({ report, filter: null, page: 0 });
  const pathPrefix = useId();
  const detailsRef = useRef<HTMLDivElement>(null);
  const focusedNode = useRef<HTMLElement | null>(null);
  const focusAfterPage = useRef(false);
  if (result.report !== report) setResult({ report, filter: null, page: 0 });

  const partial = !!report && (report.skippedCount > 0 || report.failedCount > 0);
  const activeFilter = result.filter ?? (partial ? "unprocessed" : "moved");
  const items = report?.items.filter((item) => activeFilter === "all" ||
    (activeFilter === "moved" ? item.status === "moved_to_trash" : item.status !== "moved_to_trash")) ?? [];
  const page = Math.max(0, Math.min(result.page, Math.ceil(items.length / REVIEW_PAGE_SIZE) - 1));

  useLayoutEffect(() => {
    if (result.page !== page) setResult((current) => ({ ...current, page }));
    if (focusAfterPage.current || (focusedNode.current && !focusedNode.current.isConnected && document.activeElement === document.body)) {
      focusAfterPage.current = false;
      (detailsRef.current?.querySelector<HTMLElement>("button") ?? detailsRef.current)?.focus();
    }
  });

  const changeFilter = (filter: "unprocessed" | "moved" | "all") => setResult({ report, filter, page: 0 });

  if (view === "running") {
    const total = progress?.totalFiles ?? summary.files;
    const completed = progress?.completedFiles ?? 0;
    const determinate = !!progress && total > 0;
    return (
      <section className="cleanup-running stage-enter" aria-labelledby="page-title">
        <span className="cleanup-running__scanner" aria-hidden="true">
          <Icon name="archive" size={34} />
        </span>
        <h2>{stopping ? "完成当前文件后停止，不再处理后续文件" : "正在把确认的副本移至回收站"}</h2>
        {progressIssue ? <p className="cleanup-progress-note" role="status">{progressIssue}，请等待处理结果。</p> : (
          <p className="cleanup-progress-count">已处理 {completed} / {total} 个文件</p>
        )}
        <div
          aria-label="清理进度"
          aria-valuemin={determinate ? 0 : undefined}
          aria-valuemax={determinate ? total : undefined}
          aria-valuenow={determinate ? completed : undefined}
          className={`progress-track ${determinate ? "" : "progress-track--indeterminate"}`}
          role="progressbar"
        >
          <span style={determinate ? { width: `${Math.min(100, (completed / total) * 100)}%` } : undefined} />
        </div>
        <p className="cleanup-current-path">{progress?.currentPath ?? "正在准备或整理处理结果…"}</p>
        {progress ? <p className="cleanup-progress-note">已回收 {progress.movedCount} 个 · 跳过 {progress.skippedCount} 个 · 失败 {progress.failedCount} 个</p> : null}
        {issue ? <p className="inline-issue inline-issue--danger" role="alert">{issue}</p> : null}
      </section>
    );
  }

  if (view === "complete" && report) {
    return (
      <section className="cleanup-receipt stage-enter" aria-labelledby="page-title"
        onFocusCapture={(event) => { focusedNode.current = event.target; }}>
        <h2>{report.cancelled ? "清理已停止" : partial ? (report.movedCount ? "部分文件未处理" : "未能清理所选文件") : "清理完成"}</h2>
        {report.remainingFiles > 0 ? <p className="receipt-remaining">还有 {report.remainingFiles} 个文件未开始处理。</p> : null}
        <div className="receipt-capacity">
          <span>已移入回收站的可回收容量</span>
          <strong>{formatBytes(report.reclaimableBytes)}</strong>
          <small>清空系统回收站后才会释放磁盘空间</small>
        </div>
        <div aria-label="筛选处理结果" className="receipt-stats" role="group">
          <button aria-pressed={activeFilter === "unprocessed"} className="text-button" onClick={() => changeFilter("unprocessed")} type="button">
            {report.cancelled ? "失败或跳过" : "未处理"} {report.skippedCount + report.failedCount} 个
          </button>
          <button aria-pressed={activeFilter === "moved"} className="text-button" onClick={() => changeFilter("moved")} type="button">
            已移入回收站 {report.movedCount} 个
          </button>
          <button aria-pressed={activeFilter === "all"} className="text-button" onClick={() => changeFilter("all")} type="button">
            {report.cancelled ? "已处理记录" : "全部"} {report.items.length} 个
          </button>
        </div>
        {partial ? (
          <p className="receipt-unprocessed-count">失败 {report.failedCount} 个 · 跳过 {report.skippedCount} 个</p>
        ) : null}
        {issue ? <p className="inline-issue inline-issue--danger" role="alert">{issue}</p> : null}
        <ReviewPagination label="处理记录" page={page} total={items.length} onPageChange={(nextPage) => {
          focusAfterPage.current = true;
          setResult((current) => ({ ...current, page: nextPage }));
        }} />
        <div aria-label="处理详情" className="receipt-details" ref={detailsRef} tabIndex={-1}>
          {items.length === 0 ? <p className="receipt-empty">没有此类处理记录。</p> : (
            <ul>
              {items.slice(page * REVIEW_PAGE_SIZE, (page + 1) * REVIEW_PAGE_SIZE).map((item, index) => {
                const pathId = `${pathPrefix}-receipt-path-${page * REVIEW_PAGE_SIZE + index}`;
                return (
                  <li key={item.path}>
                    <div className="receipt-details__copy">
                      <span className={item.status === "failed" ? "has-failure" : ""}>
                        {{ moved_to_trash: "已移入回收站", failed: "失败", changed: "文件已变化", blocked: "已阻止" }[item.status]}
                      </span>
                      <p id={pathId}>{item.path}</p>
                      <small>{item.message}</small>
                    </div>
                    <div className="receipt-details__actions">
                      <button aria-describedby={pathId} className="text-button" onClick={() => onCopyPath(item.path)} type="button">
                        复制完整路径
                      </button>
                      {item.status !== "moved_to_trash" ? (
                        <button aria-describedby={pathId} className="text-button" onClick={() => onRevealFile(item.path)} type="button">
                          在资源管理器中显示
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    );
  }

  if (view === "failed") {
    return (
      <section className="center-state stage-enter" aria-labelledby="page-title">
        <span className="center-state__icon center-state__icon--danger">
          <Icon name="warning" size={30} />
        </span>
        <h2>未能确认清理结果</h2>
        <p>请先检查文件状态，再决定是否继续清理。</p>
        <p role="alert">{issue ?? "未收到可确认的清理结果。"}</p>
      </section>
    );
  }

  return (
    <section className="cleanup-confirm stage-enter" aria-labelledby="page-title">
      <div className="cleanup-ticket">
        <div className="cleanup-ticket__body">
          <h2>准备移动 {summary.files} 个副本</h2>
          <dl>
            <div>
              <dt>扫描位置</dt>
              <dd className="path-text" title={session.root}>
                {session.root}
              </dd>
            </div>
            <div>
              <dt>涉及重复组</dt>
              <dd>{summary.groups} 组</dd>
            </div>
            <div>
              <dt>预计释放</dt>
              <dd className="ticket-capacity">{formatBytes(summary.bytes)}</dd>
            </div>
          </dl>
        </div>
      </div>

      {summary.restrictedFiles > 0 ? (
        <div className="inline-issue inline-issue--warning" role="status">
          <Icon name="warning" />
          <p>已选文件中有 {summary.restrictedFiles} 个因路径过长，当前版本无法回收。预计容量仍包含这些文件；请缩短路径后重新扫描。</p>
        </div>
      ) : null}
      <div className="confirmation-safety">
        <Icon name="shield" size={18} />
        <span>文件将移至回收站。</span>
      </div>
    </section>
  );
}
