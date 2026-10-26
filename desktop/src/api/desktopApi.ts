import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import { fileNameFromPath } from "../lib/format";

export type ScanStage = "enumerating" | "partial_hash" | "full_hash";

export interface DirectorySelection {
  path: string;
  name: string;
}

export interface ScanIssue {
  path: string;
  message: string;
}

export interface FileCandidate {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  cleanup: boolean;
  recommendedKeeper: boolean;
}

export interface DuplicateGroup {
  id: string;
  digest: string;
  sizeBytes: number;
  reclaimableBytes: number;
  recommendationReason: string;
  files: FileCandidate[];
}

export interface ScanSession {
  root: string;
  scannedFiles: number;
  scannedBytes: number;
  issues: ScanIssue[];
  groups: DuplicateGroup[];
}

export interface ScanProgress {
  stage: ScanStage;
  completed: number;
  total: number;
  scannedFiles: number;
  scannedBytes: number;
  currentPath?: string | null;
}

export type CleanupStatus =
  | "moved_to_trash"
  | "changed"
  | "blocked"
  | "failed";

export interface CleanupItemResult {
  path: string;
  status: CleanupStatus;
  message: string;
}

export interface CleanupReport {
  cancelled: boolean;
  remainingFiles: number;
  reclaimableBytes: number;
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  items: CleanupItemResult[];
}

export interface CleanupProgress {
  completedFiles: number;
  totalFiles: number;
  currentPath: string | null;
  movedCount: number;
  skippedCount: number;
  failedCount: number;
}

export interface CleanupTarget {
  groupId: string;
  path: string;
}

export interface CleanupOutcome {
  report: CleanupReport;
  session: ScanSession;
}

export type Unlisten = () => void;

export interface DesktopApi {
  selectScanRoot(): Promise<DirectorySelection | null>;
  startScan(root: string): Promise<ScanSession>;
  cancelScan(): Promise<boolean>;
  cancelCleanup(): Promise<boolean>;
  subscribeCloseBlocked(listener: () => void): Promise<Unlisten>;
  subscribeCleanupProgress(listener: (progress: CleanupProgress) => void): Promise<Unlisten>;
  subscribeScanProgress(
    listener: (progress: ScanProgress) => void,
  ): Promise<Unlisten>;
  updateSelection(
    groupId: string,
    path: string,
    cleanup: boolean,
  ): Promise<DuplicateGroup>;
  keepGroup(groupId: string): Promise<DuplicateGroup>;
  restoreRecommendedSelections(): Promise<ScanSession>;
  confirmCleanup(target?: CleanupTarget): Promise<CleanupOutcome>;
  copyPath(path: string): Promise<void>;
  revealFile(path: string): Promise<void>;
}

interface WireFileSnapshot {
  path: string;
  size: number;
  modifiedAtMs: number;
  hardLinkCount: number;
  digest: string;
}

interface WireDuplicateGroup {
  id: string;
  digest: string;
  size: number;
  files: WireFileSnapshot[];
}

interface WireScanResult {
  groups: WireDuplicateGroup[];
  issues: Array<{ path: string; message: string }>;
  scannedFiles: number;
  scannedBytes: number;
}

interface WireGroupSelection {
  groupId: string;
  cleanupPaths: string[];
  reclaimableBytes: number;
  recommendationReason: string;
}

interface WireSessionView {
  result: WireScanResult | null;
  selections: WireGroupSelection[];
}

interface WireScanProgress {
  stage: ScanStage;
  scannedFiles: number;
  scannedBytes: number;
  completedFiles: number;
  totalFiles: number;
  currentPath?: string | null;
}

interface WireCleanupItem {
  path: string;
  size: number;
  status: CleanupStatus;
  message: string;
}

interface WireCleanupReport {
  cancelled: boolean;
  remainingFiles: number;
  items: WireCleanupItem[];
  reclaimableBytes: number;
}

function mapGroup(
  group: WireDuplicateGroup,
  selection: WireGroupSelection,
  recommendedKeeper: string | undefined,
): DuplicateGroup {
  const cleanupPaths = new Set(selection.cleanupPaths);
  const files = group.files.map((file) => ({
    path: file.path,
    name: fileNameFromPath(file.path),
    sizeBytes: file.size,
    modifiedAt: new Date(file.modifiedAtMs).toISOString(),
    cleanup: cleanupPaths.has(file.path),
    recommendedKeeper: file.path === recommendedKeeper,
  }));
  files.sort(
    (left, right) =>
      Number(right.recommendedKeeper) - Number(left.recommendedKeeper) ||
      left.path.localeCompare(right.path, "zh-CN", { sensitivity: "base" }),
  );
  return {
    id: group.id,
    digest: group.digest,
    sizeBytes: group.size,
    reclaimableBytes: selection.reclaimableBytes,
    recommendationReason: selection.recommendationReason,
    files,
  };
}

