import { describe, expect, it } from "vitest";

import { formatDate, formatRelativePath, normalizeWindowsPath } from "./format";

describe("文件日期显示", () => {
  it("按本地时间显示年月日与24小时制时分，连续日期互不影响", () => {
    expect(formatDate(new Date(2026, 9, 26, 8, 5).toISOString())).toBe("2026/10/26 08:05");
    expect(formatDate(new Date(2024, 1, 29, 23, 59).toISOString())).toBe("2024/02/29 23:59");
    expect(formatDate(new Date(2026, 9, 26, 8, 5).toISOString())).toBe("2026/10/26 08:05");
  });

  it("非法日期仍显示时间未知，不影响下一次有效日期格式化", () => {
    expect(formatDate("not-a-date")).toBe("时间未知");
    expect(formatDate("")).toBe("时间未知");
    expect(formatDate(new Date(2026, 0, 1, 0, 0).toISOString())).toBe("2026/01/01 00:00");
  });
});

describe("Windows 路径显示", () => {
  it("将混合和重复分隔符规范化为单个反斜杠", () => {
    expect(normalizeWindowsPath("D:/Base\\\\Nested//")).toBe(
      "D:\\Base\\Nested",
    );
  });

  it("保留 UNC 前缀并规范化网络路径", () => {
    expect(normalizeWindowsPath("//server/share//Archive/")).toBe(
      "\\\\server\\share\\Archive",
    );
  });

  it("保留盘符根目录的末尾分隔符", () => {
    expect(normalizeWindowsPath("D:/")).toBe("D:\\");
  });

  it("显示扫描根目录下包含文件名的相对路径", () => {
    expect(
      formatRelativePath("D:\\Base", "D:\\Base\\2026-07\\a.docx"),
    ).toBe("2026-07\\a.docx");
  });

  it("直接显示扫描根目录直属文件的文件名", () => {
    expect(formatRelativePath("D:\\Base", "D:\\Base\\a.docx")).toBe(
      "a.docx",
    );
  });

  it("以不区分大小写的方式匹配 Windows 根目录", () => {
    expect(
      formatRelativePath("d:\\base", "D:\\BASE\\Archive\\a.docx"),
    ).toBe("Archive\\a.docx");
  });

  it("在 UNC 根目录下显示包含文件名的相对路径", () => {
    expect(
      formatRelativePath(
        "\\\\server\\share",
        "\\\\SERVER\\SHARE\\Archive\\a.docx",
      ),
    ).toBe("Archive\\a.docx");
  });

  it("文件不在扫描根目录时回退到规范化完整路径", () => {
    expect(formatRelativePath("D:\\Base", "E:/Other//a.docx")).toBe(
      "E:\\Other\\a.docx",
    );
  });
});
