import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScanStage } from "./ScanStage";

describe("扫描反馈", () => {
  it("枚举总量未知时不显示0%或伪造确定进度", () => {
    render(<ScanStage state="running" issue={null} progress={{ stage: "enumerating", completed: 0, total: 0, scannedFiles: 29416, scannedBytes: 6_110_000_000 }} />);
    expect(screen.getByText("正在发现文件")).toBeVisible();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText("已发现文件")).toBeVisible();
    expect(screen.getByText("文件容量")).toBeVisible();
  });

  it.each([ ["partial_hash", "正在初步比对"], ["full_hash", "正在完整比对"] ] as const)("显示 %s 当前阶段进度", (stage, label) => {
    render(<ScanStage state="running" issue={null} progress={{ stage, completed: 1, total: 4, scannedFiles: 20, scannedBytes: 40 }} />);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText("1 / 4 个候选文件")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("订阅不可用时不把旧计数展示为实时进度，停止请求错误仍可见", () => {
    render(<ScanStage state="running" issue="停止请求失败" progressIssue="扫描进度暂不可用：事件服务不可用" progress={{ stage: "full_hash", completed: 1, total: 4, scannedFiles: 20, scannedBytes: 40 }} />);
    expect(screen.getByRole("status")).toHaveTextContent("扫描进度暂不可用：事件服务不可用");
    expect(screen.getByRole("alert")).toHaveTextContent("停止请求失败");
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.queryByText("25%")).not.toBeInTheDocument();
    expect(screen.queryByText("已发现文件")).not.toBeInTheDocument();
    expect(screen.queryByText("文件容量")).not.toBeInTheDocument();
  });
});
