import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  tauriDesktopApi,
  type CleanupReport,
  type DesktopApi,
  type DirectorySelection,
  type ScanProgress,
  type ScanSession,
} from "./api/desktopApi";
import { ActionDock } from "./components/ActionDock";
import { Icon } from "./components/Icon";
import { StageRail } from "./components/StageRail";
import { SingleCleanupDialog } from "./components/SingleCleanupDialog";
import {
  CleanupStage,
  type CleanupView,
} from "./components/stages/CleanupStage";
import { ReviewStage } from "./components/stages/ReviewStage";
import { ScanStage } from "./components/stages/ScanStage";
import { ScopeStage } from "./components/stages/ScopeStage";
import {
  formatBytes,
  formatRelativePath,
  normalizeWindowsPath,
} from "./lib/format";
import "./App.css";

type WorkflowStage = 1 | 2 | 3 | 4;
type ScanView = "running" | "cancelled" | "failed";

interface AppProps {
  api?: DesktopApi;
}

interface SingleCleanupTarget {
  groupId: string;
  path: string;
  fileName: string;
  relativePath: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "操作暂时无法完成，请重试。";
}

function cleanupSelection(session: ScanSession | null) {
  if (!session) {
    return { count: 0, bytes: 0 };
  }
  return session.groups.reduce(
    (summary, group) => {
      for (const file of group.files) {
        if (file.cleanup) {
          summary.count += 1;
        }
      }
      summary.bytes += group.reclaimableBytes;
      return summary;
    },
    { count: 0, bytes: 0 },
  );
}

const pageCopy: Record<WorkflowStage, { title: string }> = {
  1: { title: "选择文件夹" },
  2: { title: "正在分析空间" },
  3: { title: "选择要清理的副本" },
  4: { title: "确认清理" },
};

