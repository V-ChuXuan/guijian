import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import App from "./App";
import type {
  CleanupOutcome,
  CleanupProgress,
  CleanupReport,
  DesktopApi,
  DuplicateGroup,
  ScanProgress,
  ScanSession,
} from "./api/desktopApi";

const scanResult: ScanSession = {
  root: "D:\\资料库",
  scannedFiles: 128,
  scannedBytes: 4_800_000_000,
  issues: [],
  groups: [
    {
      id: "group-report",
      digest: "a".repeat(64),
      sizeBytes: 48_200_000,
      reclaimableBytes: 48_200_000,
      recommendationReason: "默认保留完整路径最短的文件",
      files: [
        {
          path: "D:\\资料库\\工作\\年度报告.pdf",
          name: "年度报告.pdf",
          sizeBytes: 48_200_000,
          modifiedAt: "2024-03-12T08:00:00Z",
          cleanup: false,
          recommendedKeeper: true,
        },
        {
          path: "D:\\资料库\\下载\\年度报告 - 副本.pdf",
          name: "年度报告 - 副本.pdf",
          sizeBytes: 48_200_000,
          modifiedAt: "2025-01-08T08:00:00Z",
          cleanup: true,
          recommendedKeeper: false,
        },
      ],
    },
  ],
};

