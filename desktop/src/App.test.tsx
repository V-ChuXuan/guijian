import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import App from "./App";
import type {
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
  const api: DesktopApi = {
    selectScanRoot: vi.fn().mockResolvedValue({
      path: "D:\\资料库",
      name: "资料库",
    }),
    startScan: vi.fn().mockResolvedValue(scanResult),
    cancelScan: vi.fn().mockResolvedValue(true),
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
    prepareSingleCleanup: vi.fn().mockResolvedValue(scanResult),
    restoreRecommendedSelections: vi.fn().mockResolvedValue(scanResult),
    confirmCleanup: vi.fn().mockResolvedValue(cleanupReport),
    copyPath: vi.fn().mockResolvedValue(undefined),
    revealFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return {
    api,
    emitProgress(progress: ScanProgress) {
      progressListener?.(progress);
    },
  };
}

describe("归简", () => {
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
    expect(screen.getByRole("progressbar", { name: "分析进度 50%" })).toBeInTheDocument();
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
    expect(
      screen.queryByRole("button", { name: "重新分析" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      firstScan.resolve(scanResult);
    });

    expect(
      await screen.findByRole("heading", { name: "正在分析空间" }),
    ).toBeInTheDocument();
    expect(screen.getByText("分析已停止")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新分析" }));

    expect(api.startScan).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole("heading", { name: "检查重复文件" }),
    ).toBeInTheDocument();
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
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/筛选文件名|筛选.*路径/)).not.toBeInTheDocument();
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

  it("可以一键恢复所有重复组的默认建议", async () => {
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
    expect(api.prepareSingleCleanup).not.toHaveBeenCalled();
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
    expect(api.prepareSingleCleanup).not.toHaveBeenCalled();
    expect(api.confirmCleanup).not.toHaveBeenCalled();
  });

  it("确认单文件回收时串行准备、清理和重扫，并在执行期间禁止关闭与重复提交", async () => {
    const user = userEvent.setup();
    const preparePending = deferred<ScanSession>();
    const cleanupPending = deferred<CleanupReport>();
    const refreshedSession: ScanSession = { ...scanResult, groups: [] };
    const { api } = createApi({
      startScan: vi
        .fn()
        .mockResolvedValueOnce(scanResult)
        .mockResolvedValueOnce(refreshedSession),
      prepareSingleCleanup: vi.fn().mockReturnValue(preparePending.promise),
      confirmCleanup: vi.fn().mockReturnValue(cleanupPending.promise),
    });
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    const target = screen.getByRole("button", {
      name: "仅回收此文件：年度报告.pdf",
    });

    await user.click(target);
    const dialog = screen.getByRole("dialog", { name: "仅回收此文件" });
    const confirm = within(dialog).getByRole("button", { name: "移至回收站" });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    await user.click(confirm);

    expect(api.prepareSingleCleanup).toHaveBeenCalledOnce();
    expect(api.prepareSingleCleanup).toHaveBeenCalledWith(
      "group-report",
      "D:\\资料库\\工作\\年度报告.pdf",
    );
    expect(api.confirmCleanup).not.toHaveBeenCalled();
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();
    await user.click(confirm);
    expect(api.prepareSingleCleanup).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "仅回收此文件" })).toBeInTheDocument();

    await act(async () => {
      preparePending.resolve(scanResult);
    });
    await waitFor(() => expect(api.confirmCleanup).toHaveBeenCalledOnce());
    expect(api.startScan).toHaveBeenCalledOnce();

    await act(async () => {
      cleanupPending.resolve(cleanupReport);
    });
    await waitFor(() => expect(api.startScan).toHaveBeenCalledTimes(2));
    expect(api.startScan).toHaveBeenLastCalledWith("D:\\资料库");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "仅回收此文件" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "未发现重复文件" })).toBeInTheDocument();
    expect(
      vi.mocked(api.prepareSingleCleanup).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(api.confirmCleanup).mock.invocationCallOrder[0],
    );
  });

  it("单文件计划失败时留在弹窗并显示精确错误，关闭后仍可继续审阅", async () => {
    const user = userEvent.setup();
    const { api } = createApi({
      prepareSingleCleanup: vi.fn().mockRejectedValue({
        code: "invalid_selection",
        message: "文件已不在当前重复组中",
      }),
    });
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    const target = screen.getByRole("button", {
      name: "仅回收此文件：年度报告.pdf",
    });
    await user.click(target);
    const dialog = screen.getByRole("dialog", { name: "仅回收此文件" });
    await user.click(within(dialog).getByRole("button", { name: "移至回收站" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "文件已不在当前重复组中",
    );
    expect(screen.getByRole("heading", { name: "检查重复文件" })).toBeInTheDocument();
    expect(api.confirmCleanup).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(target).toHaveFocus();
  });

  it("单文件执行失败时保留弹窗和目标信息，不会误刷新结果", async () => {
    const user = userEvent.setup();
    const preparedSession: ScanSession = {
      ...scanResult,
      groups: scanResult.groups.map((group) => ({
        ...group,
        files: group.files.map((file) => ({
          ...file,
          cleanup: file.path === "D:\\资料库\\工作\\年度报告.pdf",
        })),
      })),
    };
    const { api } = createApi({
      prepareSingleCleanup: vi.fn().mockResolvedValue(preparedSession),
      confirmCleanup: vi.fn().mockRejectedValue({
        code: "trash_failed",
        message: "系统回收站暂时不可用",
      }),
    });
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await user.click(screen.getByRole("button", { name: "开始分析" }));
    await screen.findByRole("heading", { name: "检查重复文件" });
    await user.click(
      screen.getByRole("button", { name: "仅回收此文件：年度报告.pdf" }),
    );
    const dialog = screen.getByRole("dialog", { name: "仅回收此文件" });
    await user.click(within(dialog).getByRole("button", { name: "移至回收站" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "系统回收站暂时不可用",
    );
    expect(within(dialog).getByText("年度报告.pdf")).toBeInTheDocument();
    expect(api.startScan).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "检查重复文件" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(
      screen.getByRole("checkbox", { name: "移至回收站 年度报告.pdf" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: "移至回收站 年度报告 - 副本.pdf",
      }),
    ).not.toBeChecked();
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
});
