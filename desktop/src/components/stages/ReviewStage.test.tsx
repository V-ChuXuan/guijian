import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DuplicateGroup } from "../../api/desktopApi";
import { ReviewStage } from "./ReviewStage";

function makeGroups(count: number, files = 2): DuplicateGroup[] {
  return Array.from({ length: count }, (_, groupIndex) => ({
    id: `group-${groupIndex}`,
    digest: String(groupIndex),
    sizeBytes: 10,
    reclaimableBytes: (files - 1) * 10,
    recommendationReason: "保留一份",
    files: Array.from({ length: files }, (_, index) => ({
      path: `D:\\data\\group-${groupIndex}\\file-${index}.txt`,
      name: `group-${groupIndex}-file-${index}.txt`,
      sizeBytes: 10,
      modifiedAt: "2026-01-01T00:00:00Z",
      cleanup: index !== files - 1,
      recommendedKeeper: index === files - 1,
    })),
  }));
}

function props(groups: DuplicateGroup[]) {
  return {
    root: "D:\\data", groups, scannedFiles: groups.reduce((count, group) => count + group.files.length, 0),
    scannedBytes: 100, expandedGroupIds: new Set(groups.map((group) => group.id)),
    selectionPending: false, issue: null, issues: [],
    onToggleGroup: vi.fn(), onToggleAllGroups: vi.fn(), onDecision: vi.fn(),
    onCopyPath: vi.fn(), onRevealFile: vi.fn(), onRequestSingleCleanup: vi.fn(),
    onKeepAll: vi.fn(), onRestoreAll: vi.fn(),
  };
}

function Fixture({ initial }: { initial: DuplicateGroup[] }) {
  const [groups, setGroups] = useState(initial);
  return <ReviewStage {...props(groups)} onDecision={(id, path, cleanup) => setGroups((current) => current.map((group) =>
    group.id === id ? { ...group, files: group.files.map((file) => file.path === path ? { ...file, cleanup } : file) } : group,
  ))} onKeepAll={(id) => setGroups((current) => current.map((group) =>
    group.id === id ? { ...group, reclaimableBytes: 0, files: group.files.map((file) => ({ ...file, cleanup: false })) } : group,
  ))} />;
}

