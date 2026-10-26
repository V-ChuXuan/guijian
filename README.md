<div align="center">

<img src="desktop/assets/app-icon.svg" width="88" height="88" alt="归简图标">

# 归简

**按内容找出完全重复的文件，核对后将副本移入 Windows 回收站。**

选择文件夹 → 分析文件 → 检查副本 → 确认清理。适合希望整理重复文件、同时保留人工决定权的 Windows 用户。

[下载安装包](https://github.com/V-ChuXuan/guijian/releases/latest) · [开发](#开发) · [简体中文](README.md) · [English](README.en.md)

</div>

以下介绍以当前源码为准；安装包功能请以对应发布说明为准。

## 快速开始

需要 Windows 10 / 11 x64 和 Microsoft Edge WebView2 Runtime，普通使用无需安装 Node.js 或 Rust。

1. 从 [Releases](https://github.com/V-ChuXuan/guijian/releases/latest) 下载 Windows x64 安装包，用发布页的 `SHA256SUMS.txt` 核对文件。
2. 安装并打开归简，选择一个要检查的文件夹。
3. 等待分析完成，查看未完成检查的项目及原因。
4. 核对每组文件的保留与回收选择，或将整组全部保留。
5. 点击“检查清理内容”，核对数量后确认移至回收站。

当前安装包未进行 Authenticode 代码签名，Windows 可能显示“未知发布者”。安装、升级和卸载仍待完成[隔离验收](docs/INSTALLATION_VALIDATION.md)。

## 功能

- **按内容判重**：只列出大小和完整 SHA-256 一致的非空普通文件，不以文件名相似作为依据。
- **人工审阅**：逐个调整保留与回收选择、整组全部保留；恢复建议前先确认，避免覆盖人工选择。
- **检索与筛选**：按文件名或路径搜索，或仅看待清理组。筛选只改变展示，清理仍包含整个会话的已选文件。
- **分段审阅**：每页最多显示 50 个重复组，每个展开组每页最多显示 50 个文件；翻页保留选择，搜索覆盖完整会话并定位首个命中文件所在页。处理记录和展开的扫描异常也按每页最多 50 项显示。
- **单项与批量清理**：单独回收一项后更新当前结果，不重新扫描，保留其他组的人工选择。
- **进度与停止**：显示扫描阶段、清理计数和当前文件；清理停止在当前文件完整处理后生效，不回滚已完成项。
- **处理详情**：失败或跳过项直接显示路径和原因，可复制或定位；成功记录可另行查看，剩余选择可返回检查。
- **键盘操作**：菜单操作后返回触发器焦点；单文件确认支持键盘读取完整相对路径。更换文件夹或重扫前会确认是否丢弃人工修改。

## 架构

判重方式分为三步：按文件大小筛选，比较前 64 KiB 的 SHA-256，最后计算完整 SHA-256。前两步减少完整读取，最终分组仍以大小和完整哈希为准。

清理保护包括：

- 默认建议保留完整路径最短的一份，执行前可调整；每组至少保留一份。
- 执行前重新核验待清理文件与至少一份保留副本的身份、大小、修改时间和完整内容；目标变化或没有可验证保留副本时不回收。
- 只回收确认路径；回收 HTML 时不连带处理未选择的资源目录，不提供永久删除选项。
- 扫描和清理在本机完成，文件路径与内容不上传。
- 扫描或清理中关闭窗口会被拦截并提示先停止；等待结果返回后可正常关闭。

清理异常只表示未能确认结果，不能据此认定没有文件被处理；界面保留具体错误，不自动重试。移入回收站的容量为估算，并不意味着立即释放磁盘空间。详见[清理与会话合同](docs/CLEANUP_CONTRACT.md)。

单文件清理区分可信报告失败、明确前置拒绝和未知结果。结果未知时保留实际错误，提供返回检查文件状态，不直接再次提交回收。

## 什么时候不该用

使用限制：

- 不识别相似图片、视频或其他近似内容，不处理空文件，不扫描符号链接或 Windows 重解析点。
- 每次只扫描一个根文件夹，暂不支持多目录联合扫描或自定义排除规则。
- Shell 路径达到 260 个 UTF-16 单元时，确认前提示限制，清理时仍拒绝回收。选择和估算保持原口径；确认页会说明容量包含受限的已选文件。缩短路径后需重新扫描，这类路径的回收站恢复能力尚未验证。
- 审阅采用分页，但搜索仍检查完整会话，响应取决于数据规模和硬件。仓库的渲染基准只覆盖合成审阅组件，不代表完整应用、磁盘扫描或普通硬件的表现。
- 网络共享、可移动介质、完整安装生命周期及真实读屏表现尚未完成验收，不能由本地专项通过推导为已支持。

归简不能判断文件对你的实际价值。重要数据仍应保留独立备份。

## 开发

从源码运行需要 Node.js 24.12.0、pnpm 12.8.1、Rust 1.97.0、Microsoft C++ 构建工具和 WebView2 Runtime。版本分别固定在 `desktop/.node-version`、`desktop/package.json` 与 `desktop/src-tauri/rust-toolchain.toml`。

在仓库根目录启动：

```powershell
cd desktop
pnpm install --frozen-lockfile
pnpm tauri dev
```

依赖安装会更改环境，开发命令会启动原生 GUI。

从仓库根目录构建 NSIS 安装包：

```powershell
cd desktop
pnpm tauri build
```

构建产物位于 `desktop/src-tauri/target/release/bundle/nsis/`。

本地验收或CI交接时，可用[候选包留档](docs/CANDIDATE_EVIDENCE.md)一起保存安装包、校验和、源码指纹及真实检查记录。CI候选请求保留14天，不等于已发布版本或已通过安装验收。

常规检查从仓库根目录开始：

```powershell
cd desktop
pnpm test
pnpm build
node --test ../scripts/native-smoke-exit.test.mjs ../scripts/candidate-evidence.test.mjs
cd src-tauri
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

[Windows CI](.github/workflows/ci.yml)包含常规检查和 NSIS 构建，不发布安装包。

<details>
<summary>真实 Windows 专项与渲染基准</summary>

从仓库根目录分别运行：

```powershell
cd desktop/src-tauri
cargo test --locked --test windows_shell -- --ignored --test-threads=1
```

```powershell
node scripts/native-smoke.mjs
node scripts/native-smoke.mjs --close-during-cleanup
node scripts/review-benchmark.mjs
node scripts/single-cleanup-smoke.mjs
node scripts/native-accessibility.mjs
```

前两类专项会回收自建合成文件；基准会启动独立 Edge。每段命令均从仓库根目录开始，不要在上一段的目录中接续运行。

普通 `cargo test` 跳过真实回收站专项；专项验证普通回收、占用拒绝、HTML 资源隔离和长路径拒绝，保留回收站内样本，不清空回收站。[手动 Windows release validation](.github/workflows/release-validation.yml)在一次性 Windows runner 中执行 Shell 专项，不上传或发布安装包。

原生专项需先完成上面的 NSIS 构建，生成 `desktop/src-tauri/target/release/guijian-desktop.exe`。它覆盖真实 WebView2 / Tauri 命令、事件、停止、剩余会话与窗口关闭，不等于完整系统文件夹选择器操作链。渲染基准需先安装前端依赖并准备 Edge，使用生产构建与合成状态，不含后端 IPC。单项清理专项使用生产 App 与合成 API 验证未知结果和键盘行为，不回收文件，也不注入真实 IPC 故障。采样时避免并发构建或测试。脚本把含断言或源码指纹的报告写入 `desktop/src-tauri/target/output/`。

辅助功能检查只读取原生初始窗口的UIA控件、布局和真实DPI，不验证键盘输入、读屏播报或清理流程。

</details>

技术与文档：桌面端使用 Tauri 2、React、TypeScript 和 Rust。参见[产品定位](docs/PRODUCT.md)、[界面设计系统](docs/DESIGN.md)、[清理与会话合同](docs/CLEANUP_CONTRACT.md)、[原生辅助功能检查](docs/ACCESSIBILITY_VALIDATION.md)及[隔离安装验收](docs/INSTALLATION_VALIDATION.md)。

## 许可证

归简基于 [MIT License](LICENSE) 开源。

## 致谢

[WxCleaner](https://github.com/yqxie1991/WxCleaner)启发了归简最初从微信接收文件清理出发的产品思路，随后扩展为任意目录的重复文件整理。

<p align="center"><sub>如果归简对你有帮助，欢迎点亮 ⭐，让更多有同样需求的人发现它。</sub></p>
