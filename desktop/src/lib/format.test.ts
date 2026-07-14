import { describe, expect, it } from "vitest";

import { formatRelativePath, normalizeWindowsPath } from "./format";

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
