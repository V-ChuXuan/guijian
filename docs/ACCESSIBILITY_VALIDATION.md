# 原生辅助功能验收

现有组件浏览器回归覆盖键盘、焦点及窄视口，不代表Windows读屏或200%系统缩放通过。原生检查使用本地构建EXE、自有进程和独立WebView2 profile，读取真实Windows UI Automation树及窗口DPI；不更改系统显示设置或启动讲述人。

## 本地检查

先完成项目构建，从项目根目录运行：

```powershell
node scripts/native-accessibility.mjs
node scripts/native-accessibility.mjs --scale=2
```

脚本只采集本轮启动的应用初始页面，不点击按钮、不发送键盘事件、不调用扫描或回收命令。不安装/卸载、不清空回收站、不读取其他应用的可访问树。因此它不覆盖系统文件夹选择器、扫描、审阅或确认流程。

只读PowerShell helper由本轮启动所得PID找到主窗口HWND，验证所属进程后读取其Control View子树，记录控件名称、类型、可聚焦/焦点状态和说明。嵌入WebView节点可以属于不同子进程，不按同一PID错误删去；遍历有节点/深度和外层时间界限。失败输出报告并以非零退出，不能把空树当通过。

默认运行检查初始页的原生控件暴露与布局，记录UIA可聚焦及焦点状态，不据此声称键盘操作通过。首次UIA查询可能触发WebView延迟暴露控件树，脚本允许一次后续采样；空树或缺失主要控件不能当作通过。

本地Tauri将内部invoke入口定义为不可写、不可配置，不能通过赋值安全替换文件夹选择器。早期交互探针的替换失败且审计为空，不能据此断言原生调用未发生；这些失败报告不作为流程通过证据。当前入口移除了交互测试，不绕过该限制增加拦截层。键盘、确认弹窗和完整扫描流程仍需独立验收。

`--scale=2`仅覆盖自有WebView浏览器内容的渲染倍率；报告同时保留真实 `GetDpiForWindow` 值。只有窗口实际在192 DPI显示环境，才能把它作为200% Windows系统缩放证据。倍率模拟、窄视口、浏览器zoom和DPI awareness都不能替代实际系统DPI。

报告、截图及源/EXE指纹写入 `desktop/src-tauri/target/output/native-accessibility/`。源码改变后旧报告不能冒充新代码通过。UIA树说明Windows provider确实暴露了部分语义；讲述人的播报顺序、动态提示和实际读屏操作仍需单独验收。

## 发布前人工验收

- 在隔离Windows10/11上从安装后的快捷方式启动，按完整键盘路径完成选目录、扫描、改选、确认/取消、结果详情。
- 在真实200%显示缩放环境记录窗口DPI，检查所有主操作、确认路径和失败原因均可达；复核无双滚动或横向溢出。
- 使用真实读屏器验证同名文件的路径区别、选中状态、展开/分页范围、错误及进度提示、弹窗焦点与返回位置。

安装环境按[隔离安装验收](INSTALLATION_VALIDATION.md)准备；不在已有用户安装上代测。未具备环境或未执行的步骤保留未通过状态。

参考：[UIA FromHandle](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.fromhandle)、[UIA树](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-tree-overview)、[GetDpiForWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdpiforwindow)、[WebView2诊断参数](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags)。
