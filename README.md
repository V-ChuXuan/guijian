<div align="center">

<img src="desktop/assets/app-icon.svg" width="120" height="120" alt="归简图标">

# 归简

**找出内容完全相同的文件，留下需要的，把多余副本移入回收站。**

一款 Windows 重复文件整理工具。选一个文件夹，核对重复副本，再决定如何清理。

[![version](https://img.shields.io/badge/version-0.2.0-2d6a4f?style=flat)](https://github.com/V-ChuXuan/guijian/releases/latest)
[![platform](https://img.shields.io/badge/platform-Windows%20x64-2d6a4f?style=flat)](#快速开始)
[![license](https://img.shields.io/badge/license-MIT-2d6a4f?style=flat)](LICENSE)

[下载应用](https://github.com/V-ChuXuan/guijian/releases/latest) · [快速开始](#快速开始) · [开发文档](docs/DEVELOPMENT.md) · [简体中文](README.md) · [English](README.en.md)

</div>

## 快速开始

需要 Windows 10 / 11 x64 和 Microsoft Edge WebView2 Runtime。使用安装包无需安装 Node.js 或 Rust。

1. 从 [Releases](https://github.com/V-ChuXuan/guijian/releases/latest) 下载已发布的安装包，并用同页的 `SHA256SUMS.txt` 核对文件。
2. 安装并打开归简，选择要整理的文件夹。
3. 分析完成后，核对每组文件的保留与回收选择。
4. 确认清理，将选中的副本移入 Windows 回收站。

安装包未进行代码签名，Windows 可能显示“未知发布者”。

## 功能

| 你要做的事 | 归简提供的操作 |
| --- | --- |
| 找出真正重复的文件 | 按大小和完整 SHA-256 比对非空文件，不靠文件名猜测 |
| 自己决定留下哪份 | 调整每个文件的选择，或将整组全部保留 |
| 审阅大量副本 | 按文件名或路径搜索、只看待清理组，并分页检查文件 |
| 核对文件位置 | 查看副本完整路径，复制路径或在资源管理器中定位文件 |
| 分次整理 | 单独回收一个文件，或确认后批量处理 |
| 查看清理结果 | 查看未处理文件的路径和原因，复制或定位后返回继续检查 |

[更多审阅与清理操作](docs/DEVELOPMENT.md#审阅与结果细节) · [版本更新](CHANGELOG.md)。

## 用法

扫描和清理都在本机进行，文件内容与路径不上传。

- **先核对，再确认。** 每组至少保留一份；执行前会重新检查待清理文件及保留副本，文件变化时不回收。
- **扫描和清理均可停止。** 清理停止在当前文件处理完成后生效；已经回收的文件仍在回收站，尚未处理的选择会保留。

移入回收站不会立即释放磁盘空间。若出现结果未确认的错误，先检查文件状态，再决定下一步；归简不会自动重试。重要文件仍应保留独立备份。

## 什么时候不该用

- 不识别相似图片、视频等近似内容，也不处理空文件、符号链接或 Windows 重解析点。
- 每次扫描一个根文件夹，暂不支持多目录联合扫描或自定义排除规则。
- 路径过长时请缩短路径后重新扫描；具体限制见[使用与验证边界](docs/DEVELOPMENT.md#使用与验证边界)。
- 网络共享、可移动介质和真实读屏表现尚未完成验收，详见[使用与验证边界](docs/DEVELOPMENT.md#使用与验证边界)。

## 开发

想运行仓库中的最新功能或参与开发，请从[开发与验证](docs/DEVELOPMENT.md)开始，里面包含环境准备、启动、构建和测试命令。

进一步阅读：[产品定位](docs/PRODUCT.md) · [界面设计](docs/DESIGN.md) · [架构与清理合同](docs/DEVELOPMENT.md#架构) · [候选包留档](docs/CANDIDATE_EVIDENCE.md) · [辅助功能检查](docs/ACCESSIBILITY_VALIDATION.md) · [隔离安装验收](docs/INSTALLATION_VALIDATION.md)。

## 许可证

归简基于 [MIT License](LICENSE) 开源。

## 致谢

[WxCleaner](https://github.com/yqxie1991/WxCleaner)启发了归简从微信接收文件整理出发、逐步扩展到任意文件夹的最初思路。

<p align="center"><sub>如果归简帮你整理好了文件，欢迎点亮 ⭐，让更多人发现它。</sub></p>