describe("审阅显示分页", () => {
  it.each([false, true])("扫描问题关闭不挂载，打开每页50项且末页全部可达，空重复组：%s", async (empty) => {
    const user = userEvent.setup();
    const issues = Array.from({ length: 101 }, (_, index) => ({ path: `D:\\data\\issue-${index}`, message: `拒绝访问 ${index}` }));
    const { container } = render(<ReviewStage {...props(empty ? [] : makeGroups(1))} issues={issues} />);
    const summary = screen.getByText("有 101 项未完成检查");
    expect(container.querySelectorAll(".scan-issues li")).toHaveLength(0);
    await user.click(summary);
    expect(container.querySelectorAll(".scan-issues li")).toHaveLength(50);
    expect(screen.getByRole("navigation", { name: "扫描问题分页" })).toHaveTextContent("第 1–50 / 101 项");
    const next = screen.getByRole("button", { name: "扫描问题：下一页" });
    next.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("D:\\data\\issue-50")).toBeVisible();
    expect(container.querySelector(".scan-issues ul")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "扫描问题：最后一页" }));
    expect(container.querySelectorAll(".scan-issues li")).toHaveLength(1);
    expect(screen.getByText("D:\\data\\issue-100")).toBeVisible();
    expect(screen.getByText("拒绝访问 100")).toBeVisible();
    await user.click(summary);
    await waitFor(() => expect(container.querySelectorAll(".scan-issues li")).toHaveLength(0));
    expect(summary).toHaveFocus();
  });

  it("扫描问题缩短到50项时调整到有效页，关闭恢复焦点且小结果无分页", async () => {
    const user = userEvent.setup();
    const issues = Array.from({ length: 51 }, (_, index) => ({ path: `D:\\data\\issue-${index}`, message: "跳过" }));
    const { container, rerender } = render(<ReviewStage {...props([])} issues={issues} />);
    const summary = screen.getByText("有 51 项未完成检查");
    await user.click(summary);
    await user.click(screen.getByRole("button", { name: "扫描问题：最后一页" }));
    rerender(<ReviewStage {...props([])} issues={issues.slice(0, 50)} />);
    expect(container.querySelectorAll(".scan-issues li")).toHaveLength(50);
    expect(screen.queryByRole("navigation", { name: "扫描问题分页" })).not.toBeInTheDocument();
    expect(screen.getByText("D:\\data\\issue-0")).toBeVisible();
    const list = container.querySelector<HTMLElement>(".scan-issues ul")!;
    list.focus();
    const details = container.querySelector<HTMLDetailsElement>(".scan-issues")!;
    details.open = false;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(list).not.toBeInTheDocument());
    expect(screen.getByText("有 50 项未完成检查")).toHaveFocus();
  });

  it("只挂载当前50组，键盘翻页后保留跨页选择与有效焦点", async () => {
    const user = userEvent.setup();
    const { container } = render(<Fixture initial={makeGroups(51)} />);
    expect(container.querySelectorAll(".review-group")).toHaveLength(50);
    expect(container.querySelectorAll(".review-file-row")).toHaveLength(100);
    const next = screen.getByRole("button", { name: "重复组：下一页" });
    next.focus();
    await user.keyboard("{Enter}");
    expect(container.querySelectorAll(".review-group")).toHaveLength(1);
    expect(container.querySelector(".review-group__head")).toHaveFocus();
    const checkbox = screen.getByRole("checkbox", { name: "移至回收站 group-50-file-0.txt" });
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "重复组：第一页" }));
    expect(screen.getByRole("checkbox", { name: "移至回收站 group-0-file-0.txt" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "重复组：最后一页" }));
    expect(screen.getByRole("checkbox", { name: "移至回收站 group-50-file-0.txt" })).not.toBeChecked();
  });

  it("全局搜索页外组并重置组页；过滤不重置人工选择", async () => {
    const user = userEvent.setup();
    const { container } = render(<Fixture initial={makeGroups(101)} />);
    await user.click(screen.getByRole("button", { name: "重复组：下一页" }));
    await user.type(screen.getByRole("searchbox"), "group-100");
    expect(container.querySelectorAll(".review-group")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "移至回收站 group-100-file-0.txt" })).toBeChecked();
    await user.clear(screen.getByRole("searchbox"));
    expect(screen.getByRole("checkbox", { name: "移至回收站 group-0-file-0.txt" })).toBeChecked();
    expect(screen.getByRole("button", { name: "重复组：上一页" })).toBeDisabled();
  });

  it("大组每页50文件，搜索定位末页且不抢输入焦点，隐藏保留项仍参与保护", async () => {
    const user = userEvent.setup();
    const { container } = render(<Fixture initial={makeGroups(1, 121)} />);
    expect(container.querySelectorAll(".review-file-row")).toHaveLength(50);
    expect(screen.getAllByRole("checkbox").every((checkbox) => !checkbox.hasAttribute("disabled"))).toBe(true);
    const search = screen.getByRole("searchbox");
    await user.type(search, "file-120");
    expect(search).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: "移至回收站 group-0-file-120.txt" })).toBeDisabled();
    const filePager = screen.getByRole("navigation", { name: "文件分页 group-0-file-0.txt" });
    await user.click(within(filePager).getByRole("button", { name: "文件：上一页" }));
    expect(screen.getByRole("checkbox", { name: "移至回收站 group-0-file-50.txt" })).toBeChecked();
    expect(container.querySelector(".review-group__head")).toHaveFocus();
    await user.clear(search);
    await user.click(screen.getByRole("checkbox", { name: "移至回收站 group-0-file-0.txt" }));
    await user.click(screen.getByRole("button", { name: "文件：最后一页" }));
    expect(screen.getByRole("checkbox", { name: "移至回收站 group-0-file-120.txt" })).not.toBeDisabled();
    await user.click(screen.getByRole("button", { name: "全部保留" }));
    await user.click(screen.getByRole("button", { name: "文件：第一页" }));
    expect(screen.getAllByRole("checkbox").every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
    const describedIds = screen.getAllByRole("checkbox").flatMap((checkbox) => (checkbox.getAttribute("aria-describedby") ?? "").split(" "));
    expect(describedIds.every((id) => !!document.getElementById(id))).toBe(true);
    expect(new Set([...container.querySelectorAll("[id]")].map((element) => element.id)).size).toBe(container.querySelectorAll("[id]").length);
  });

  it("组或文件结果缩短时回到有效页并为被卸载焦点提供落点", async () => {
    const user = userEvent.setup();
    const groups = makeGroups(101);
    const { container, rerender } = render(<ReviewStage {...props(groups)} />);
    await user.click(screen.getByRole("button", { name: "重复组：最后一页" }));
    screen.getByRole("checkbox", { name: "移至回收站 group-100-file-0.txt" }).focus();
    rerender(<ReviewStage {...props(groups.slice(0, 51))} />);
    expect(screen.getByRole("checkbox", { name: "移至回收站 group-50-file-0.txt" })).toBeChecked();
    expect(container.querySelector(".review-group__head")).toHaveFocus();
    const large = makeGroups(1, 121);
    rerender(<ReviewStage {...props(large)} />);
    await user.click(screen.getByRole("button", { name: "文件：最后一页" }));
    screen.getByRole("checkbox", { name: "移至回收站 group-0-file-120.txt" }).focus();
    rerender(<ReviewStage {...props([{ ...large[0], files: large[0].files.slice(0, 51) }])} />);
    expect(container.querySelectorAll(".review-file-row")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "移至回收站 group-0-file-50.txt" })).toBeChecked();
    expect(container.querySelector(".review-group__head")).toHaveFocus();
  });

  it("待清理筛选移除当前末页时展示有效页面，小结果无额外分页", async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(<Fixture initial={makeGroups(51)} />);
    await user.click(screen.getByRole("button", { name: "仅看待清理" }));
    await user.click(screen.getByRole("button", { name: "重复组：最后一页" }));
    await user.click(screen.getByRole("button", { name: "全部保留" }));
    expect(container.querySelectorAll(".review-group")).toHaveLength(50);
    expect(container.querySelector(".review-group__head")).toHaveFocus();
    unmount();
    render(<ReviewStage {...props(makeGroups(1))} />);
    expect(screen.queryByRole("navigation", { name: /分页/ })).not.toBeInTheDocument();
  });

  it("同名组的文件分页通过不同完整路径描述关联各自组", () => {
    const groups = makeGroups(2, 51).map((group) => ({ ...group,
      files: group.files.map((file) => ({ ...file, name: "same.txt" })),
    }));
    const { container } = render(<ReviewStage {...props(groups)} />);
    const pagers = screen.getAllByRole("navigation", { name: "文件分页 same.txt" });
    expect(pagers).toHaveLength(2);
    pagers.forEach((pager, index) => {
      const description = document.getElementById(pager.getAttribute("aria-describedby")!);
      expect(description).toHaveTextContent(groups[index].files[0].path);
    });
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
