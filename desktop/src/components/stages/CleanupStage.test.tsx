import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CleanupReport, ScanSession } from "../../api/desktopApi";
import { CleanupStage } from "./CleanupStage";

const session: ScanSession = { root: "D:\\files", scannedFiles: 5, scannedBytes: 20, groups: [], issues: [] };
const report: CleanupReport = {
  cancelled: false, remainingFiles: 0,
  movedCount: 1, failedCount: 1, skippedCount: 2, reclaimableBytes: 4,
  items: [
    { path: "D:\\files\\success.txt", status: "moved_to_trash", message: "已回收" },
    { path: "D:\\files\\busy.txt", status: "failed", message: "文件正在使用中" },
    { path: "D:\\files\\changed.txt", status: "changed", message: "内容已改变" },
    { path: "D:\\files\\blocked.txt", status: "blocked", message: "保留副本无法核验" },
  ],
};

function largeReport(count: number): CleanupReport {
  return {
    cancelled: false, remainingFiles: 0, movedCount: count, failedCount: count, skippedCount: 0, reclaimableBytes: 400,
    items: Array.from({ length: count }, (_, index) => [
      { path: `D:\\files\\moved-${index}.txt`, status: "moved_to_trash" as const, message: "已回收" },
      { path: `D:\\files\\failed-${index}.txt`, status: "failed" as const, message: `占用 ${index}` },
    ]).flat(),
  };
}

