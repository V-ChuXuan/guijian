<p align="center">
  <img src="desktop/assets/app-icon.svg" width="88" height="88" alt="归简图标">
</p>

<h1 align="center">归简</h1>

<p align="center">按内容识别完全重复的文件，确认后安全移入 Windows 回收站。</p>

<p align="center">
  <a href="https://github.com/V-ChuXuan/guijian/releases/latest">下载 Windows x64 安装包</a>
</p>

归简是一款整理完全重复文件的 Windows 桌面工具。选择一个文件夹后，它会递归扫描其中的普通文件，把文件大小与完整 SHA-256 均一致的文件列为一组，并给出保留与回收建议。

它不根据文件名猜测，也不把相似图片、相似视频或名称接近的文件归为重复项。

## 判重方式

扫描分为三个阶段：

1. 先按文件大小筛出候选文件。
2. 再比较文件前 64 KiB 的 SHA-256，缩小需要完整读取的范围。
3. 最后计算完整 SHA-256；只有文件大小和完整哈希都一致，才会进入同一个重复组。

前两级只为减少不必要的完整读取；最终分组以文件大小和完整哈希为准。

## 使用

1. 从 [Releases](https://github.com/V-ChuXuan/guijian/releases/latest) 下载并安装最新版本。
2. 选择要检查的文件夹，等待扫描完成。
3. 核对每组文件的保留与回收选择。
4. 点击“检查清理内容”，确认后将选中的副本移入系统回收站。

当前安装包未进行 Authenticode 代码签名，Windows 可能显示“未知发布者”。请从本项目 Releases 下载，并使用发布页附带的 `SHA256SUMS.txt` 核对文件。

## 清理保护

- 每组默认保留完整路径最短的一份，其余副本标记为待回收；选择可以在执行前调整。
- 每组始终至少保留一份，不能将整组文件全部回收。
- 清理前会重新核验它是否仍是扫描时的同一个文件，以及大小、修改时间和完整哈希；发生变化的文件会被跳过，重新扫描后才可处理。
- 文件进入 Windows 系统回收站，不会直接永久删除。
- 扫描、哈希与清理均在本机完成，文件路径和内容不会上传。

## 当前边界

- 仅支持 Windows 10 和 Windows 11，需要 Microsoft Edge WebView2 Runtime。
- 只处理文件大小和完整 SHA-256 都相同的非空普通文件，不识别相似内容。
- 不扫描符号链接和 Windows 重解析点。
- 每次扫描一个根文件夹，暂不支持多目录联合扫描和自定义排除规则。

归简只按文件内容摘要判断重复，不能判断文件对你的实际价值。重要数据仍应保留独立备份。

## 从源码运行

需要 Node.js、pnpm、Rust 稳定版和 Microsoft C++ 构建工具。

```powershell
cd desktop
pnpm install --frozen-lockfile
pnpm tauri dev
```

构建 NSIS 安装程序：

```powershell
cd desktop
pnpm tauri build
```

运行项目检查：

```powershell
cd desktop
pnpm test
pnpm build

cd src-tauri
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

## 技术与文档

桌面端使用 Tauri 2、React、TypeScript 和 Rust 构建。产品与界面约束记录在以下文档中：

- [产品定位与设计原则](docs/PRODUCT.md)
- [界面设计系统](docs/DESIGN.md)

## 致谢

归简最初受到 [WxCleaner](https://github.com/yqxie1991/WxCleaner) 的产品思路启发：从微信接收文件的清理场景出发，将重复文件整理扩展到任意目录。感谢原作者的探索与分享。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
