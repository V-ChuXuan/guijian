import { createRoot } from "react-dom/client";
import App from "../desktop/src/App";
import type { CleanupOutcome, CleanupTarget, DesktopApi, DuplicateGroup, ScanSession } from "../desktop/src/api/desktopApi";

type Mode = "unknown" | "internal" | "refusal" | "report";
const root = "D:\\single-cleanup-smoke";
let session: ScanSession = {
  root, scannedFiles: 5, scannedBytes: 5120, issues: [],
  groups: [group("a", ["a-keeper.txt", "a-copy.txt"]), group("b", ["b-keeper.txt", "b-copy.txt", "b-extra.txt"])],
};
let mode: Mode = "unknown";
const calls: CleanupTarget[] = [];
let scans = 0;
let selectionUpdates = 0;
let simulatedSideEffects = 0;
let settle: (() => void) | undefined;

function group(id: string, names: string[]): DuplicateGroup {
  return {
    id, digest: id.repeat(64), sizeBytes: 1024, reclaimableBytes: (names.length - 1) * 1024,
    recommendationReason: "合成夹具默认保留第一份",
    files: names.map((name, index) => ({
      path: `${root}\\${name}`, name, sizeBytes: 1024, modifiedAt: "2026-01-01T00:00:00Z",
      cleanup: index !== 0, recommendedKeeper: index === 0,
    })),
  };
}

function update(groupId: string, path: string, cleanup: boolean) {
  const current = session.groups.find((entry) => entry.id === groupId);
  if (!current || !current.files.some((file) => file.path === path)) throw Error("Invalid synthetic selection");
  const updated = { ...current, files: current.files.map((file) => file.path === path ? { ...file, cleanup } : file) };
  updated.reclaimableBytes = updated.files.filter((file) => file.cleanup).length * 1024;
  session = { ...session, groups: session.groups.map((entry) => entry.id === groupId ? updated : entry) };
  return structuredClone(updated);
}

const unsupported = async (): Promise<never> => { throw Error("Outside single-cleanup smoke scope"); };
const api: DesktopApi = {
  selectScanRoot: async () => ({ path: root, name: "single-cleanup-smoke" }),
  startScan: async () => { scans++; return structuredClone(session); },
  subscribeCloseBlocked: async () => () => {},
  subscribeCleanupProgress: async () => () => {},
  subscribeScanProgress: async () => () => {},
  cancelScan: unsupported, cancelCleanup: unsupported,
  keepGroup: unsupported, restoreRecommendedSelections: unsupported,
  copyPath: unsupported, revealFile: unsupported,
  updateSelection: async (groupId, path, cleanup) => { selectionUpdates++; return update(groupId, path, cleanup); },
  confirmCleanup: (target) => {
    if (!target || settle) throw Error("Expected one synthetic single-file request");
    calls.push(structuredClone(target));
    const requestMode = mode;
    return new Promise<CleanupOutcome>((resolve, reject) => {
      settle = () => {
        settle = undefined;
        if (requestMode === "unknown" || requestMode === "internal") {
          // No disk operation: this flag models a completed side effect before response loss.
          simulatedSideEffects++;
          reject(requestMode === "unknown" ? Error("结果返回失败") : { code: "internal", message: "内部结果返回失败" });
        } else if (requestMode === "refusal") {
          reject({ code: "invalid_selection", message: "合成前置拒绝：目标不在当前组" });
        } else {
          update(target.groupId, target.path, false);
          resolve({
            session: structuredClone(session),
            report: { cancelled: false, remainingFiles: 0, reclaimableBytes: 0, movedCount: 0, skippedCount: 0, failedCount: 1,
              items: [{ path: target.path, status: "failed", message: "合成逐项失败：文件被占用" }] },
          });
        }
      };
    });
  },
};

window.singleCleanupSmoke = {
  setMode(next: Mode) {
    if (settle || !["unknown", "internal", "refusal", "report"].includes(next)) throw Error("Invalid fault mode change");
    mode = next;
  },
  settle() { if (!settle) throw Error("No synthetic request pending"); settle(); },
  snapshot() { return structuredClone({ mode, calls, scans, selectionUpdates, simulatedSideEffects, pending: !!settle, session }); },
};

declare global {
  interface Window {
    singleCleanupSmoke: {
      setMode(mode: Mode): void;
      settle(): void;
      snapshot(): unknown;
    };
  }
}

createRoot(document.getElementById("root")!).render(<App api={api} />);
