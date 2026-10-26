import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { DuplicateGroup, ScanIssue } from "../../api/desktopApi";
import { formatBytes } from "../../lib/format";
import { Icon } from "../Icon";
import { ReviewGroup } from "./ReviewGroup";
import { REVIEW_PAGE_SIZE, ReviewPagination } from "./ReviewPagination";
import { ScanIssues } from "./ScanIssues";

interface ReviewStageProps {
  root: string;
  groups: DuplicateGroup[];
  scannedFiles: number;
  scannedBytes: number;
  expandedGroupIds: ReadonlySet<string>;
  selectionPending: boolean;
  issue: string | null;
  issues: ScanIssue[];
  onToggleGroup(groupId: string): void;
  onToggleAllGroups(expand: boolean): void;
  onDecision(groupId: string, path: string, cleanup: boolean): void;
  onCopyPath(path: string): void;
  onRevealFile(path: string): void;
  onRequestSingleCleanup(groupId: string, path: string): void;
  onKeepAll(groupId: string): void;
  onRestoreAll(): void | Promise<void>;
}

export function ReviewStage({
  root,
  groups,
  scannedFiles,
  scannedBytes,
  expandedGroupIds,
  selectionPending,
  issue,
  issues,
  onToggleGroup,
  onToggleAllGroups,
  onDecision,
  onCopyPath,
  onRevealFile,
  onRequestSingleCleanup,
  onKeepAll,
  onRestoreAll,
}: ReviewStageProps) {
  const stageRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusedNode = useRef<HTMLElement | null>(null);
  const focusAfterPage = useRef(false);
  const [groupPage, setGroupPage] = useState(0);
  const [query, setQuery] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const cancelRestoreRef = useRef<HTMLButtonElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const visibleGroups = groups.filter((group) =>
    (!pendingOnly || group.files.some((file) => file.cleanup)) &&
    (!search || group.files.some((file) => `${file.name}\n${file.path}`.toLocaleLowerCase().includes(search))),
  );

  const page = Math.max(0, Math.min(groupPage, Math.ceil(visibleGroups.length / REVIEW_PAGE_SIZE) - 1));

  useLayoutEffect(() => {
    if (groupPage !== page) setGroupPage(page);
    if (focusAfterPage.current || (focusedNode.current && !focusedNode.current.isConnected && document.activeElement === document.body)) {
      focusAfterPage.current = false;
      if (listRef.current) listRef.current.scrollTop = 0;
      (listRef.current?.querySelector<HTMLElement>(".review-group__head") ?? listRef.current)?.focus();
    }
  });

  useEffect(() => {
    if (confirmRestore) {
      cancelRestoreRef.current?.focus();
    }
  }, [confirmRestore]);

  const closeRestoreConfirmation = () => {
    setConfirmRestore(false);
    window.setTimeout(() => restoreButtonRef.current?.focus(), 0);
  };

  useEffect(() => {
    const closeMenusOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      for (const menu of stageRef.current?.querySelectorAll<HTMLDetailsElement>(
        ".review-row-menu[open]",
      ) ?? []) {
        if (!menu.contains(target)) {
          menu.removeAttribute("open");
        }
      }
    };
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const currentMenu = stageRef.current?.querySelector<HTMLDetailsElement>(
        ".review-row-menu[open]",
      );
      if (!currentMenu) {
        return;
      }
      event.preventDefault();
      currentMenu.removeAttribute("open");
      currentMenu.querySelector<HTMLElement>("summary")?.focus();
    };

    document.addEventListener("pointerdown", closeMenusOutside);
    document.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenusOutside);
      document.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, []);

  const allGroupsExpanded = groups.every((group) =>
    expandedGroupIds.has(group.id),
  );

  if (groups.length === 0) {
    return (
      <section
        className="center-state clean-empty stage-enter"
        aria-labelledby="page-title"
      >
        <span className={`center-state__icon ${issues.length ? "" : "center-state__icon--success"}`}>
          <Icon name={issues.length ? "warning" : "spark"} size={31} />
        </span>
        <h1 id="page-title" tabIndex={-1}>
          {issues.length ? "已检查范围内未发现重复文件" : "未发现重复文件"}
        </h1>
        <p>
          已检查 {scannedFiles.toLocaleString("zh-CN")} 个文件，共{" "}
          {formatBytes(scannedBytes)}。
        </p>
        <ScanIssues issues={issues} />
      </section>
    );
  }

  return (
    <section
      aria-labelledby="page-title"
      className="review-stage stage-enter"
      ref={stageRef}
      onFocusCapture={(event) => { focusedNode.current = event.target; }}
    >
      <h1 className="visually-hidden" id="page-title" tabIndex={-1}>
        检查重复文件
      </h1>
      <div aria-label="审阅操作" className="review-toolbar" role="toolbar">
        <div
          aria-label={`重复文件，${groups.length} 组`}
          className="review-result-anchor"
          role="group"
        >
          <Icon name="files" size={16} />
          <span className="review-result-anchor__label">重复文件</span>
          <span className="review-result-anchor__count">{groups.length} 组</span>
        </div>
        <div className="review-toolbar__actions">
          <button
            className="text-button"
            onClick={() => onToggleAllGroups(!allGroupsExpanded)}
            type="button"
          >
            {allGroupsExpanded ? "全部收起" : "全部展开"}
          </button>
          <button
            className="text-button"
            disabled={selectionPending}
            onClick={() => setConfirmRestore(true)}
            ref={restoreButtonRef}
            type="button"
          >
            恢复建议
          </button>
        </div>
      </div>

      <div className="review-filters">
        <input
          aria-label="搜索文件名或路径"
          onChange={(event) => { setQuery(event.currentTarget.value); setGroupPage(0); }}
          placeholder="搜索文件名或路径"
          type="search"
          value={query}
        />
        <button
          aria-pressed={pendingOnly}
          className="text-button"
          onClick={() => { setPendingOnly((current) => !current); setGroupPage(0); }}
          type="button"
        >
          仅看待清理
        </button>
        {search || pendingOnly ? (
          <span>显示 {visibleGroups.length} / {groups.length} 组；清理包含所有已选文件</span>
        ) : null}
      </div>

      <ReviewPagination label="重复组" page={page} total={visibleGroups.length} onPageChange={(nextPage) => {
        focusAfterPage.current = true;
        setGroupPage(nextPage);
      }} />
      {visibleGroups.length > REVIEW_PAGE_SIZE ? <p className="review-page-scope">分页只改变显示；清理包含所有已选文件。</p> : null}

      {confirmRestore ? (
        <div
          aria-describedby="restore-help"
          aria-label="恢复全部建议确认"
          className="restore-confirmation"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !selectionPending) {
              event.preventDefault();
              closeRestoreConfirmation();
            }
          }}
          role="group"
        >
          <p id="restore-help">恢复全部建议将覆盖所有人工选择。</p>
          <button className="button button--ghost" disabled={selectionPending} onClick={closeRestoreConfirmation} ref={cancelRestoreRef} type="button">
            取消恢复
          </button>
          <button
            className="button button--primary"
            disabled={selectionPending}
            onClick={async () => {
              await onRestoreAll();
              closeRestoreConfirmation();
            }}
            type="button"
          >
            确认恢复全部建议
          </button>
        </div>
      ) : null}

      {issue ? (
        <div className="inline-issue inline-issue--danger" role="alert">
          <Icon name="warning" />
          <p>{issue}</p>
        </div>
      ) : null}

      <div className="review-list" data-scroll-region="content" ref={listRef} tabIndex={-1} aria-label="重复文件列表">
        <ScanIssues issues={issues} />
        <div className="review-list__head" aria-hidden="true">
          <span>文件</span>
          <span>当前选择</span>
          <span>预计可释放</span>
        </div>

        {visibleGroups.length === 0 ? <p className="review-filter-empty">没有符合筛选的重复组。清除搜索或关闭筛选可查看全部结果。</p> : null}
        {visibleGroups.slice(page * REVIEW_PAGE_SIZE, (page + 1) * REVIEW_PAGE_SIZE).map((group) => (
          <ReviewGroup key={group.id} root={root} group={group} search={search}
            isOpen={expandedGroupIds.has(group.id)} selectionPending={selectionPending}
            onToggleGroup={onToggleGroup} onDecision={onDecision} onCopyPath={onCopyPath}
            onRevealFile={onRevealFile} onRequestSingleCleanup={onRequestSingleCleanup} onKeepAll={onKeepAll} />
        ))}
      </div>
    </section>
  );
}