const cleanupReport: CleanupReport = {
  cancelled: false,
  remainingFiles: 0,
  reclaimableBytes: 48_200_000,
  movedCount: 1,
  skippedCount: 0,
  failedCount: 0,
  items: [
    {
      path: "D:\\资料库\\下载\\年度报告 - 副本.pdf",
      status: "moved_to_trash",
      message: "已移至回收站",
    },
  ],
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function createApi(overrides: Partial<DesktopApi> = {}) {
  let progressListener: ((progress: ScanProgress) => void) | undefined;
  let cleanupProgressListener: ((progress: CleanupProgress) => void) | undefined;
  let closeBlockedListener: (() => void) | undefined;
  const api: DesktopApi = {
    selectScanRoot: vi.fn().mockResolvedValue({
      path: "D:\\资料库",
      name: "资料库",
    }),
    startScan: vi.fn().mockResolvedValue(scanResult),
    cancelScan: vi.fn().mockResolvedValue(true),
    cancelCleanup: vi.fn().mockResolvedValue(true),
    subscribeCloseBlocked: vi.fn(async (listener) => {
      closeBlockedListener = listener;
      return () => undefined;
    }),
    subscribeCleanupProgress: vi.fn(async (listener) => {
      cleanupProgressListener = listener;
      return () => undefined;
    }),
    subscribeScanProgress: vi.fn(async (listener) => {
      progressListener = listener;
      return () => undefined;
    }),
    updateSelection: vi.fn(async (groupId, path, cleanup) => ({
      ...scanResult.groups.find((group) => group.id === groupId)!,
      files: scanResult.groups[0].files.map((file) =>
        file.path === path ? { ...file, cleanup } : file,
      ),
    })),
    keepGroup: vi.fn(async (groupId) => ({
      ...scanResult.groups.find((group) => group.id === groupId)!,
      reclaimableBytes: 0,
      files: scanResult.groups[0].files.map((file) => ({ ...file, cleanup: false })),
    })),
    restoreRecommendedSelections: vi.fn().mockResolvedValue(scanResult),
    confirmCleanup: vi.fn().mockResolvedValue({ report: cleanupReport, session: { ...scanResult, groups: [] } }),
    copyPath: vi.fn().mockResolvedValue(undefined),
    revealFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return {
    api,
    emitCloseBlocked() {
      closeBlockedListener?.();
    },
    emitProgress(progress: ScanProgress) {
      progressListener?.(progress);
    },
    emitCleanupProgress(progress: CleanupProgress) {
      cleanupProgressListener?.(progress);
    },
  };
}

describe("归简", () => {
  it.each([false, true])("长路径审阅与单文件确认预告限制，保持原选择且交由后端复核，原回收选择：%s", async (cleanup) => {
    const user = userEvent.setup();
    const root = "D:\\资料库\\";
    const path = `${root}${"a".repeat(260 - root.length - 11)}\\report.txt`;
    expect(path.length).toBe(260);
    const initial: ScanSession = { ...scanResult, groups: [{
      ...scanResult.groups[0],
      files: [
        { ...scanResult.groups[0].files[0], name: "report.txt", path: `${root}report.txt`, cleanup: !cleanup },
        { ...scanResult.groups[0].files[1], name: "report.txt", path, cleanup },
      ],
    }] };
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue(initial),
      confirmCleanup: vi.fn().mockResolvedValue({
        report: { ...cleanupReport, movedCount: 0, failedCount: 1, items: [{ path, status: "failed", message: "后端拒绝长路径" }] },
        session: initial,
      }),
    });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    const checkboxes = await screen.findAllByRole("checkbox", { name: "移至回收站 report.txt" });
    const target = screen.getAllByRole("button", { name: "仅回收此文件：report.txt" })[1];
    const warning = "路径过长，当前版本无法回收；请缩短路径后重新扫描。";
    expect(checkboxes[0]).not.toHaveAccessibleDescription(/当前版本无法回收/);
    expect(checkboxes[1]).toHaveAccessibleDescription(expect.stringContaining(warning));
    expect(target).toHaveAccessibleDescription(expect.stringContaining(warning));
    expect(checkboxes[1].closest("article")).toHaveTextContent(warning);

    await user.click(target);
    let dialog = screen.getByRole("dialog", { name: "仅回收此文件" });
    expect(within(dialog).getByText(warning)).toBeVisible();
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining(warning));
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "移至回收站" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(target).toHaveFocus());
    expect(checkboxes[1]).toHaveProperty("checked", cleanup);

    await user.click(target);
    dialog = screen.getByRole("dialog", { name: "仅回收此文件" });
    await user.click(within(dialog).getByRole("button", { name: "移至回收站" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("后端拒绝长路径");
    expect(within(dialog).getByText(warning)).toBeVisible();
    expect(api.confirmCleanup).toHaveBeenCalledExactlyOnceWith({ groupId: initial.groups[0].id, path });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(checkboxes[1]).toHaveProperty("checked", cleanup);
    expect(api.updateSelection).not.toHaveBeenCalled();
    expect(api.startScan).toHaveBeenCalledOnce();
  });

  it("跨组页修改选择后返回仍保留，清理确认包含所有隐藏页的选择", async () => {
    const user = userEvent.setup();
    const initial: ScanSession = {
      ...scanResult,
      groups: Array.from({ length: 51 }, (_, groupIndex) => ({
        ...scanResult.groups[0], id: `batch-${groupIndex}`,
        files: scanResult.groups[0].files.map((file, fileIndex) => ({
          ...file, name: `batch-${groupIndex}-${fileIndex}.txt`,
          path: `D:\\资料库\\batch-${groupIndex}-${fileIndex}.txt`,
        })),
      })),
    };
    let currentGroups = initial.groups;
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue(initial),
      updateSelection: vi.fn(async (groupId, path, cleanup) => {
        const updated = currentGroups.find((group) => group.id === groupId)!;
        const next = { ...updated, reclaimableBytes: cleanup ? updated.sizeBytes : 0,
          files: updated.files.map((file) => file.path === path ? { ...file, cleanup } : file) };
        currentGroups = currentGroups.map((group) => group.id === groupId ? next : group);
        return next;
      }),
    });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("checkbox", { name: "移至回收站 batch-0-1.txt" }));
    await user.click(screen.getByRole("button", { name: "重复组：最后一页" }));
    await user.click(screen.getByRole("button", { name: /batch-50-0.txt/ }));
    await user.click(screen.getByRole("checkbox", { name: "移至回收站 batch-50-1.txt" }));
    await user.click(screen.getByRole("button", { name: "重复组：第一页" }));
    expect(screen.getByRole("checkbox", { name: "移至回收站 batch-0-1.txt" })).not.toBeChecked();
    expect(screen.getByText("49 个文件")).toBeVisible();
    await user.type(screen.getByRole("searchbox"), "batch-50");
    expect(screen.getByRole("checkbox", { name: "移至回收站 batch-50-1.txt" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "检查清理内容" }));
    expect(screen.getByRole("heading", { name: "准备移动 49 个副本" })).toBeVisible();
    expect(api.updateSelection).toHaveBeenCalledTimes(2);
    expect(api.startScan).toHaveBeenCalledOnce();
    expect(api.confirmCleanup).not.toHaveBeenCalled();
  });

  it("从简洁的目录选择开始，并保留四阶段导航", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);

    expect(
      screen.getByRole("heading", { name: "选择文件夹" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("归简")).not.toBeInTheDocument();
    expect(document.querySelector(".window-mark")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "清理步骤" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(
      screen.queryByRole("button", { name: "开始分析" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/只在本机读取文件/)).not.toBeInTheDocument();
    expect(screen.queryByText("审阅范围")).not.toBeInTheDocument();
    expect(screen.queryByText("递归检查")).not.toBeInTheDocument();
    expect(screen.queryByText("本地会话")).not.toBeInTheDocument();
    expect(screen.queryByText("空间审阅台")).not.toBeInTheDocument();
    expect(screen.queryByText(/拖放|智能算法|完全一致|本地处理/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));

    expect(screen.getByRole("heading", { name: "资料库" })).toBeInTheDocument();
    expect(screen.getByText("D:\\资料库")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更换位置" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "开始分析" })).toBeEnabled();
  });

  it("Ctrl+O 仅在目录选择阶段且未打开选择器时生效", async () => {
    const user = userEvent.setup();
    const selection = deferred<{ path: string; name: string } | null>();
    const { api } = createApi({
      selectScanRoot: vi.fn().mockReturnValue(selection.promise),
    });
    render(<App api={api} />);

    await user.keyboard("{Control>}o{/Control}");
    await user.keyboard("{Control>}o{/Control}");

    expect(api.selectScanRoot).toHaveBeenCalledOnce();
    await act(async () => {
      selection.resolve({ path: "D:\\资料库", name: "资料库" });
    });
    expect(await screen.findByText("D:\\资料库")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    await user.keyboard("{Control>}o{/Control}");

    expect(api.selectScanRoot).toHaveBeenCalledOnce();
  });

  it("审阅阶段用紧凑命令栏替代步骤条，并可返回目录选择", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });

    expect(
      screen.queryByRole("navigation", { name: "清理步骤" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "更换文件夹" }));
    expect(screen.getByRole("heading", { name: "选择文件夹" })).toBeInTheDocument();
  });

  it("展示结构化桌面错误的消息", async () => {
    const user = userEvent.setup();
    const { api } = createApi({
      selectScanRoot: vi.fn().mockRejectedValue({
        code: "busy",
        message: "另一个操作正在进行",
      }),
    });
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("另一个操作正在进行");
  });

  it("展示扫描阶段、实时进度，并进入重复组审阅", async () => {
    const user = userEvent.setup();
    const { api, emitProgress } = createApi();
    let resolveScan: (value: ScanSession) => void = () => undefined;
    vi.mocked(api.startScan).mockReturnValue(
      new Promise((resolve) => {
        resolveScan = resolve;
      }),
    );
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));

    expect(
      screen.getByRole("heading", { name: "正在分析空间" }),
    ).toBeInTheDocument();
    emitProgress({
      stage: "partial_hash",
      completed: 64,
      total: 128,
      scannedFiles: 128,
      scannedBytes: 2_400_000_000,
      currentPath: "D:\\资料库\\工作",
    });
    expect(await screen.findByText("2.40 GB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "当前阶段进度 50%" })).toBeInTheDocument();
    expect(screen.queryByText("重复组")).not.toBeInTheDocument();
    expect(screen.queryByText("筛选候选")).not.toBeInTheDocument();

    resolveScan(scanResult);

    expect(
      await screen.findByRole("heading", { name: "检查重复文件" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { expanded: true })).toHaveTextContent(
      "年度报告.pdf",
    );
    expect(screen.getAllByText("48.20 MB").length).toBeGreaterThan(0);
    expect(document.querySelector(".count-badge")).not.toBeInTheDocument();
    expect(screen.queryByText(/将把 .* 个文件移至回收站/)).not.toBeInTheDocument();
  });

  it("等待后台扫描停止后才允许重新分析", async () => {
    const user = userEvent.setup();
    const firstScan = deferred<ScanSession>();
    const { api } = createApi();
    vi.mocked(api.startScan)
      .mockReturnValueOnce(firstScan.promise)
      .mockResolvedValueOnce(scanResult);
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(screen.getByRole("button", { name: "停止扫描" }));

    expect(api.cancelScan).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "正在停止分析" })).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "重新分析" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      firstScan.resolve(scanResult);
    });

    expect(
      await screen.findByRole("heading", { name: "分析已停止" }),
    ).toHaveFocus();
    expect(screen.getByText("分析已停止")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新分析" }));

    expect(api.startScan).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole("heading", { name: "检查重复文件" }),
    ).toBeInTheDocument();
  });

  it("停止扫描请求失败仍等待原扫描，不开放重试或返回", async () => {
    const user = userEvent.setup();
    const scan = deferred<ScanSession>();
    const { api } = createApi({
      startScan: vi.fn().mockReturnValue(scan.promise),
      cancelScan: vi.fn().mockRejectedValue(new Error("扫描停止请求暂不可用")),
    });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(screen.getByRole("button", { name: "停止扫描" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("扫描停止请求暂不可用");
    expect(screen.getByRole("heading", { name: "正在分析空间" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止扫描" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "重新分析" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回选择位置" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 选择位置" })).toBeDisabled();
    await act(async () => { scan.resolve(scanResult); });
    expect(await screen.findByRole("heading", { name: "检查重复文件" })).toBeInTheDocument();
    expect(api.startScan).toHaveBeenCalledOnce();
    expect(api.cancelScan).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("扫描进度订阅失败明确提示不可用，仍等待真实扫描结果", async () => {
    const user = userEvent.setup();
    const scan = deferred<ScanSession>();
    const { api } = createApi({
      startScan: vi.fn().mockReturnValue(scan.promise),
      subscribeScanProgress: vi.fn().mockRejectedValue(new Error("事件订阅被拒绝")),
    });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));

    expect(await screen.findByRole("status")).toHaveTextContent("扫描进度暂不可用：事件订阅被拒绝");
    expect(screen.getByRole("heading", { name: "正在分析空间" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止扫描" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "重新分析" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { scan.resolve(scanResult); });
    expect(await screen.findByRole("heading", { name: "检查重复文件" })).toBeInTheDocument();
    expect(api.startScan).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("停止扫描未被接受时说明仍在等待，不开放重复扫描", async () => {
    const user = userEvent.setup();
    const scan = deferred<ScanSession>();
    const { api } = createApi({
      startScan: vi.fn().mockReturnValue(scan.promise),
      cancelScan: vi.fn().mockResolvedValue(false),
    });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(screen.getByRole("button", { name: "停止扫描" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("停止请求未被接受，扫描仍在进行");
    expect(screen.queryByRole("button", { name: "重新分析" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止扫描" })).toBeEnabled();
    await act(async () => { scan.resolve(scanResult); });
    expect(await screen.findByRole("heading", { name: "检查重复文件" })).toBeInTheDocument();
    expect(api.startScan).toHaveBeenCalledOnce();
  });

  it("以单列原地展开审阅重复组，并且只保留一个内容滚动区", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });

    expect(screen.getByRole("banner", { name: "审阅命令栏" })).toHaveTextContent(
      "D:\\资料库",
    );
    expect(document.querySelector(".review-brand")).not.toBeInTheDocument();
    expect(screen.queryByText("归简")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新扫描" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "更换文件夹" })).toBeEnabled();
    const reviewHeading = screen.getByRole("heading", { name: "检查重复文件" });
    expect(reviewHeading).toHaveFocus();
    expect(reviewHeading).toHaveClass("visually-hidden");
    expect(reviewHeading).toHaveAttribute("id", "page-title");
    expect(reviewHeading).toHaveAttribute("tabindex", "-1");
    const resultAnchor = screen.getByRole("group", {
      name: "重复文件，1 组",
    });
    expect(resultAnchor).toBeVisible();
    expect(resultAnchor).toHaveClass("review-result-anchor");
    expect(resultAnchor).toHaveTextContent("重复文件1 组");
    expect(resultAnchor?.querySelector(".review-result-anchor__label")).toHaveTextContent(
      "重复文件",
    );
    expect(resultAnchor?.querySelector(".review-result-anchor__count")).toHaveTextContent(
      "1 组",
    );
    expect(resultAnchor).not.toHaveTextContent("完全重复");
    expect(screen.getByRole("searchbox", { name: "搜索文件名或路径" })).toBeInTheDocument();
    expect(screen.queryByText("1 组内容相同的文件")).not.toBeInTheDocument();
    expect(screen.getByText("文件", { selector: ".review-list__head span" })).toBeInTheDocument();
    expect(screen.queryByText("重复文件组")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { expanded: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(document.querySelector(".review-list")).toBeInTheDocument();
    expect(document.querySelector(".group-queue")).not.toBeInTheDocument();
    expect(document.querySelector(".decision-panel")).not.toBeInTheDocument();
    expect(document.querySelector(".capacity-summary")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".review-stage [data-scroll-region='content']")).toHaveLength(1);
    expect(
      screen.getByText("工作\\年度报告.pdf", { selector: ".file-copy small" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("下载\\年度报告 - 副本.pdf", {
        selector: ".file-copy small",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("保留", { selector: ".review-file-row__state" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/路径最短/, { selector: ".review-file-row__state" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("移至回收站", {
        selector: ".review-file-row__state",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { expanded: true }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("多组结果支持全部展开和全部收起，并保留单组独立切换", async () => {
    const user = userEvent.setup();
    const groups = Array.from({ length: 8 }, (_, index): DuplicateGroup => ({
      ...scanResult.groups[0],
      id: `group-${index + 1}`,
      digest: String(index + 1).repeat(64).slice(0, 64),
      files: scanResult.groups[0].files.map((file, fileIndex) => ({
        ...file,
        name: `副本组 ${index + 1}-${fileIndex + 1}.pdf`,
        path: `D:\\资料库\\组${index + 1}\\副本 ${fileIndex + 1}.pdf`,
      })),
    }));
    const multiGroupResult: ScanSession = { ...scanResult, groups };
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue(multiGroupResult),
    });
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });

    expect(screen.getByRole("button", { name: "全部展开" })).toBeEnabled();
    expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(1);
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(7);

    await user.click(screen.getByRole("button", { name: "全部展开" }));
    expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(8);
    expect(screen.getByRole("button", { name: "全部收起" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "全部收起" }));
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(8);
    expect(screen.getByRole("button", { name: "全部展开" })).toBeEnabled();

    await user.click(screen.getAllByRole("button", { expanded: false })[0]);
    expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(1);
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(7);
    expect(screen.getByRole("button", { name: "全部展开" })).toBeEnabled();
  });

  it("规范化审阅根路径，同时保留完整路径提示", async () => {
    const user = userEvent.setup();
    const root = "D:/资料库//";
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue({ ...scanResult, root }),
    });
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });

    const rootPath = document.querySelector<HTMLElement>(".review-root-path")!;
    expect(rootPath).toHaveTextContent("D:\\资料库");
    expect(rootPath).toHaveAttribute("title", "D:\\资料库");
    expect(rootPath).toHaveAttribute("aria-label", "扫描位置 D:\\资料库");
  });

  it("始终阻止回收重复组中的最后一份文件", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });

    const originalRow = screen
      .getByText("年度报告.pdf", { selector: ".file-copy p" })
      .closest("article")!;
    expect(
      within(originalRow).getByRole("checkbox", {
        name: "移至回收站 年度报告.pdf",
      }),
    ).toBeDisabled();
    expect(
      within(originalRow).getByRole("checkbox", {
        name: "移至回收站 年度报告.pdf",
      }),
    ).toHaveAccessibleDescription(/每组必须保留至少一份/);

    const copyRow = screen
      .getByText("年度报告 - 副本.pdf", { selector: ".file-copy p" })
      .closest("article")!;
    await user.click(
      within(copyRow).getByRole("checkbox", {
        name: "移至回收站 年度报告 - 副本.pdf",
      }),
    );

    expect(
      within(originalRow).getByRole("checkbox", {
        name: "移至回收站 年度报告.pdf",
      }),
    ).toBeEnabled();
  });

  it("选择更新未完成时禁用所有冲突操作", async () => {
    const user = userEvent.setup();
    const update = deferred<DuplicateGroup>();
    const { api } = createApi({
      updateSelection: vi.fn().mockReturnValue(update.promise),
    });
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });

    const pendingCheckbox = screen.getByRole("checkbox", {
      name: "移至回收站 年度报告 - 副本.pdf",
    });
    await user.click(pendingCheckbox);

    expect(pendingCheckbox).toBeChecked();
    expect(api.updateSelection).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "全部保留" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复建议" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "检查清理内容" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新扫描" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "更换文件夹" })).toBeDisabled();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeDisabled();
    }

    await act(async () => {
      update.resolve({
        ...scanResult.groups[0],
        reclaimableBytes: 0,
        files: scanResult.groups[0].files.map((file) => ({
          ...file,
          cleanup: false,
        })),
      });
    });

    expect(screen.getByRole("button", { name: "全部保留" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复建议" })).toBeEnabled();
    expect(screen.getByText("0 个文件")).toBeInTheDocument();
    expect(screen.getAllByText("0 B").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("checkbox", { name: "移至回收站 年度报告.pdf" }),
    ).toBeEnabled();
  });

  it("内容相同的多个路径默认保留最短路径并标记其余副本", async () => {
    const user = userEvent.setup();
    const hardlinkResult: ScanSession = {
      ...scanResult,
      groups: [
        {
          ...scanResult.groups[0],
          reclaimableBytes: 0,
          files: [
            {
              ...scanResult.groups[0].files[0],
              path: "D:\\资料库\\工商注册流程ai化.docx",
              name: "工商注册流程ai化.docx",
            },
            {
              ...scanResult.groups[0].files[1],
              path: "D:\\资料库\\工商注册流程ai化(1).docx",
              name: "工商注册流程ai化(1).docx",
              cleanup: true,
            },
            {
              ...scanResult.groups[0].files[1],
              path: "D:\\资料库\\工商注册流程ai化(1)(1).docx",
              name: "工商注册流程ai化(1)(1).docx",
              cleanup: true,
            },
          ],
        },
      ],
    };
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue(hardlinkResult),
    });
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });

    expect(screen.queryByText("硬链接")).not.toBeInTheDocument();
    expect(screen.getByText("2 个文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /回收 2 份/ })).toBeInTheDocument();
    expect(screen.getAllByText("0 B").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("checkbox", {
        name: "移至回收站 工商注册流程ai化(1).docx",
      }),
    ).toBeChecked();
  });

  it("审阅页只有单列内容台账滚动", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });

    const viewport = document.querySelector<HTMLElement>(".stage-viewport")!;
    const reviewList = document.querySelector<HTMLElement>(".review-list")!;

    expect(viewport).toHaveClass("stage-viewport--review");
    expect(reviewList).toHaveAttribute("data-scroll-region", "content");
    expect(document.querySelectorAll("[data-scroll-region='content']")).toHaveLength(1);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("确认后恢复所有重复组的默认建议", async () => {
    const user = userEvent.setup();
    const changedResult: ScanSession = {
      ...scanResult,
      groups: [
        {
          ...scanResult.groups[0],
          reclaimableBytes: 0,
          files: scanResult.groups[0].files.map((file) => ({
            ...file,
            cleanup: false,
          })),
        },
      ],
    };
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue(changedResult),
    });
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    await user.click(screen.getByRole("button", { name: "恢复建议" }));
    await user.click(screen.getByRole("button", { name: "确认恢复全部建议" }));

    expect(api.restoreRecommendedSelections).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("checkbox", { name: "移至回收站 年度报告 - 副本.pdf" }),
    ).toBeChecked();
  });

  it("保留完整路径用于提示、复制和资源管理器操作", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    const originalRow = screen
      .getByText("年度报告.pdf", { selector: ".file-copy p" })
      .closest("article")!;
    const fileCopy = originalRow.querySelector<HTMLElement>(".file-copy")!;
    expect(fileCopy).toHaveAttribute(
      "title",
      "D:\\资料库\\工作\\年度报告.pdf",
    );
    const menuButton = within(originalRow).getByLabelText("更多操作 年度报告.pdf");
    const menu = menuButton.closest("details")!;
    await user.click(menuButton);
    expect(menu).toHaveAttribute("open");
    await user.click(
      within(originalRow).getByRole("button", { name: "在资源管理器中显示" }),
    );

    expect(api.revealFile).toHaveBeenCalledWith("D:\\资料库\\工作\\年度报告.pdf");
    expect(menu).not.toHaveAttribute("open");

    await user.click(menuButton);
    await user.click(
      within(originalRow).getByRole("button", { name: "复制完整路径" }),
    );
    expect(api.copyPath).toHaveBeenCalledWith("D:\\资料库\\工作\\年度报告.pdf");
    expect(menu).not.toHaveAttribute("open");
  });

  it("行尾菜单支持 Escape 和点外关闭，并把焦点交还触发按钮", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });

    const menuButton = screen.getByLabelText("更多操作 年度报告.pdf");
    const menu = menuButton.closest("details")!;
    await user.click(menuButton);
    expect(menu).toHaveAttribute("open");

    await user.keyboard("{Escape}");
    expect(menu).not.toHaveAttribute("open");
    expect(menuButton).toHaveFocus();

    await user.click(menuButton);
    await user.click(screen.getByRole("heading", { name: "检查重复文件" }));
    expect(menu).not.toHaveAttribute("open");
  });

  it.each(["在资源管理器中显示", "复制完整路径"])("键盘执行%s后回到当前文件的菜单触发器", async (action) => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });

    const trigger = screen.getByLabelText("更多操作 年度报告.pdf");
    const menu = trigger.closest("details")!;
    await user.click(trigger);
    expect(menu).toHaveAttribute("open");
    within(menu).getByRole("button", { name: action }).focus();
    await user.keyboard("{Enter}");

    expect(menu).not.toHaveAttribute("open");
    expect(trigger).toHaveFocus();
    expect(action === "复制完整路径" ? api.copyPath : api.revealFile)
      .toHaveBeenCalledExactlyOnceWith("D:\\资料库\\工作\\年度报告.pdf");
  });

  it("单文件回收按钮先打开确认弹窗，取消后恢复焦点且不触碰权威选择", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    const target = screen.getByRole("button", {
      name: "仅回收此文件：年度报告.pdf",
    });
    expect(target).toBeVisible();
    expect(target).toHaveAttribute("title", "仅回收此文件：年度报告.pdf");
    const selectedDuplicate = screen.getByRole("checkbox", {
      name: "移至回收站 年度报告 - 副本.pdf",
    });
    expect(selectedDuplicate).toBeChecked();

    await user.click(target);

    const dialog = screen.getByRole("dialog", { name: "仅回收此文件" });
    expect(within(dialog).getByText("年度报告.pdf")).toBeInTheDocument();
    expect(within(dialog).getByText("工作\\年度报告.pdf")).toBeInTheDocument();
    expect(api.confirmCleanup).not.toHaveBeenCalled();

    const cancel = within(dialog).getByRole("button", { name: "取消" });
    const confirm = within(dialog).getByRole("button", { name: "移至回收站" });
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "仅回收此文件" })).not.toBeInTheDocument();
    expect(target).toHaveFocus();
    expect(selectedDuplicate).toBeChecked();
    expect(api.confirmCleanup).not.toHaveBeenCalled();
  });

  it("单文件回收使用同一入口与返回会话，不重扫且执行期间禁止关闭与重复提交", async () => {
    const user = userEvent.setup();
    const pending = deferred<CleanupOutcome>();
    const { api } = createApi({ confirmCleanup: vi.fn().mockReturnValue(pending.promise) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    await user.click(screen.getByRole("button", { name: "仅回收此文件：年度报告.pdf" }));
    const dialog = screen.getByRole("dialog", { name: "仅回收此文件" });
    const confirm = within(dialog).getByRole("button", { name: "移至回收站" });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    await user.click(confirm);
    expect(api.confirmCleanup).toHaveBeenCalledExactlyOnceWith({
      groupId: "group-report", path: scanResult.groups[0].files[0].path,
    });
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();
    await user.click(confirm);
    await user.keyboard("{Escape}");
    expect(api.confirmCleanup).toHaveBeenCalledOnce();
    expect(dialog).toBeInTheDocument();
    await act(async () => {
      pending.resolve({ report: cleanupReport, session: { ...scanResult, groups: [] } });
    });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(api.startScan).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("heading", { name: "未发现重复文件" })).toHaveFocus());
  });

  it.each([
    new Error("返回通道中断"),
    { code: "internal", message: "返回通道中断" },
    "返回通道中断",
    { code: "unexpected", message: "返回通道中断" },
  ])("单文件异常保留未知结果和实际错误，禁止原地重试并恢复键盘焦点：%j", async (error) => {
    const user = userEvent.setup();
    const pending = deferred<CleanupOutcome>();
    const { api } = createApi({ confirmCleanup: vi.fn().mockReturnValue(pending.promise) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    const target = await screen.findByRole("button", { name: "仅回收此文件：年度报告.pdf" });
    await user.click(target);
    await user.tab();
    const confirm = screen.getByRole("button", { name: "移至回收站" });
    expect(confirm).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(confirm).toBeDisabled();
    await user.keyboard("{Enter}{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(api.confirmCleanup).toHaveBeenCalledOnce();
    await act(async () => pending.reject(error));

    const dialog = await screen.findByRole("dialog", { name: "未能确认清理结果" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("返回通道中断");
    expect(within(dialog).getByText(/请先检查文件状态/)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /移至回收站/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/未开始|没有开始|自动重试/)).not.toBeInTheDocument();
    const back = within(dialog).getByRole("button", { name: "返回检查" });
    expect(back).toHaveFocus();
    await user.tab();
    expect(back).toHaveFocus();
    await user.tab({ shift: true });
    expect(back).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(target).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.confirmCleanup).toHaveBeenCalledOnce();
    expect(api.startScan).toHaveBeenCalledOnce();
    expect(screen.getByRole("checkbox", { name: "移至回收站 年度报告.pdf" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "移至回收站 年度报告 - 副本.pdf" })).toBeChecked();

    for (const name of ["年度报告.pdf", "年度报告 - 副本.pdf"]) {
      await user.click(screen.getByRole("button", { name: `仅回收此文件：${name}` }));
      const reopened = screen.getByRole("dialog", { name: "仅回收此文件" });
      expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(reopened).getByRole("button", { name: "移至回收站" })).toBeEnabled();
      await user.keyboard("{Escape}");
    }
    expect(api.confirmCleanup).toHaveBeenCalledOnce();
  });

  it.each(["invalid_path", "busy", "unknown_group", "invalid_selection", "no_scan_result"])("单文件明确前置拒绝保留原错误和人工选择：%s", async (code) => {
    const user = userEvent.setup();
    const { api } = createApi({ confirmCleanup: vi.fn().mockRejectedValue({
      code, message: "文件已不在当前重复组中",
    }) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    const target = screen.getByRole("button", { name: "仅回收此文件：年度报告.pdf" });
    await user.click(target);
    const dialog = screen.getByRole("dialog", { name: "仅回收此文件" });
    await user.click(within(dialog).getByRole("button", { name: "移至回收站" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("文件已不在当前重复组中");
    expect(within(dialog).queryByText("未能确认清理结果")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "移至回收站" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(target).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: "移至回收站 年度报告.pdf" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "移至回收站 年度报告 - 副本.pdf" })).toBeChecked();
    expect(api.startScan).toHaveBeenCalledOnce();
  });

  it.each([false, true])("单文件处理后采用后端会话并保留其他组的人工选择，执行失败：%s", async (failed) => {
    const user = userEvent.setup();
    const unrelated: DuplicateGroup = {
      ...scanResult.groups[0], id: "unrelated", digest: "b".repeat(64), reclaimableBytes: 0,
      files: scanResult.groups[0].files.map((file, index) => ({
        ...file, path: `D:\\资料库\\保留\\${index}.txt`, name: `${index}.txt`, cleanup: false,
      })),
    };
    const initial = { ...scanResult, groups: [...scanResult.groups, unrelated] };
    const refreshed = {
      ...initial, issues: [{ path: "D:\\资料库\\新问题", message: "文件已变化" }],
      groups: failed ? initial.groups : [unrelated],
    };
    const report: CleanupReport = failed ? {
      cancelled: false, remainingFiles: 0, reclaimableBytes: 0, movedCount: 0, skippedCount: 0, failedCount: 1,
      items: [{ path: scanResult.groups[0].files[0].path, status: "failed", message: "系统回收站暂时不可用" }],
    } : cleanupReport;
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue(initial),
      confirmCleanup: vi.fn().mockResolvedValue({ report, session: refreshed }),
    });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    await user.click(screen.getByRole("button", { name: "仅回收此文件：年度报告.pdf" }));
    const dialog = screen.getByRole("dialog", { name: "仅回收此文件" });
    await user.click(within(dialog).getByRole("button", { name: "移至回收站" }));
    if (failed) {
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("系统回收站暂时不可用");
      expect(within(dialog).queryByText("未能确认清理结果")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "移至回收站" })).toBeEnabled();
      await user.click(within(dialog).getByRole("button", { name: "取消" }));
    } else {
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
    }
    expect(api.startScan).toHaveBeenCalledOnce();
    expect(await screen.findByText("有 1 项未完成检查")).toBeInTheDocument();
    const expand = screen.queryByRole("button", { name: "全部展开" });
    if (expand) await user.click(expand);
    expect(screen.getByRole("checkbox", { name: "移至回收站 0.txt" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "移至回收站 1.txt" })).not.toBeChecked();
  });

  it("经过独立确认页后执行清理并展示空间收据", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    await user.click(screen.getByRole("button", { name: "检查清理内容" }));

    expect(
      screen.getByRole("heading", { name: "确认清理" }),
    ).toBeInTheDocument();
    expect(screen.getByText("文件将移至回收站。")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "确认移至回收站" }),
    );

    expect(
      await screen.findByRole("heading", { name: "清理完成" }),
    ).toBeInTheDocument();
    expect(screen.getByText("48.20 MB")).toBeInTheDocument();
    expect(screen.getByText("已移入回收站 1 个")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查其他文件夹" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "重新扫描当前文件夹" }));
    expect(api.startScan).toHaveBeenCalledTimes(2);
    expect(api.startScan).toHaveBeenLastCalledWith("D:\\资料库");
  });

  it.each([false, true])("展示未完成检查的详情，空结果：%s", async (empty) => {
    const user = userEvent.setup();
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue({
        ...scanResult,
        groups: empty ? [] : scanResult.groups,
        issues: [{ path: "D:\\资料库\\私人目录", message: "拒绝访问" }],
      }),
    });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));

    const summary = await screen.findByText("有 1 项未完成检查");
    await user.click(summary);
    expect(screen.getByText("D:\\资料库\\私人目录")).toBeVisible();
    expect(screen.getByText("拒绝访问")).toBeVisible();
    if (empty) {
      expect(screen.getByRole("heading", { name: "已检查范围内未发现重复文件" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "未发现重复文件" })).not.toBeInTheDocument();
    }
  });

  it("把无重复项作为正常扫描结果展示", async () => {
    const user = userEvent.setup();
    const emptyResult: ScanSession = {
      ...scanResult,
      groups: [],
    };
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue(emptyResult),
    });
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));

    expect(
      await screen.findByText("未发现重复文件"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("整组保留只调用一次原子接口", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "全部保留" }));
    expect(api.keepGroup).toHaveBeenCalledExactlyOnceWith("group-report");
    expect(api.updateSelection).not.toHaveBeenCalled();
    expect(screen.getByText("0 个文件")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "仅看待清理" }));
    expect(screen.queryByRole("button", { name: /年度报告.pdf.*全部保留/ })).not.toBeInTheDocument();
    expect(screen.getByText(/没有符合筛选的重复组/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "仅看待清理" }));
    expect(screen.getByRole("button", { name: /年度报告.pdf.*全部保留/ })).toBeVisible();
  });

  it("同名文件的选择和操作带有各自的路径描述", async () => {
    const user = userEvent.setup();
    const { api } = createApi({ startScan: vi.fn().mockResolvedValue({ ...scanResult, groups: [{
      ...scanResult.groups[0], files: scanResult.groups[0].files.map((file, index) => ({ ...file, path: `D:\\资料库\\目录${index}\\报告.pdf`, name: "报告.pdf" })),
    }] }) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    const checkboxes = await screen.findAllByRole("checkbox", { name: "移至回收站 报告.pdf" });
    expect(checkboxes[0]).toHaveAccessibleDescription(/目录0\\报告.pdf/);
    expect(checkboxes[1]).toHaveAccessibleDescription("目录1\\报告.pdf");
    const trashButtons = screen.getAllByRole("button", { name: "仅回收此文件：报告.pdf" });
    expect(trashButtons[0]).toHaveAccessibleDescription("目录0\\报告.pdf");
    expect(trashButtons[1]).toHaveAccessibleDescription("目录1\\报告.pdf");
    const menuButtons = screen.getAllByText("•••").map((element) => element.closest("summary"));
    expect(menuButtons[0]).toHaveAccessibleDescription("目录0\\报告.pdf");
    expect(menuButtons[1]).toHaveAccessibleDescription("目录1\\报告.pdf");
  });

  it("恢复全部建议先确认，取消保留人工决定", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "恢复建议" }));
    expect(api.restoreRecommendedSelections).not.toHaveBeenCalled();
    expect(screen.getByText(/覆盖所有人工选择/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "取消恢复" }));
    expect(api.restoreRecommendedSelections).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "恢复建议" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "恢复建议" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "恢复建议" })).toHaveFocus());
    expect(api.restoreRecommendedSelections).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "恢复建议" }));
    await user.click(screen.getByRole("button", { name: "确认恢复全部建议" }));
    expect(api.restoreRecommendedSelections).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button", { name: "恢复建议" })).toHaveFocus());
  });

  it("检索和待清理筛选只影响显示，确认仍包含全部选择", async () => {
    const user = userEvent.setup();
    const secondGroup: DuplicateGroup = {
      ...scanResult.groups[0], id: "second", files: scanResult.groups[0].files.map((file, index) => ({
        ...file, path: `D:\\资料库\\图片\\${index}.png`, name: `${index}.png`,
      })),
    };
    const { api } = createApi({ startScan: vi.fn().mockResolvedValue({ ...scanResult, groups: [...scanResult.groups, secondGroup] }) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    const search = await screen.findByRole("searchbox", { name: "搜索文件名或路径" });
    await user.type(search, "图片");
    expect(screen.queryByRole("button", { name: /年度报告.pdf.*回收/ })).not.toBeInTheDocument();
    expect(screen.getByText("2 个文件")).toBeInTheDocument();
    expect(screen.getByText(/清理包含所有已选文件/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "仅看待清理" }));
    expect(api.updateSelection).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "检查清理内容" }));
    expect(screen.getByRole("heading", { name: "准备移动 2 个副本" })).toBeInTheDocument();
  });

  it("部分失败默认展示未处理文件并返回原会话，不自动重扫或重试", async () => {
    const user = userEvent.setup();
    const failedPath = scanResult.groups[0].files[1].path;
    const { api } = createApi({ confirmCleanup: vi.fn().mockResolvedValue({
      report: { ...cleanupReport, failedCount: 1, items: [
        { path: "D:\\资料库\\已处理副本.txt", status: "moved_to_trash", message: "已移入回收站" },
        { path: failedPath, status: "failed", message: "文件正在使用中" },
      ] },
      session: scanResult,
    }) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "检查清理内容" }));
    await user.click(screen.getByRole("button", { name: "确认移至回收站" }));
    expect(await screen.findByRole("heading", { name: "部分文件未处理" })).toBeVisible();
    expect(screen.getByText(failedPath)).toBeVisible();
    expect(screen.getByText("文件正在使用中")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "复制完整路径" }));
    expect(api.copyPath).toHaveBeenCalledWith(failedPath);
    await user.click(screen.getByRole("button", { name: "在资源管理器中显示" }));
    expect(api.revealFile).toHaveBeenCalledWith(failedPath);
    vi.mocked(api.revealFile).mockRejectedValueOnce(new Error("文件已移动或不可访问"));
    await user.click(screen.getByRole("button", { name: "在资源管理器中显示" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("文件已移动或不可访问");
    await user.click(screen.getByRole("button", { name: "复制完整路径" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "检查未处理文件" }));
    expect(await screen.findByRole("heading", { name: "检查重复文件" })).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: "移至回收站 年度报告 - 副本.pdf" })).toBeChecked();
    expect(api.startScan).toHaveBeenCalledOnce();
    expect(api.confirmCleanup).toHaveBeenCalledOnce();
  });
});

