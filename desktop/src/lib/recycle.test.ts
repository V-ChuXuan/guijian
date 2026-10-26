import { describe, expect, it } from "vitest";

import { getRecyclePathIssue } from "./recycle";

describe("回收路径限制预告", () => {
  it.each([
    ["盘符", "C:\\", ""],
    ["UNC", "\\\\server\\share\\", ""],
    ["扩展盘符", "C:\\", "\\\\?\\"],
    ["扩展UNC", "\\\\server\\share\\", "extended-unc"],
  ])("%s路径按Shell路径259/260个UTF16单元判断", (_name, prefix, extended) => {
    for (const length of [259, 260]) {
      const shellPath = prefix + "a".repeat(length - prefix.length);
      const path = extended === "extended-unc"
        ? `\\\\?\\UNC\\${shellPath.slice(2)}`
        : extended + shellPath;
      if (length === 259) expect(getRecyclePathIssue(path)).toBeNull();
      else expect(getRecyclePathIssue(path)).toMatch(/路径过长.*当前版本无法回收/);
    }
  });

  it("非BMP字符占两个UTF16单元", () => {
    expect(getRecyclePathIssue(`C:\\${"a".repeat(254)}😀`)).toBeNull();
    expect(getRecyclePathIssue(`C:\\${"a".repeat(255)}😀`)).toMatch(/当前版本无法回收/);
  });

  it("不修剪空白或折叠分隔符，也不做不区分大小写的前缀替换", () => {
    expect(getRecyclePathIssue(`C:\\${"a".repeat(256)} `)).toMatch(/当前版本无法回收/);
    expect(getRecyclePathIssue(`C:\\\\${"a".repeat(256)}`)).toMatch(/当前版本无法回收/);
    const prefix = "\\\\?\\unc\\server\\share\\";
    expect(getRecyclePathIssue(prefix + "a".repeat(260 - (prefix.length - 4)))).toMatch(/当前版本无法回收/);
  });
});
