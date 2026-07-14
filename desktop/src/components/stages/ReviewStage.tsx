import { useEffect, useRef } from "react";

import type { DuplicateGroup } from "../../api/desktopApi";
import {
  fileNameFromPath,
  formatBytes,
  formatDate,
  formatRelativePath,
} from "../../lib/format";
import { Icon } from "../Icon";

interface ReviewStageProps {
  root: string;
  groups: DuplicateGroup[];
  scannedFiles: number;
  scannedBytes: number;
  expandedGroupIds: ReadonlySet<string>;
  selectionPending: boolean;
  issue: string | null;
  onToggleGroup(groupId: string): void;
  onToggleAllGroups(expand: boolean): void;
  onDecision(groupId: string, path: string, cleanup: boolean): void;
  onCopyPath(path: string): void;
  onRevealFile(path: string): void;
  onRequestSingleCleanup(groupId: string, path: string): void;
  onKeepAll(groupId: string): void;
  onRestoreAll(): void;
}

function cleanupCount(group: DuplicateGroup): number {
  return group.files.filter((file) => file.cleanup).length;
}

export function ReviewStage({
  root,
  groups,
  scannedFiles,
  scannedBytes,
  expandedGroupIds,
  selectionPending,
  issue,
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

  const closeMenu = (target: HTMLElement) => {
    target.closest<HTMLDetailsElement>(".review-row-menu")?.removeAttribute("open");
  };

  const allGroupsExpanded = groups.every((group) =>
    expandedGroupIds.has(group.id),
  );

  if (groups.length === 0) {
    return (
      <section
        className="center-state clean-empty stage-enter"
        aria-labelledby="page-title"
      >
        <span className="center-state__icon center-state__icon--success">
          <Icon name="spark" size={31} />
        </span>
        <h1 id="page-title" tabIndex={-1}>未发现重复文件</h1>
        <p>
          已检查 {scannedFiles.toLocaleString("zh-CN")} 个文件，共{" "}
          {formatBytes(scannedBytes)}。
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="page-title"
      className="review-stage stage-enter"
      ref={stageRef}
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
            onClick={onRestoreAll}
            type="button"
          >
            恢复建议
          </button>
        </div>
      </div>

      {issue ? (
        <div className="inline-issue inline-issue--danger" role="alert">
          <Icon name="warning" />
          <p>{issue}</p>
        </div>
      ) : null}

      <div className="review-list" data-scroll-region="content">
        <div className="review-list__head" aria-hidden="true">
          <span>文件</span>
          <span>当前选择</span>
          <span>预计可释放</span>
        </div>

        {groups.map((group, groupIndex) => {
          const cleanups = cleanupCount(group);
          const keptCount = group.files.length - cleanups;
          const isOpen = expandedGroupIds.has(group.id);

          return (
            <article className={`review-group ${isOpen ? "is-open" : ""}`} key={group.id}>
              <button
                aria-expanded={isOpen}
                className="review-group__head"
                onClick={() => onToggleGroup(group.id)}
                type="button"
              >
                <span className="review-group__chevron">
                  <Icon name="chevron" size={14} />
                </span>
                <span className="review-group__name">
                  <strong>{group.files[0]?.name ?? "未命名文件"}</strong>
                  <small>
                    {group.files.length} 份 · 每份 {formatBytes(group.sizeBytes)}
                  </small>
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

              {isOpen ? (
                <div className="review-group__files">
                  <div className="review-group__toolbar">
                    <span>
                      <strong>处理选择</strong> · 勾选的文件将进入回收站
                    </span>
                    <button
                      className="text-button"
                      disabled={selectionPending || cleanups === 0}
                      onClick={() => onKeepAll(group.id)}
                      type="button"
                    >
                      全部保留
                    </button>
                  </div>

                  {group.files.map((file, fileIndex) => {
                    const isLastKeeper = !file.cleanup && keptCount === 1;
                    const lastKeeperHelpId = isLastKeeper
                      ? `last-keeper-${groupIndex}-${fileIndex}`
                      : undefined;
                    const state = file.cleanup ? "移至回收站" : "保留";

                    return (
                      <article
                        className={`review-file-row ${file.cleanup ? "is-cleanup" : "is-keeper"}`}
                        key={file.path}
                      >
                        <input
                          aria-describedby={lastKeeperHelpId}
                          aria-label={`移至回收站 ${file.name}`}
                          checked={file.cleanup}
                          disabled={selectionPending || isLastKeeper}
                          onChange={(event) =>
                            onDecision(group.id, file.path, event.currentTarget.checked)
                          }
                          title={
                            isLastKeeper
                              ? "每组至少保留一份；先取消另一份的回收选择即可更换保留项"
                              : undefined
                          }
                          type="checkbox"
                        />
                        {lastKeeperHelpId ? (
                          <span className="visually-hidden" id={lastKeeperHelpId}>
                            每组必须保留至少一份；先取消另一份的回收选择即可更换保留项。
                          </span>
                        ) : null}
                        <div className="file-copy" title={file.path}>
                          <p>{fileNameFromPath(file.path)}</p>
                          <small>{formatRelativePath(root, file.path)}</small>
                        </div>
                        <time className="review-file-row__date" dateTime={file.modifiedAt}>
                          {formatDate(file.modifiedAt)}
                        </time>
                        <span className="review-file-row__state">{state}</span>
                        <button
                          aria-label={`仅回收此文件：${file.name}`}
                          className="review-single-cleanup"
                          disabled={selectionPending}
                          onClick={() => onRequestSingleCleanup(group.id, file.path)}
                          title={`仅回收此文件：${file.name}`}
                          type="button"
                        >
                          <Icon name="trash" size={15} />
                        </button>
                        <details className="review-row-menu">
                          <summary
                            aria-haspopup="true"
                            aria-label={`更多操作 ${file.name}`}
                          >
                            <span aria-hidden="true">•••</span>
                          </summary>
                          <div className="review-row-menu__panel">
                            <button
                              onClick={(event) => {
                                closeMenu(event.currentTarget);
                                onRevealFile(file.path);
                              }}
                              type="button"
                            >
                              在资源管理器中显示
                            </button>
                            <button
                              onClick={(event) => {
                                closeMenu(event.currentTarget);
                                onCopyPath(file.path);
                              }}
                              type="button"
                            >
                              复制完整路径
                            </button>
                          </div>
                        </details>
                      </article>
                    );
                  })}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
