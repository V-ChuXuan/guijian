import { useId, useLayoutEffect, useRef, useState } from "react";

import type { DuplicateGroup } from "../../api/desktopApi";
import { fileNameFromPath, formatBytes, formatDate, formatRelativePath } from "../../lib/format";
import { getRecyclePathIssue } from "../../lib/recycle";
import { Icon } from "../Icon";
import { REVIEW_PAGE_SIZE, ReviewPagination } from "./ReviewPagination";

interface ReviewGroupProps {
  root: string;
  group: DuplicateGroup;
  isOpen: boolean;
  search: string;
  selectionPending: boolean;
  onToggleGroup(groupId: string): void;
  onDecision(groupId: string, path: string, cleanup: boolean): void;
  onCopyPath(path: string): void;
  onRevealFile(path: string): void;
  onRequestSingleCleanup(groupId: string, path: string): void;
  onKeepAll(groupId: string): void;
}

export function ReviewGroup({ root, group, isOpen, search, selectionPending, onToggleGroup, onDecision, onCopyPath, onRevealFile, onRequestSingleCleanup, onKeepAll }: ReviewGroupProps) {
  const headerRef = useRef<HTMLButtonElement>(null);
  const focusedNode = useRef<HTMLElement | null>(null);
  const focusAfterPage = useRef(false);
  const pathPrefix = useId();
  const groupPathId = `${pathPrefix}-group-path`;
  const cleanups = group.files.filter((file) => file.cleanup).length;
  const keptCount = group.files.length - cleanups;
  const firstMatch = search ? group.files.findIndex((file) => `${file.name}\n${file.path}`.toLocaleLowerCase().includes(search)) : 0;
  const matchingPage = Math.floor(Math.max(0, firstMatch) / REVIEW_PAGE_SIZE);
  const [fileView, setFileView] = useState({ search, page: matchingPage });
  const requestedPage = fileView.search === search ? fileView.page : matchingPage;
  const page = Math.max(0, Math.min(requestedPage, Math.ceil(group.files.length / REVIEW_PAGE_SIZE) - 1));

  useLayoutEffect(() => {
    if (fileView.search !== search || fileView.page !== page) setFileView({ search, page });
    if (focusAfterPage.current || (focusedNode.current && !focusedNode.current.isConnected && document.activeElement === document.body)) {
      focusAfterPage.current = false;
      headerRef.current?.focus();
    }
  });

  const closeMenu = (target: HTMLElement) => {
    const menu = target.closest<HTMLDetailsElement>(".review-row-menu");
    menu?.removeAttribute("open");
    menu?.querySelector<HTMLElement>("summary")?.focus();
  };

  return (
    <article className={`review-group ${isOpen ? "is-open" : ""}`} onFocusCapture={(event) => { focusedNode.current = event.target; }}>
      <button aria-expanded={isOpen} aria-describedby={groupPathId} className="review-group__head" onClick={() => onToggleGroup(group.id)} ref={headerRef} type="button">
        <span className="review-group__chevron"><Icon name="chevron" size={14} /></span>
        <span className="review-group__name">
          <strong>{group.files[0]?.name ?? "未命名文件"}</strong>
          <small>{group.files.length} 份 · 每份 {formatBytes(group.sizeBytes)}</small>
        </span>
        <span className="review-group__metric">
          <strong>{cleanups ? `回收 ${cleanups} 份` : "全部保留"}</strong>
          <small>保留 {keptCount} 份</small>
        </span>
        <span className="review-group__metric">
          <strong>{formatBytes(group.reclaimableBytes)}</strong>
          <small>{cleanups ? "当前选择" : "未选择回收"}</small>
        </span>
      </button>
      <span className="visually-hidden" id={groupPathId}>{group.files[0]?.path}</span>
      {isOpen ? (
        <div className="review-group__files">
          <div className="review-group__toolbar">
            <span><strong>处理选择</strong> · 勾选的文件将进入回收站</span>
            <button className="text-button" disabled={selectionPending || cleanups === 0} onClick={() => onKeepAll(group.id)} type="button">全部保留</button>
          </div>
          <ReviewPagination label="文件" name={group.files[0]?.name} descriptionId={groupPathId} page={page} total={group.files.length} onPageChange={(nextPage) => {
            focusAfterPage.current = true;
            setFileView({ search, page: nextPage });
          }} />
          {group.files.slice(page * REVIEW_PAGE_SIZE, (page + 1) * REVIEW_PAGE_SIZE).map((file, index) => {
            const fileIndex = page * REVIEW_PAGE_SIZE + index;
            const isLastKeeper = !file.cleanup && keptCount === 1;
            const lastKeeperHelpId = isLastKeeper ? `${pathPrefix}-last-keeper-${fileIndex}` : undefined;
            const pathId = `${pathPrefix}-file-path-${fileIndex}`;
            const pathIssue = getRecyclePathIssue(file.path);
            const pathIssueId = pathIssue ? `${pathPrefix}-file-issue-${fileIndex}` : undefined;
            const pathDescription = [pathId, pathIssueId].filter(Boolean).join(" ");
            const state = file.cleanup ? "移至回收站" : "保留";
            return (
              <article className={`review-file-row ${file.cleanup ? "is-cleanup" : "is-keeper"}`} key={file.path}>
                <input
                  aria-describedby={[pathDescription, lastKeeperHelpId].filter(Boolean).join(" ")}
                  aria-label={`移至回收站 ${file.name}`}
                  checked={file.cleanup}
                  disabled={selectionPending || isLastKeeper}
                  onChange={(event) => onDecision(group.id, file.path, event.currentTarget.checked)}
                  title={isLastKeeper ? "每组至少保留一份；先取消另一份的回收选择即可更换保留项" : undefined}
                  type="checkbox"
                />
                {lastKeeperHelpId ? <span className="visually-hidden" id={lastKeeperHelpId}>每组必须保留至少一份；先取消另一份的回收选择即可更换保留项。</span> : null}
                <div className="file-copy" title={file.path}>
                  <p>{fileNameFromPath(file.path)}</p>
                  <small id={pathId}>{formatRelativePath(root, file.path)}</small>
                  {pathIssue ? <small className="review-file-row__warning" id={pathIssueId}>{pathIssue}</small> : null}
                </div>
                <time className="review-file-row__date" dateTime={file.modifiedAt}>{formatDate(file.modifiedAt)}</time>
                <span className="review-file-row__state">{state}</span>
                <button
                  aria-label={`仅回收此文件：${file.name}`} aria-describedby={pathDescription}
                  className="review-single-cleanup" disabled={selectionPending}
                  onClick={() => onRequestSingleCleanup(group.id, file.path)} title={`仅回收此文件：${file.name}`} type="button"
                ><Icon name="trash" size={15} /></button>
                <details className="review-row-menu">
                  <summary aria-haspopup="true" aria-label={`更多操作 ${file.name}`} aria-describedby={pathDescription}><span aria-hidden="true">•••</span></summary>
                  <div className="review-row-menu__panel">
                    <button onClick={(event) => { closeMenu(event.currentTarget); onRevealFile(file.path); }} type="button">在资源管理器中显示</button>
                    <button onClick={(event) => { closeMenu(event.currentTarget); onCopyPath(file.path); }} type="button">复制完整路径</button>
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