export function createTauriDesktopApi(): DesktopApi {
  let wireSession: WireSessionView | null = null;
  let scanRoot = "";
  const recommendedKeepers = new Map<string, string>();

  const mapSession = (view: WireSessionView): ScanSession => {
    const result = view.result;
    if (!result) {
      throw new Error("扫描完成后未返回结果");
    }
    const selections = new Map(view.selections.map((selection) => [selection.groupId, selection]));
    const groups = result.groups.map((group) => {
      const selection = selections.get(group.id);
      if (!selection) {
        throw new Error(`重复组 ${group.id} 缺少选择状态`);
      }
      if (!group.files.some((file) => file.path === recommendedKeepers.get(group.id))) {
        const cleanupPaths = new Set(selection.cleanupPaths);
        recommendedKeepers.set(
          group.id,
          group.files.find((file) => !cleanupPaths.has(file.path))?.path ?? "",
        );
      }
      return mapGroup(group, selection, recommendedKeepers.get(group.id));
    });
    return {
      root: scanRoot,
      scannedFiles: result.scannedFiles,
      scannedBytes: result.scannedBytes,
      issues: result.issues,
      groups,
    };
  };

  const applyGroupSelection = (updated: WireGroupSelection): DuplicateGroup => {
    const group = wireSession?.result?.groups.find((candidate) => candidate.id === updated.groupId);
    if (!wireSession || !group) {
      throw new Error("重复组不存在");
    }
    wireSession = {
      ...wireSession,
      selections: wireSession.selections.map((selection) =>
        selection.groupId === updated.groupId ? updated : selection,
      ),
    };
    return mapGroup(group, updated, recommendedKeepers.get(group.id));
  };

  return {
    selectScanRoot: async () => {
      const path = await open({ directory: true, multiple: false });
      return typeof path === "string"
        ? { path, name: fileNameFromPath(path) }
        : null;
    },
    startScan: async (root) => {
      scanRoot = root;
      recommendedKeepers.clear();
      const view = await invoke<WireSessionView>("start_scan", { path: root });
      wireSession = view;
      return mapSession(view);
    },
    cancelScan: () => invoke<boolean>("cancel_scan"),
    cancelCleanup: () => invoke<boolean>("cancel_cleanup"),
    subscribeCloseBlocked: (listener) =>
      listen("operation-close-blocked", () => listener()),
    subscribeCleanupProgress: (listener) =>
      listen<CleanupProgress>("cleanup-progress", (event) => listener(event.payload)),
    subscribeScanProgress: async (listener) =>
      listen<WireScanProgress>("scan-progress", (event) => {
        const progress = event.payload;
        listener({
          stage: progress.stage,
          completed: progress.completedFiles,
          total: progress.totalFiles,
          scannedFiles: progress.scannedFiles,
          scannedBytes: progress.scannedBytes,
          currentPath: progress.currentPath,
        });
      }),
    updateSelection: async (groupId, path, cleanup) => {
      if (!wireSession?.result) {
        throw new Error("当前没有可更新的扫描结果");
      }
      const updated = await invoke<WireGroupSelection>("set_file_cleanup", {
        groupId,
        path,
        shouldCleanup: cleanup,
      });
      return applyGroupSelection(updated);
    },
    keepGroup: async (groupId) => {
      if (!wireSession?.result) {
        throw new Error("当前没有可更新的扫描结果");
      }
      return applyGroupSelection(await invoke<WireGroupSelection>("keep_group", { groupId }));
    },
    restoreRecommendedSelections: async () => {
      const view = await invoke<WireSessionView>("restore_recommended_selections");
      wireSession = view;
      return mapSession(view);
    },
    confirmCleanup: async (target) => {
      const { report, session } = await invoke<{
        report: WireCleanupReport;
        session: WireSessionView;
      }>("confirm_cleanup", { target: target ?? null });
      const mappedSession = mapSession(session);
      wireSession = session;
      const movedItems = report.items.filter(
        (item) => item.status === "moved_to_trash",
      );
      return {
        session: mappedSession,
        report: {
          cancelled: report.cancelled,
          remainingFiles: report.remainingFiles,
          reclaimableBytes: report.reclaimableBytes,
          movedCount: movedItems.length,
          skippedCount: report.items.filter(
            (item) => item.status === "changed" || item.status === "blocked",
          ).length,
          failedCount: report.items.filter((item) => item.status === "failed").length,
          items: report.items,
        },
      };
    },
    copyPath: async (path) => navigator.clipboard.writeText(path),
    revealFile: (path) => invoke<void>("reveal_file", { path }),
  };
}

export const tauriDesktopApi = createTauriDesktopApi();