function App({ api = tauriDesktopApi }: AppProps) {
  const [stage, setStage] = useState<WorkflowStage>(1);
  const [selection, setSelection] = useState<DirectorySelection | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [scopeIssue, setScopeIssue] = useState<string | null>(null);
  const [scanView, setScanView] = useState<ScanView>("running");
  const [scanIssue, setScanIssue] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [session, setSession] = useState<ScanSession | null>(null);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectionPending, setSelectionPending] = useState(false);
  const [reviewIssue, setReviewIssue] = useState<string | null>(null);
  const [singleCleanupTarget, setSingleCleanupTarget] =
    useState<SingleCleanupTarget | null>(null);
  const [singleCleanupPending, setSingleCleanupPending] = useState(false);
  const [singleCleanupIssue, setSingleCleanupIssue] = useState<string | null>(null);
  const [cleanupView, setCleanupView] = useState<CleanupView>("confirm");
  const [cleanupReport, setCleanupReport] = useState<CleanupReport | null>(null);
  const [cleanupIssue, setCleanupIssue] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [scanCancelling, setScanCancelling] = useState(false);
  const scanPromiseRef = useRef<Promise<ScanSession> | null>(null);
  const cancelRequestRef = useRef<Promise<boolean> | null>(null);
  const selectingRef = useRef(false);
  const selectionPendingRef = useRef(false);
  const singleCleanupPendingRef = useRef(false);
  const singleCleanupTriggerRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const busy =
    (stage === 2 && scanView === "running") ||
    (stage === 4 && cleanupView === "running");
  const selectedCleanup = useMemo(() => cleanupSelection(session), [session]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    void api.subscribeScanProgress((nextProgress) => {
      if (mounted) {
        setProgress(nextProgress);
      }
    }).then((stopListening) => {
      if (mounted) {
        unlisten = stopListening;
      } else {
        stopListening();
      }
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [api]);

  useEffect(() => {
    const pageTitle =
      stage === 3
        ? document.querySelector<HTMLElement>("#page-title")
        : titleRef.current;
    pageTitle?.focus({ preventScroll: true });
  }, [stage, cleanupView]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timeout = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const chooseFolder = useCallback(async () => {
    if (selectingRef.current) {
      return;
    }
    selectingRef.current = true;
    setSelecting(true);
    setScopeIssue(null);
    try {
      const nextSelection = await api.selectScanRoot();
      if (nextSelection) {
        setSelection(nextSelection);
      }
    } catch (error) {
      setScopeIssue(errorMessage(error));
    } finally {
      selectingRef.current = false;
      setSelecting(false);
    }
  }, [api]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        event.key.toLowerCase() === "o" &&
        stage === 1 &&
        !selecting
      ) {
        event.preventDefault();
        void chooseFolder();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [chooseFolder, selecting, stage]);

  const startScan = useCallback(async () => {
    if (!selection) {
      return;
    }
    setScanCancelling(false);
    setScanView("running");
    setScanIssue(null);
    setProgress({
      stage: "enumerating",
      completed: 0,
      total: 0,
      scannedFiles: 0,
      scannedBytes: 0,
      currentPath: selection.path,
    });
    setStage(2);
    let scanPromise: Promise<ScanSession> | null = null;
    try {
      scanPromise = api.startScan(selection.path);
      scanPromiseRef.current = scanPromise;
      const nextSession = await scanPromise;
      const cancelRequest = cancelRequestRef.current;
      if (cancelRequest && (await cancelRequest.catch(() => false))) {
        return;
      }
      setSession(nextSession);
      setExpandedGroupIds(
        new Set(nextSession.groups[0] ? [nextSession.groups[0].id] : []),
      );
      setStage(3);
    } catch (error) {
      const cancelRequest = cancelRequestRef.current;
      const cancellationAccepted = cancelRequest
        ? await cancelRequest.catch(() => false)
        : false;
      if (!cancellationAccepted) {
        setScanView("failed");
        setScanIssue(errorMessage(error));
      }
    } finally {
      if (scanPromise && scanPromiseRef.current === scanPromise) {
        scanPromiseRef.current = null;
      }
    }
  }, [api, selection]);

  const cancelScan = async () => {
    if (cancelRequestRef.current) {
      return;
    }
    setScanCancelling(true);
    let cancelRequest: Promise<boolean> | null = null;
    try {
      cancelRequest = api.cancelScan();
      cancelRequestRef.current = cancelRequest;
      const accepted = await cancelRequest;
      if (!accepted) {
        return;
      }
      const activeScan = scanPromiseRef.current;
      if (activeScan) {
        await activeScan.catch(() => undefined);
      }
      setScanView("cancelled");
    } catch (error) {
      setScanView("failed");
      setScanIssue(errorMessage(error));
    } finally {
      if (cancelRequest && cancelRequestRef.current === cancelRequest) {
        cancelRequestRef.current = null;
      }
      setScanCancelling(false);
    }
  };

  const updateDecision = async (
    groupId: string,
    path: string,
    cleanup: boolean,
  ) => {
    if (selectionPendingRef.current) {
      return;
    }
    selectionPendingRef.current = true;
    setSelectionPending(true);
    setReviewIssue(null);
    try {
      const updatedGroup = await api.updateSelection(groupId, path, cleanup);
      setSession((current) =>
        current
          ? {
              ...current,
              groups: current.groups.map((group) =>
                group.id === groupId ? updatedGroup : group,
              ),
            }
          : current,
      );
    } catch (error) {
      setReviewIssue(errorMessage(error));
    } finally {
      selectionPendingRef.current = false;
      setSelectionPending(false);
    }
  };

  const keepAll = async (groupId: string) => {
    if (selectionPendingRef.current) {
      return;
    }
    const group = session?.groups.find((candidate) => candidate.id === groupId);
    if (!group) {
      return;
    }
    selectionPendingRef.current = true;
    setSelectionPending(true);
    setReviewIssue(null);
    try {
      for (const file of group.files.filter((candidate) => candidate.cleanup)) {
        const updatedGroup = await api.updateSelection(groupId, file.path, false);
        setSession((current) =>
          current
            ? {
                ...current,
                groups: current.groups.map((candidate) =>
                  candidate.id === groupId ? updatedGroup : candidate,
                ),
              }
            : current,
        );
      }
    } catch (error) {
      setReviewIssue(errorMessage(error));
    } finally {
      selectionPendingRef.current = false;
      setSelectionPending(false);
    }
  };

  const copyPath = async (path: string) => {
    try {
      await api.copyPath(path);
      setToast("路径已复制");
    } catch (error) {
      setReviewIssue(errorMessage(error));
    }
  };

  const revealFile = async (path: string) => {
    try {
      await api.revealFile(path);
    } catch (error) {
      setReviewIssue(errorMessage(error));
    }
  };

  const restoreAllRecommendations = async () => {
    if (selectionPendingRef.current) {
      return;
    }
    selectionPendingRef.current = true;
    setSelectionPending(true);
    setReviewIssue(null);
    try {
      setSession(await api.restoreRecommendedSelections());
    } catch (error) {
      setReviewIssue(errorMessage(error));
    } finally {
      selectionPendingRef.current = false;
      setSelectionPending(false);
    }
  };

  const requestSingleCleanup = (groupId: string, path: string) => {
    if (selectionPendingRef.current || singleCleanupPendingRef.current) {
      return;
    }
    const file = session?.groups
      .find((group) => group.id === groupId)
      ?.files.find((candidate) => candidate.path === path);
    if (!file || !session) {
      return;
    }
    singleCleanupTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSingleCleanupIssue(null);
    setSingleCleanupTarget({
      groupId,
      path,
      fileName: file.name,
      relativePath: formatRelativePath(session.root, path),
    });
  };

  const closeSingleCleanup = () => {
    if (singleCleanupPendingRef.current) {
      return;
    }
    const trigger = singleCleanupTriggerRef.current;
    setSingleCleanupTarget(null);
    setSingleCleanupIssue(null);
    window.setTimeout(() => trigger?.focus({ preventScroll: true }), 0);
  };

  const confirmSingleCleanup = async () => {
    const target = singleCleanupTarget;
    const currentRoot = session?.root;
    if (!target || !currentRoot || singleCleanupPendingRef.current) {
      return;
    }
    singleCleanupPendingRef.current = true;
    setSingleCleanupPending(true);
    setSingleCleanupIssue(null);
    try {
      const preparedSession = await api.prepareSingleCleanup(
        target.groupId,
        target.path,
      );
      setSession(preparedSession);
      const report = await api.confirmCleanup();
      if (report.movedCount !== 1) {
        const detail = report.items.find((item) => item.status !== "moved_to_trash");
        throw new Error(detail?.message || "该文件未能移至系统回收站");
      }
      const refreshedSession = await api.startScan(currentRoot);
      setSession(refreshedSession);
      setExpandedGroupIds(
        new Set(
          refreshedSession.groups[0] ? [refreshedSession.groups[0].id] : [],
        ),
      );
      setReviewIssue(null);
      setSingleCleanupTarget(null);
      setSingleCleanupIssue(null);
      singleCleanupTriggerRef.current = null;
    } catch (error) {
      setSingleCleanupIssue(errorMessage(error));
    } finally {
      singleCleanupPendingRef.current = false;
      setSingleCleanupPending(false);
    }
  };

  const openCleanupConfirmation = () => {
    if (selectionPendingRef.current) {
      return;
    }
    setCleanupView("confirm");
    setCleanupIssue(null);
    setCleanupReport(null);
    setStage(4);
  };

  const confirmCleanup = async () => {
    setCleanupView("running");
    setCleanupIssue(null);
    try {
      const report = await api.confirmCleanup();
      setCleanupReport(report);
      setCleanupView("complete");
    } catch (error) {
      setCleanupIssue(errorMessage(error));
      setCleanupView("failed");
    }
  };

  const resetWorkflow = () => {
    setStage(1);
    setSelection(null);
    setSession(null);
    setProgress(null);
    setExpandedGroupIds(new Set());
    setCleanupReport(null);
    setScopeIssue(null);
    setScanIssue(null);
    setReviewIssue(null);
    setCleanupIssue(null);
  };

  const navigateBack = (target: number) => {
    if (busy) {
      return;
    }
    if (target === 1) {
      setStage(1);
    }
  };

  const header =
    stage === 4 && cleanupView === "complete"
      ? { title: "清理结果" }
      : stage === 4 && cleanupView === "failed"
        ? { title: "清理未执行" }
        : pageCopy[stage];
  const reviewRoot = session ? normalizeWindowsPath(session.root) : "";

  return (
    <main className={`app-shell ${stage === 3 ? "app-shell--review" : ""}`}>
      {stage === 3 && session ? (
        <header aria-label="审阅命令栏" className="review-command-bar">
          <div
            aria-label={`扫描位置 ${reviewRoot}`}
            className="review-root-path"
            title={reviewRoot}
          >
            <Icon name="folder" size={15} />
            <span>{reviewRoot}</span>
          </div>
          <div className="review-command-bar__actions">
            <button
              className="button button--quiet"
              disabled={selectionPending}
              onClick={startScan}
              type="button"
            >
              <Icon name="scan" size={15} />
              重新扫描
            </button>
            <button
              className="button button--quiet"
              disabled={selectionPending}
              onClick={resetWorkflow}
              type="button"
            >
              <Icon name="folder" size={15} />
              更换文件夹
            </button>
          </div>
        </header>
      ) : (
        <StageRail
          busy={busy || selectionPending}
          currentStage={stage}
          onNavigate={navigateBack}
        />
      )}
      <section className={`workspace ${stage === 3 ? "workspace--review" : ""}`}>
        {stage !== 3 ? (
          <header className="workspace-header">
            <h1 id="page-title" ref={titleRef} tabIndex={-1}>
              {header.title}
            </h1>
          </header>
        ) : null}

        <div
          className={`stage-viewport ${
            stage === 3 ? "stage-viewport--review" : ""
          }`}
        >
          {stage === 1 ? (
            <ScopeStage
              issue={scopeIssue}
              onSelect={chooseFolder}
              selecting={selecting}
              selection={selection}
            />
          ) : null}
          {stage === 2 ? (
            <ScanStage issue={scanIssue} progress={progress} state={scanView} />
          ) : null}
          {stage === 3 && session ? (
            <ReviewStage
              groups={session.groups}
              issue={reviewIssue}
              onCopyPath={copyPath}
              onDecision={updateDecision}
              onKeepAll={keepAll}
              onRequestSingleCleanup={requestSingleCleanup}
              onRestoreAll={restoreAllRecommendations}
              onRevealFile={revealFile}
              onToggleAllGroups={(expand) =>
                setExpandedGroupIds(
                  expand
                    ? new Set(session.groups.map((group) => group.id))
                    : new Set(),
                )
              }
              onToggleGroup={(groupId) =>
                setExpandedGroupIds((current) => {
                  const next = new Set(current);
                  if (next.has(groupId)) {
                    next.delete(groupId);
                  } else {
                    next.add(groupId);
                  }
                  return next;
                })
              }
              scannedBytes={session.scannedBytes}
              scannedFiles={session.scannedFiles}
              selectionPending={selectionPending}
              expandedGroupIds={expandedGroupIds}
              root={session.root}
            />
          ) : null}
          {stage === 4 && session ? (
            <CleanupStage
              issue={cleanupIssue}
              report={cleanupReport}
              session={session}
              view={cleanupView}
            />
          ) : null}
        </div>

        {stage === 1 && selection ? (
          <ActionDock
            primary={
              <button
                className="button button--primary"
                disabled={!selection || selecting}
                onClick={startScan}
                type="button"
              >
                开始分析 <Icon name="chevron" size={17} />
              </button>
            }
          />
        ) : null}

        {stage === 2 ? (
          <ActionDock
            secondary={
              scanView === "running" ? (
                <button
                  className="button button--ghost"
                  disabled={scanCancelling}
                  onClick={cancelScan}
                  type="button"
                >
                  <Icon name="stop" size={17} />
                  {scanCancelling ? "正在停止…" : "停止扫描"}
                </button>
              ) : (
                <button className="button button--ghost" onClick={() => setStage(1)} type="button">
                  返回选择位置
                </button>
              )
            }
            primary={
              scanView !== "running" ? (
                <button className="button button--primary" onClick={startScan} type="button">
                  重新分析
                </button>
              ) : null
            }
          />
        ) : null}

        {stage === 3 && session ? (
          <ActionDock
            summary={
              <div aria-live="polite" className="review-selection-summary">
                <strong>{selectedCleanup.count} 个文件</strong>
                <span>已选择移至回收站</span>
                <i aria-hidden="true" />
                <strong>{formatBytes(selectedCleanup.bytes)}</strong>
                <span>预计可释放</span>
              </div>
            }
            primary={
              session.groups.length ? (
                <button
                  className="button button--primary"
                  disabled={selectionPending || selectedCleanup.count === 0}
                  onClick={openCleanupConfirmation}
                  type="button"
                >
                  检查清理内容 <Icon name="chevron" size={17} />
                </button>
              ) : (
                <button className="button button--primary" onClick={resetWorkflow} type="button">
                  检查其他文件夹
                </button>
              )
            }
          />
        ) : null}

        {stage === 4 && session && cleanupView !== "running" ? (
          <ActionDock
            secondary={
              cleanupView === "confirm" || cleanupView === "failed" ? (
                <button
                  className="button button--ghost"
                  onClick={() => setStage(3)}
                  type="button"
                >
                  返回调整
                </button>
              ) : cleanupView === "complete" ? (
                <button className="button button--ghost" onClick={resetWorkflow} type="button">
                  检查其他文件夹
                </button>
              ) : null
            }
            primary={
              cleanupView === "confirm" || cleanupView === "failed" ? (
                <button
                  className="button button--primary button--cleanup"
                  onClick={confirmCleanup}
                  type="button"
                >
                  <Icon name="archive" size={18} /> 确认移至回收站
                </button>
              ) : cleanupView === "complete" ? (
                <button className="button button--primary" onClick={startScan} type="button">
                  重新扫描当前文件夹
                </button>
              ) : null
            }
          />
        ) : null}
      </section>

      <div aria-live="polite" className={`toast ${toast ? "is-visible" : ""}`}>
        {toast}
      </div>

      {singleCleanupTarget ? (
        <SingleCleanupDialog
          fileName={singleCleanupTarget.fileName}
          issue={singleCleanupIssue}
          onCancel={closeSingleCleanup}
          onConfirm={confirmSingleCleanup}
          pending={singleCleanupPending}
          relativePath={singleCleanupTarget.relativePath}
        />
      ) : null}
    </main>
  );
}

export default App;