describe("清理结果", () => {
  it("批量确认统计完整会话的已选长路径，保留原预计容量及选择", () => {
    const groups = Array.from({ length: 51 }, (_, index) => ({
      id: `group-${index}`, digest: String(index), sizeBytes: 10, reclaimableBytes: 7, recommendationReason: "保留一份",
      files: [
        { path: `D:\\files\\${index}-${"k".repeat(260)}`, name: "keep.txt", sizeBytes: 10, modifiedAt: "", cleanup: false, recommendedKeeper: true },
        { path: index === 50 ? `D:\\files\\${"a".repeat(260)}` : `D:\\files\\${index}.txt`, name: "copy.txt", sizeBytes: 10, modifiedAt: "", cleanup: true, recommendedKeeper: false },
      ],
    }));
    const completeSession = { ...session, groups };
    const before = structuredClone(completeSession);
    render(<CleanupStage view="confirm" session={completeSession} report={null} issue={null} onCopyPath={vi.fn()} onRevealFile={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "准备移动 51 个副本" })).toBeVisible();
    expect(screen.getByText("357 B")).toBeVisible();
    expect(screen.getByText(/已选文件中有 1 个.*当前版本无法回收/)).toBeVisible();
    expect(screen.getByText(/预计容量仍包含这些文件/)).toBeVisible();
    expect(completeSession).toEqual(before);
  });

  it("全部长路径均保留时不显示批量限制提示", () => {
    render(<CleanupStage view="confirm" session={session} report={null} issue={null} onCopyPath={vi.fn()} onRevealFile={vi.fn()} />);
    expect(screen.queryByText(/当前版本无法回收/)).not.toBeInTheDocument();
    expect(screen.queryByText(/预计容量仍包含这些文件/)).not.toBeInTheDocument();
  });

  it("完整报告先筛选再分页，51条失败的末项可复制定位，统计不随页变", async () => {
    const user = userEvent.setup();
    const copy = vi.fn();
    const reveal = vi.fn();
    const { container } = render(<CleanupStage view="complete" session={session} report={largeReport(51)} issue={null} onCopyPath={copy} onRevealFile={reveal} />);
    expect(container.querySelectorAll(".receipt-details li")).toHaveLength(50);
    expect(screen.getByRole("navigation", { name: "处理记录分页" })).toHaveTextContent("第 1–50 / 51 条");
    expect(screen.getByRole("button", { name: "全部 102 个" })).toBeVisible();
    const next = screen.getByRole("button", { name: "处理记录：下一页" });
    next.focus();
    await user.keyboard("{Enter}");
    expect(container.querySelectorAll(".receipt-details li")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "处理记录分页" })).toHaveTextContent("第 51–51 / 51 条");
    const copyButton = screen.getByRole("button", { name: "复制完整路径" });
    expect(copyButton).toHaveFocus();
    expect(copyButton).toHaveAccessibleDescription("D:\\files\\failed-50.txt");
    await user.click(copyButton);
    await user.click(screen.getByRole("button", { name: "在资源管理器中显示" }));
    expect(copy).toHaveBeenCalledWith("D:\\files\\failed-50.txt");
    expect(reveal).toHaveBeenCalledWith("D:\\files\\failed-50.txt");
    await user.click(screen.getByRole("button", { name: "已移入回收站 51 个" }));
    expect(container.querySelectorAll(".receipt-details li")).toHaveLength(50);
    expect(screen.getByText("D:\\files\\moved-0.txt")).toBeVisible();
    expect(screen.queryByRole("button", { name: "在资源管理器中显示" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "处理记录：最后一页" }));
    expect(screen.getByText("D:\\files\\moved-50.txt")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "全部 102 个" }));
    expect(screen.getByRole("navigation", { name: "处理记录分页" })).toHaveTextContent("第 1–50 / 102 条");
    await user.click(screen.getByRole("button", { name: "处理记录：最后一页" }));
    expect(container.querySelectorAll(".receipt-details li")).toHaveLength(2);
    expect(screen.getByText("D:\\files\\failed-50.txt")).toBeVisible();
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("新报告重置筛选和页，缩短至50条后无分页且卸载焦点回到有效操作", async () => {
    const user = userEvent.setup();
    const callbacks = { onCopyPath: vi.fn(), onRevealFile: vi.fn() };
    const { rerender } = render(<CleanupStage view="complete" session={session} report={largeReport(101)} issue={null} {...callbacks} />);
    await user.click(screen.getByRole("button", { name: "已移入回收站 101 个" }));
    await user.click(screen.getByRole("button", { name: "处理记录：最后一页" }));
    screen.getByRole("button", { name: "复制完整路径" }).focus();
    rerender(<CleanupStage view="complete" session={session} report={largeReport(50)} issue={null} {...callbacks} />);
    expect(screen.getByRole("button", { name: "未处理 50 个" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("navigation", { name: "处理记录分页" })).not.toBeInTheDocument();
    expect(screen.getByText("D:\\files\\failed-0.txt")).toBeVisible();
    expect(within(screen.getByLabelText("处理详情")).getAllByRole("button", { name: "复制完整路径" })[0]).toHaveFocus();
  });

  it("停止结果分开报告未开始数量与实际处理记录", () => {
    render(<CleanupStage view="complete" session={session} report={{ ...report, cancelled: true, remainingFiles: 5, failedCount: 0, skippedCount: 0, items: [report.items[0]] }} issue={null} onCopyPath={vi.fn()} onRevealFile={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "清理已停止" })).toBeVisible();
    expect(screen.getByText("还有 5 个文件未开始处理。")).toBeVisible();
    expect(screen.getByRole("button", { name: "失败或跳过 0 个" })).toBeVisible();
    expect(screen.getByRole("button", { name: "已处理记录 1 个" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "未处理 0 个" })).not.toBeInTheDocument();
  });
  it("默认展示全部未处理状态，可筛选成功项但不提供已回收文件定位", async () => {
    const user = userEvent.setup();
    const copy = vi.fn();
    const reveal = vi.fn();
    render(<CleanupStage view="complete" session={session} report={report} issue={null} onCopyPath={copy} onRevealFile={reveal} />);
    expect(screen.getByRole("heading", { name: "部分文件未处理" })).toBeVisible();
    for (const item of report.items.slice(1)) {
      expect(screen.getByText(item.path)).toBeVisible();
      expect(screen.getByText(item.message)).toBeVisible();
    }
    expect(screen.queryByText(report.items[0].path)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "未处理 3 个" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "已移入回收站 1 个" }));
    expect(screen.getByText(report.items[0].path)).toBeVisible();
    expect(screen.queryByRole("button", { name: "在资源管理器中显示" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "复制完整路径" }));
    expect(copy).toHaveBeenCalledWith(report.items[0].path);
    await user.click(screen.getByRole("button", { name: "全部 4 个" }));
    expect(screen.getAllByRole("button", { name: "复制完整路径" })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: "在资源管理器中显示" })).toHaveLength(3);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("全部失败不显示清理完成，空筛选给出明确反馈", async () => {
    const user = userEvent.setup();
    render(<CleanupStage view="complete" session={session} report={{ ...report, movedCount: 0, skippedCount: 0, reclaimableBytes: 0, items: [report.items[1]] }} issue="定位失败" onCopyPath={vi.fn()} onRevealFile={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "未能清理所选文件" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("定位失败");
    await user.click(screen.getByRole("button", { name: "已移入回收站 0 个" }));
    expect(screen.getByText("没有此类处理记录。")).toBeVisible();
  });
});
