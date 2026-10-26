import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTauriDesktopApi } from "./desktopApi";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

function wireSession(paths = ["D:\\files\\a.txt", "D:\\files\\b.txt", "D:\\files\\c.txt"]) {
  return {
    result: {
      groups: [{
        id: "duplicate", digest: "abc", size: 4,
        files: paths.map((path) => ({ path, size: 4, modifiedAtMs: 0, hardLinkCount: 1, digest: "abc" })),
      }],
      issues: [{ path: "D:\\files\\private", message: "拒绝访问" }],
      scannedFiles: 3, scannedBytes: 12,
    },
    selections: [{
      groupId: "duplicate", cleanupPaths: paths.slice(1), reclaimableBytes: (paths.length - 1) * 4,
      recommendationReason: "保留一份",
    }],
  };
}

describe("desktop cleanup IPC", () => {
  beforeEach(() => { invoke.mockReset(); listen.mockReset(); });

  it("subscribes blocked window closes without requiring an event payload", async () => {
    const api = createTauriDesktopApi();
    const listener = vi.fn();
    const unlisten = vi.fn();
    listen.mockResolvedValueOnce(unlisten);
    expect(await api.subscribeCloseBlocked(listener)).toBe(unlisten);
    expect(listen).toHaveBeenCalledWith("operation-close-blocked", expect.any(Function));
    listen.mock.calls[0][1]({ payload: null });
    expect(listener).toHaveBeenCalledExactlyOnceWith();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("subscribes cleanup progress and requests boundary cancellation", async () => {
    const api = createTauriDesktopApi();
    const listener = vi.fn();
    const unlisten = vi.fn();
    listen.mockResolvedValueOnce(unlisten);
    expect(await api.subscribeCleanupProgress(listener)).toBe(unlisten);
    expect(listen).toHaveBeenCalledWith("cleanup-progress", expect.any(Function));
    const progress = { completedFiles: 1, totalFiles: 3, currentPath: "D:\\files\\b.txt", movedCount: 1, skippedCount: 0, failedCount: 0 };
    listen.mock.calls[0][1]({ payload: progress });
    expect(listener).toHaveBeenCalledExactlyOnceWith(progress);
    invoke.mockResolvedValueOnce(true);
    expect(await api.cancelCleanup()).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("cancel_cleanup");
  });

  it("keeps a whole group in one IPC and retains the authoritative session", async () => {
    const api = createTauriDesktopApi();
    const initial = wireSession();
    invoke.mockResolvedValueOnce(initial);
    await api.startScan("D:\\files");
    invoke.mockResolvedValueOnce({ ...initial.selections[0], cleanupPaths: [], reclaimableBytes: 0 });
    const group = await api.keepGroup("duplicate");
    expect(invoke).toHaveBeenLastCalledWith("keep_group", { groupId: "duplicate" });
    expect(group.files.every((file) => !file.cleanup)).toBe(true);
    invoke.mockResolvedValueOnce({ ...initial.selections[0], cleanupPaths: ["D:\\files\\c.txt"], reclaimableBytes: 4 });
    const updated = await api.updateSelection("duplicate", "D:\\files\\c.txt", true);
    expect(updated.files.filter((file) => file.cleanup).map((file) => file.path)).toEqual(["D:\\files\\c.txt"]);
  });

  it("returns cleanup and reconciled session together and keeps later edits on that session", async () => {
    const api = createTauriDesktopApi();
    const initial = wireSession();
    const refreshed = wireSession(["D:\\files\\b.txt", "D:\\files\\c.txt"]);
    invoke.mockResolvedValueOnce(initial);
    await api.startScan("D:\\files");
    invoke.mockResolvedValueOnce({
      report: {
        cancelled: false, remainingFiles: 0,
        reclaimableBytes: 4,
        items: [{ path: "D:\\files\\a.txt", size: 4, status: "moved_to_trash", message: "已回收" }],
      },
      session: refreshed,
    });

    const outcome = await api.confirmCleanup({ groupId: "duplicate", path: "D:\\files\\a.txt" });

    expect(invoke).toHaveBeenLastCalledWith("confirm_cleanup", {
      target: { groupId: "duplicate", path: "D:\\files\\a.txt" },
    });
    expect(outcome.report.movedCount).toBe(1);
    expect(outcome.session.issues).toEqual(initial.result.issues);
    expect(outcome.session.groups[0].files.find((file) => file.recommendedKeeper)?.path).toBe("D:\\files\\b.txt");
    invoke.mockResolvedValueOnce({ ...refreshed.selections[0], cleanupPaths: [], reclaimableBytes: 0 });
    const updated = await api.updateSelection("duplicate", "D:\\files\\c.txt", false);
    expect(updated.files.map((file) => file.path)).toEqual(["D:\\files\\b.txt", "D:\\files\\c.txt"]);
    expect(updated.files.every((file) => !file.cleanup)).toBe(true);
  });

  it("passes an explicit null target for the authoritative batch plan and maps partial failures", async () => {
    const api = createTauriDesktopApi();
    invoke.mockResolvedValueOnce(wireSession());
    await api.startScan("D:\\files");
    invoke.mockResolvedValueOnce({
      report: {
        cancelled: true, remainingFiles: 1,
        reclaimableBytes: 0,
        items: [
          { path: "D:\\files\\b.txt", size: 4, status: "changed", message: "文件已变化" },
          { path: "D:\\files\\c.txt", size: 4, status: "failed", message: "回收失败" },
        ],
      },
      session: wireSession(),
    });

    const outcome = await api.confirmCleanup();

    expect(invoke).toHaveBeenLastCalledWith("confirm_cleanup", { target: null });
    expect(outcome.report).toMatchObject({ cancelled: true, remainingFiles: 1, movedCount: 0, skippedCount: 1, failedCount: 1 });
    expect(outcome.session.groups[0].files).toHaveLength(3);
  });
});
