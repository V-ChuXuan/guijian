import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  tauriDesktopApi,
  type CleanupProgress,
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
import { getRecyclePathIssue } from "./lib/recycle";
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

function selectionBaseline(session: ScanSession): Map<string, boolean> {
  return new Map(session.groups.flatMap((group) => group.files.map((file) => [file.path, file.cleanup] as const)));
}

function reconcileBaseline(baseline: ReadonlyMap<string, boolean>, session: ScanSession): Map<string, boolean> {
  const remaining = new Map(session.groups.flatMap((group) => group.files.map((file) => [file.path, baseline.get(file.path) ?? file.cleanup] as const)));
  for (const group of session.groups) {
    if (group.files.every((file) => remaining.get(file.path))) {
      const keeper = group.files.find((file) => file.recommendedKeeper);
      if (keeper) remaining.set(keeper.path, false);
    }
  }
  return remaining;
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
  const [scanProgressIssue, setScanProgressIssue] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [session, setSession] = useState<ScanSession | null>(null);
  const [baseline, setBaseline] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [pendingNavigation, setPendingNavigation] = useState<"rescan" | "changeFolder" | null>(null);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectionPending, setSelectionPending] = useState(false);
  const [reviewIssue, setReviewIssue] = useState<string | null>(null);
  const [singleCleanupTarget, setSingleCleanupTarget] =
    useState<SingleCleanupTarget | null>(null);
  const [singleCleanupPending, setSingleCleanupPending] = useState(false);
  const [singleCleanupIssue, setSingleCleanupIssue] = useState<string | null>(null);
  const [singleCleanupResultUnknown, setSingleCleanupResultUnknown] = useState(false);
  const [cleanupView, setCleanupView] = useState<CleanupView>("confirm");
  const [cleanupReport, setCleanupReport] = useState<CleanupReport | null>(null);
  const [cleanupIssue, setCleanupIssue] = useState<string | null>(null);
  const [cleanupProgress, setCleanupProgress] = useState<CleanupProgress | null>(null);
  const [cleanupProgressIssue, setCleanupProgressIssue] = useState<string | null>(null);
  const [cleanupStopping, setCleanupStopping] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [scanCancelling, setScanCancelling] = useState(false);
  const scanPromiseRef = useRef<Promise<ScanSession> | null>(null);
  const cancelRequestRef = useRef<Promise<boolean> | null>(null);
  const selectingRef = useRef(false);
  const selectionPendingRef = useRef(false);
  const singleCleanupPendingRef = useRef(false);
  const singleCleanupTriggerRef = useRef<HTMLElement | null>(null);
  const navigationTriggerRef = useRef<HTMLElement | null>(null);
  const navigationCancelRef = useRef<HTMLButtonElement>(null);
  const navigationContinueRef = useRef<HTMLButtonElement>(null);
  const cleanupRunningRef = useRef(false);
  const cleanupStoppingRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const busy =
    (stage === 2 && scanView === "running") ||
    (stage === 4 && cleanupView === "running");
  const selectedCleanup = useMemo(() => cleanupSelection(session), [session]);
  const hasManualChanges = !!session?.groups.some((group) => group.files.some((file) => baseline.get(file.path) !== file.cleanup));

  useEffect(() => {
    if (pendingNavigation) navigationCancelRef.current?.focus();
  }, [pendingNavigation]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    setScanProgressIssue(null);
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
    }).catch((error) => {
      if (mounted) setScanProgressIssue(`扫描进度暂不可用：${errorMessage(error)}`);
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [api]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    setCleanupProgressIssue(null);
    void api.subscribeCleanupProgress((nextProgress) => {
      if (mounted && cleanupRunningRef.current) setCleanupProgress(nextProgress);
    }).then((stopListening) => {
      if (mounted) unlisten = stopListening;
      else stopListening();
    }).catch((error) => {
      if (mounted) setCleanupProgressIssue(`清理进度暂不可用：${errorMessage(error)}`);
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [api]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    void api.subscribeCloseBlocked(() => {
      if (mounted) setToast("操作进行中，请先停止后再关闭窗口");
    }).then((stopListening) => {
      if (mounted) unlisten = stopListening;
      else stopListening();
    }).catch((error) => {
      if (mounted) setToast(`关闭提示暂不可用：${errorMessage(error)}`);
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
  }, [stage, cleanupView, scanView, scanCancelling]);

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
      setBaseline(selectionBaseline(nextSession));
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
    setScanIssue(null);
    let cancelRequest: Promise<boolean> | null = null;
    try {
      cancelRequest = api.cancelScan();
      cancelRequestRef.current = cancelRequest;
      const accepted = await cancelRequest;
      if (!accepted) {
        if (scanPromiseRef.current) setScanIssue("停止请求未被接受，扫描仍在进行，请等待扫描结果。");
        return;
      }
      const activeScan = scanPromiseRef.current;
      if (activeScan) {
        await activeScan.catch(() => undefined);
      }
      setScanView("cancelled");
    } catch (error) {
      if (scanPromiseRef.current) setScanIssue(errorMessage(error));
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
    selectionPendingRef.current = true;
    setSelectionPending(true);
    setReviewIssue(null);
    try {
      const updatedGroup = await api.keepGroup(groupId);
      setSession((current) =>
        current
          ? { ...current, groups: current.groups.map((group) => group.id === groupId ? updatedGroup : group) }
          : current,
      );
    } catch (error) {
      setReviewIssue(errorMessage(error));
    } finally {
      selectionPendingRef.current = false;
      setSelectionPending(false);
    }
  };

  const copyPath = async (path: string) => {
    if (stage === 4) {
      setCleanupIssue(null);
    }
    try {
      await api.copyPath(path);
      setToast("路径已复制");
    } catch (error) {
      if (stage === 4) {
        setCleanupIssue(errorMessage(error));
      } else {
        setReviewIssue(errorMessage(error));
      }
    }
  };

  const revealFile = async (path: string) => {
    if (stage === 4) {
      setCleanupIssue(null);
    }
    try {
      await api.revealFile(path);
    } catch (error) {
      if (stage === 4) {
        setCleanupIssue(errorMessage(error));
      } else {
        setReviewIssue(errorMessage(error));
      }
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
      const nextSession = await api.restoreRecommendedSelections();
      setSession(nextSession);
      setBaseline(selectionBaseline(nextSession));
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
    setSingleCleanupResultUnknown(false);
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
    setSingleCleanupResultUnknown(false);
    window.setTimeout(() => trigger?.focus({ preventScroll: true }), 0);
  };

  const confirmSingleCleanup = async () => {
    const target = singleCleanupTarget;
    if (!target || !session || singleCleanupPendingRef.current || singleCleanupResultUnknown) {
      return;
    }
    singleCleanupPendingRef.current = true;
    setSingleCleanupPending(true);
    setSingleCleanupIssue(null);
    try {
      const { report, session: refreshedSession } = await api.confirmCleanup({
        groupId: target.groupId,
        path: target.path,
      });
      setSession(refreshedSession);
      setBaseline((current) => reconcileBaseline(current, refreshedSession));
      if (report.movedCount !== 1) {
        const detail = report.items.find((item) => item.status !== "moved_to_trash");
        setSingleCleanupIssue(detail?.message || "该文件未能移至系统回收站");
        return;
      }
      setExpandedGroupIds((current) => new Set(
        refreshedSession.groups.filter((group) => current.has(group.id)).map((group) => group.id),
      ));
      setReviewIssue(null);
      setSingleCleanupTarget(null);
      setSingleCleanupIssue(null);
      const trigger = singleCleanupTriggerRef.current;
      singleCleanupTriggerRef.current = null;
      window.setTimeout(() => {
        const nextFocus = trigger?.isConnected ? trigger : document.getElementById("page-title");
        nextFocus?.focus({ preventScroll: true });
      }, 0);
    } catch (error) {
      setSingleCleanupIssue(errorMessage(error));
      const preflightRejection = typeof error === "object" && error !== null &&
        "code" in error && typeof error.code === "string" &&
        ["invalid_path", "busy", "unknown_group", "invalid_selection", "no_scan_result"].includes(error.code);
      setSingleCleanupResultUnknown(!preflightRejection);
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
    if (cleanupRunningRef.current) return;
    cleanupRunningRef.current = true;
    cleanupStoppingRef.current = false;
    setCleanupStopping(false);
    setCleanupProgress(null);
    setCleanupView("running");
    setCleanupIssue(null);
    try {
      const { report, session: refreshedSession } = await api.confirmCleanup();
      setSession(refreshedSession);
      setBaseline((current) => reconcileBaseline(current, refreshedSession));
      setCleanupReport(report);
      setCleanupView("complete");
    } catch (error) {
      setCleanupIssue(errorMessage(error));
      setCleanupView("failed");
    } finally {
      cleanupRunningRef.current = false;
      cleanupStoppingRef.current = false;
      setCleanupStopping(false);
    }
  };

  const stopCleanup = async () => {
    if (!cleanupRunningRef.current || cleanupStoppingRef.current) return;
    cleanupStoppingRef.current = true;
    setCleanupStopping(true);
    setCleanupIssue(null);
    try {
      const accepted = await api.cancelCleanup();
      if (!accepted && cleanupRunningRef.current) {
        cleanupStoppingRef.current = false;
        setCleanupStopping(false);
        setCleanupIssue("清理已结束或停止请求未被接受，正在等待结果。");
      }
    } catch (error) {
      if (cleanupRunningRef.current) {
        cleanupStoppingRef.current = false;
        setCleanupStopping(false);
        setCleanupIssue(errorMessage(error));
      }
    }
  };

  const resetWorkflow = () => {
    setStage(1);
    setSelection(null);
    setSession(null);
    setBaseline(new Map());
    setProgress(null);
    setExpandedGroupIds(new Set());
    setCleanupReport(null);
    setScopeIssue(null);
    setScanIssue(null);
    setReviewIssue(null);
    setCleanupIssue(null);
  };

  const closeNavigationConfirmation = () => {
    setPendingNavigation(null);
    window.setTimeout(() => navigationTriggerRef.current?.focus({ preventScroll: true }), 0);
  };

  const requestNavigation = (action: "rescan" | "changeFolder") => {
    if (busy || selectionPendingRef.current) return;
    if (hasManualChanges) {
      navigationTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPendingNavigation(action);
    } else if (action === "rescan") {
      void startScan();
    } else {
      resetWorkflow();
    }
  };

  const navigateBack = (target: number) => {
    if (busy) {
      return;
    }
    if (target === 1) {
      requestNavigation("changeFolder");
    }
  };

  const header =
    stage === 2 && scanView === "cancelled"
      ? { title: "分析已停止" }
      : stage === 2 && scanView === "failed"
        ? { title: "分析未完成" }
        : stage === 2 && scanCancelling
          ? { title: "正在停止分析" }
          : stage === 4 && cleanupView === "running"
            ? { title: cleanupStopping ? "正在停止清理" : "正在清理" }
          : stage === 4 && cleanupView === "complete"
            ? { title: "清理结果" }
            : stage === 4 && cleanupView === "failed"
              ? { title: "清理结果未确认" }
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
              onClick={() => requestNavigation("rescan")}
              type="button"
            >
              <Icon name="scan" size={15} />
              重新扫描
            </button>
            <button
              className="button button--quiet"
              disabled={selectionPending}
              onClick={() => requestNavigation("changeFolder")}
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
            <ScanStage issue={scanIssue} progress={progress} progressIssue={scanProgressIssue} state={scanView} stopping={scanCancelling} />
          ) : null}
          {stage === 3 && session ? (
            <ReviewStage
              groups={session.groups}
              issue={reviewIssue}
              issues={session.issues}
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
              onCopyPath={copyPath}
              onRevealFile={revealFile}
              report={cleanupReport}
              progress={cleanupProgress}
              progressIssue={cleanupProgressIssue}
              stopping={cleanupStopping}
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
                <button className="button button--primary" onClick={() => requestNavigation("changeFolder")} type="button">
                  检查其他文件夹
                </button>
              )
            }
          />
        ) : null}

        {stage === 4 && session && cleanupView === "running" ? (
          <ActionDock secondary={
            <button className="button button--ghost" disabled={cleanupStopping} onClick={stopCleanup} type="button">
              <Icon name="stop" size={17} />
              {cleanupStopping ? "正在等待当前文件完成…" : "完成当前文件后停止"}
            </button>
          } />
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
                <button className="button button--ghost" onClick={() => requestNavigation("changeFolder")} type="button">
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
                cleanupReport && (cleanupReport.cancelled || cleanupReport.failedCount > 0 || cleanupReport.skippedCount > 0) ? (
                  <button className="button button--primary" onClick={() => setStage(3)} type="button">
                    检查未处理文件
                  </button>
                ) : (
                  <button className="button button--primary" onClick={() => requestNavigation("rescan")} type="button">
                    重新扫描当前文件夹
                  </button>
                )
              ) : null
            }
          />
        ) : null}
      </section>

      <div aria-live="polite" className={`toast ${toast ? "is-visible" : ""}`}>
        {toast}
      </div>

      {pendingNavigation ? (
        <div className="single-cleanup-backdrop">
          <div
            aria-describedby="navigation-help"
            aria-labelledby="navigation-title"
            aria-modal="true"
            className="single-cleanup-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeNavigationConfirmation();
              } else if (event.key === "Tab") {
                event.preventDefault();
                (document.activeElement === navigationCancelRef.current ? navigationContinueRef : navigationCancelRef).current?.focus();
              }
            }}
            role="dialog"
          >
            <header className="single-cleanup-dialog__header"><h2 id="navigation-title">保留当前人工选择？</h2></header>
            <p className="navigation-confirmation-copy" id="navigation-help">继续将丢弃当前人工选择。取消可返回检查结果。</p>
            <footer className="single-cleanup-dialog__actions">
              <button className="button button--ghost" onClick={closeNavigationConfirmation} ref={navigationCancelRef} type="button">取消</button>
              <button className="button button--primary" onClick={() => {
                const action = pendingNavigation;
                setPendingNavigation(null);
                if (action === "rescan") void startScan();
                else resetWorkflow();
              }} ref={navigationContinueRef} type="button">
                {pendingNavigation === "rescan" ? "继续重新扫描" : "继续更换文件夹"}
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {singleCleanupTarget ? (
        <SingleCleanupDialog
          fileName={singleCleanupTarget.fileName}
          issue={singleCleanupIssue}
          onCancel={closeSingleCleanup}
          onConfirm={confirmSingleCleanup}
          pending={singleCleanupPending}
          resultUnknown={singleCleanupResultUnknown}
          relativePath={singleCleanupTarget.relativePath}
          warning={getRecyclePathIssue(singleCleanupTarget.path)}
        />
      ) : null}
    </main>
  );
}

export default App;