describe("清理可控性与人工选择保护", () => {
  it("已有处理进度后请求异常只说明结果未确认，保留错误且不自动重试", async () => {
    const user = userEvent.setup();
    const pending = deferred<CleanupOutcome>();
    const { api, emitCleanupProgress } = createApi({ confirmCleanup: vi.fn().mockReturnValue(pending.promise) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "检查清理内容" }));
    await user.click(screen.getByRole("button", { name: "确认移至回收站" }));
    act(() => emitCleanupProgress({ completedFiles: 1, totalFiles: 2, currentPath: null, movedCount: 1, skippedCount: 0, failedCount: 0 }));
    await act(async () => pending.reject(new Error("清理结果返回失败")));

    expect(await screen.findByRole("heading", { name: "清理结果未确认" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "未能确认清理结果" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("清理结果返回失败");
    expect(screen.getByText("请先检查文件状态，再决定是否继续清理。")).toBeVisible();
    expect(screen.queryByText(/清理没有开始|清理未执行/)).not.toBeInTheDocument();
    expect(api.confirmCleanup).toHaveBeenCalledOnce();
  });

  it("最终确认直接给出完整长路径的可访问描述", async () => {
    const user = userEvent.setup();
    const relativePath = `${"很长的目录\\".repeat(24)}同名报告.pdf`;
    const { api } = createApi({ startScan: vi.fn().mockResolvedValue({ ...scanResult, groups: [{
      ...scanResult.groups[0], files: [scanResult.groups[0].files[0], { ...scanResult.groups[0].files[1], path: `D:\\资料库\\${relativePath}` }],
    }] }) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "仅回收此文件：年度报告 - 副本.pdf" }));
    const dialog = screen.getByRole("dialog", { name: "仅回收此文件" });
    expect(dialog).toHaveAccessibleDescription(relativePath);
    expect(within(dialog).getByText(relativePath)).not.toHaveAttribute("title");
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
  });

  it("批量清理显示真实进度，请求停止后等待报告再返回剩余会话", async () => {
    const user = userEvent.setup();
    const pending = deferred<CleanupOutcome>();
    const { api, emitCleanupProgress } = createApi({ confirmCleanup: vi.fn().mockReturnValue(pending.promise) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "检查清理内容" }));
    await user.click(screen.getByRole("button", { name: "确认移至回收站" }));
    act(() => emitCleanupProgress({ completedFiles: 1, totalFiles: 3, currentPath: "D:\\资料库\\当前视频.mp4", movedCount: 1, skippedCount: 0, failedCount: 0 }));
    expect(screen.getByText("已处理 1 / 3 个文件")).toBeVisible();
    expect(screen.getByText("D:\\资料库\\当前视频.mp4")).toBeVisible();
    const stop = screen.getByRole("button", { name: "完成当前文件后停止" });
    await user.click(stop);
    expect(api.cancelCleanup).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "正在等待当前文件完成…" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "清理已停止" })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ report: { ...cleanupReport, cancelled: true, remainingFiles: 2 }, session: scanResult }));
    expect(await screen.findByRole("heading", { name: "清理已停止" })).toBeVisible();
    expect(screen.getByText("还有 2 个文件未开始处理。")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "检查未处理文件" }));
    expect(await screen.findByRole("heading", { name: "检查重复文件" })).toHaveFocus();
    expect(api.startScan).toHaveBeenCalledOnce();
    expect(api.confirmCleanup).toHaveBeenCalledOnce();
  });

  it("关闭被拦截时提示先停止，清理状态保留并等待原报告", async () => {
    const user = userEvent.setup();
    const pending = deferred<CleanupOutcome>();
    const { api, emitCleanupProgress, emitCloseBlocked } = createApi({ confirmCleanup: vi.fn().mockReturnValue(pending.promise) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "检查清理内容" }));
    await user.click(screen.getByRole("button", { name: "确认移至回收站" }));
    act(() => emitCleanupProgress({ completedFiles: 1, totalFiles: 3, currentPath: "D:\\资料库\\当前视频.mp4", movedCount: 1, skippedCount: 0, failedCount: 0 }));
    act(() => emitCloseBlocked());
    expect(screen.getByText("操作进行中，请先停止后再关闭窗口")).toBeVisible();
    expect(screen.getByText("已处理 1 / 3 个文件")).toBeVisible();
    expect(screen.getByText("D:\\资料库\\当前视频.mp4")).toBeVisible();
    expect(screen.getByRole("button", { name: "完成当前文件后停止" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "清理完成" })).not.toBeInTheDocument();
    expect(api.cancelCleanup).not.toHaveBeenCalled();
    expect(api.startScan).toHaveBeenCalledOnce();
    expect(api.confirmCleanup).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ report: cleanupReport, session: { ...scanResult, groups: [] } }));
    expect(await screen.findByRole("heading", { name: "清理完成" })).toBeVisible();
    expect(screen.getByText("已移入回收站 1 个")).toBeVisible();
  });

  it("关闭提示订阅失败会显示原因而不产生未处理拒绝", async () => {
    const { api } = createApi({ subscribeCloseBlocked: vi.fn().mockRejectedValue(new Error("订阅被拒绝")) });
    render(<App api={api} />);
    expect(await screen.findByText("关闭提示暂不可用：订阅被拒绝")).toBeVisible();
    expect(screen.getByRole("button", { name: "选择文件夹" })).toBeEnabled();
  });

  it("停止请求失败只显示原因，清理仍等待原报告", async () => {
    const user = userEvent.setup();
    const pending = deferred<CleanupOutcome>();
    const { api } = createApi({ confirmCleanup: vi.fn().mockReturnValue(pending.promise), cancelCleanup: vi.fn().mockRejectedValue(new Error("停止请求未送达")) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "检查清理内容" }));
    await user.click(screen.getByRole("button", { name: "确认移至回收站" }));
    await user.click(screen.getByRole("button", { name: "完成当前文件后停止" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("停止请求未送达");
    expect(screen.queryByRole("button", { name: "确认移至回收站" })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ report: cleanupReport, session: { ...scanResult, groups: [] } }));
    expect(await screen.findByRole("heading", { name: "清理完成" })).toBeVisible();
  });

  it("进度订阅失败会在清理时说明，仍可等待真实报告", async () => {
    const user = userEvent.setup();
    const pending = deferred<CleanupOutcome>();
    const { api } = createApi({ subscribeCleanupProgress: vi.fn().mockRejectedValue(new Error("订阅失败")), confirmCleanup: vi.fn().mockReturnValue(pending.promise) });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "检查清理内容" }));
    await user.click(screen.getByRole("button", { name: "确认移至回收站" }));
    expect(screen.getByText(/清理进度暂不可用/)).toBeVisible();
    await act(async () => pending.resolve({ report: cleanupReport, session: { ...scanResult, groups: [] } }));
  });

  it.each(["重新扫描", "更换文件夹"])("人工修改后%s先确认，取消不丢选择", async (action) => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "全部保留" }));
    const trigger = screen.getByRole("button", { name: action });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "保留当前人工选择？" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(trigger).toHaveFocus();
    expect(screen.getByText("0 个文件")).toBeVisible();
    expect(api.startScan).toHaveBeenCalledOnce();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: action === "重新扫描" ? "继续重新扫描" : "继续更换文件夹" }));
    if (action === "重新扫描") {
      await waitFor(() => expect(api.startScan).toHaveBeenCalledTimes(2));
    } else {
      expect(screen.getByRole("heading", { name: "选择文件夹" })).toBeVisible();
    }
  });

  it("改回扫描时的原选择后不再提示离开", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    const checkbox = await screen.findByRole("checkbox", { name: "移至回收站 年度报告 - 副本.pdf" });
    await user.click(checkbox);
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "重新扫描" }));
    await waitFor(() => expect(api.startScan).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "保留当前人工选择？" })).not.toBeInTheDocument();
  });

  it("恢复全部建议后清除人工差异，离开无需再次确认", async () => {
    const user = userEvent.setup();
    const { api } = createApi();
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "全部保留" }));
    await user.click(screen.getByRole("button", { name: "恢复建议" }));
    await user.click(screen.getByRole("button", { name: "确认恢复全部建议" }));
    await user.click(screen.getByRole("button", { name: "更换文件夹" }));
    expect(screen.getByRole("heading", { name: "选择文件夹" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("单文件成功对账后的自动保留副本不冒充人工修改", async () => {
    const user = userEvent.setup();
    const third = { ...scanResult.groups[0].files[1], path: "D:\\资料库\\存档\\第三份.pdf", name: "第三份.pdf" };
    const initial = { ...scanResult, groups: [{ ...scanResult.groups[0], files: [...scanResult.groups[0].files, third] }] };
    const refreshed = { ...scanResult, groups: [{ ...scanResult.groups[0], files: [
      { ...scanResult.groups[0].files[1], cleanup: false, recommendedKeeper: true }, third,
    ] }] };
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue(initial),
      confirmCleanup: vi.fn().mockResolvedValue({ report: cleanupReport, session: refreshed }),
    });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "仅回收此文件：年度报告.pdf" }));
    await user.click(within(screen.getByRole("dialog", { name: "仅回收此文件" })).getByRole("button", { name: "移至回收站" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "重新扫描" }));
    await waitFor(() => expect(api.startScan).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "保留当前人工选择？" })).not.toBeInTheDocument();
  });

  it("单文件回收后其他组的人工选择仍受离开确认保护", async () => {
    const user = userEvent.setup();
    const otherGroup: DuplicateGroup = { ...scanResult.groups[0], id: "other", files: scanResult.groups[0].files.map((file, index) => ({ ...file, path: `D:\\资料库\\其他\\${index}.bin`, name: `其他${index}.bin` })) };
    const manualGroup = { ...scanResult.groups[0], reclaimableBytes: 0, files: scanResult.groups[0].files.map((file) => ({ ...file, cleanup: false })) };
    const { api } = createApi({
      startScan: vi.fn().mockResolvedValue({ ...scanResult, groups: [...scanResult.groups, otherGroup] }),
      confirmCleanup: vi.fn().mockResolvedValue({ report: cleanupReport, session: { ...scanResult, groups: [manualGroup] } }),
    });
    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await user.click(await screen.findByRole("button", { name: "全部保留" }));
    await user.click(screen.getByRole("button", { name: "全部展开" }));
    await user.click(screen.getByRole("button", { name: "仅回收此文件：其他0.bin" }));
    await user.click(within(screen.getByRole("dialog", { name: "仅回收此文件" })).getByRole("button", { name: "移至回收站" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "重新扫描" }));
    const dialog = screen.getByRole("dialog", { name: "保留当前人工选择？" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("checkbox", { name: "移至回收站 年度报告 - 副本.pdf" })).not.toBeChecked();
    expect(api.startScan).toHaveBeenCalledOnce();
  });
});
