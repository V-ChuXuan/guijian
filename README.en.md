<div align="center">

<img src="desktop/assets/app-icon.svg" width="120" height="120" alt="Guijian icon">

# 归简

**Find files with identical content, keep the copies you need, and recycle the rest.**

A duplicate-file organizer for Windows. Choose a folder, review its duplicate copies, and decide what to clean up.

[![version](https://img.shields.io/badge/version-0.1.0-2d6a4f?style=flat)](https://github.com/V-ChuXuan/guijian/releases/latest)
[![platform](https://img.shields.io/badge/platform-Windows%20x64-2d6a4f?style=flat)](#quick-start)
[![license](https://img.shields.io/badge/license-MIT-2d6a4f?style=flat)](LICENSE)

[Download](https://github.com/V-ChuXuan/guijian/releases/latest) · [Quick Start](#quick-start) · [Development guide](docs/DEVELOPMENT.md) · [简体中文](README.md) · [English](README.en.md)

</div>

## Quick Start

Requires Windows 10 / 11 x64 and Microsoft Edge WebView2 Runtime. Using the installer does not require Node.js or Rust.

1. Download a published installer from [Releases](https://github.com/V-ChuXuan/guijian/releases/latest) and verify it against the `SHA256SUMS.txt` on the same page.
2. Install and open Guijian, then choose a folder to organize.
3. When analysis finishes, review the keep/recycle choices in each group.
4. Confirm cleanup to move the selected copies to the Windows Recycle Bin.

The installer is unsigned; Windows may show an unknown publisher.

## Features

| What you want to do | What Guijian provides |
| --- | --- |
| Find exact duplicates | Compare nonempty files by size and full SHA-256, rather than similar names |
| Decide which copies stay | Change individual choices or keep an entire group |
| Check file locations | Inspect full paths, copy a path, or reveal a copy in File Explorer |
| Clean up in smaller steps | Recycle one file, or review and confirm a batch |
| Inspect cleanup results | View recycled, skipped and failed records with their reasons |

[More review and cleanup details](docs/DEVELOPMENT.md#审阅与结果细节) (Chinese).

## Usage

Scanning and cleanup run locally. File contents and paths are not uploaded.

- **Review before confirming.** Each group must retain at least one copy. Selected files and retained copies are checked again before cleanup; changed files are not recycled.
- **Scanning can be stopped.** Select “停止扫描” (stop scanning) to end analysis early.

Moving files to the Recycle Bin does not immediately free disk space. If an error leaves the result unconfirmed, inspect the files before deciding what to do next; Guijian does not retry automatically. Keep independent backups of important data.

## Limitations

- No similarity matching for images, videos or other near-duplicate content. Empty files, symbolic links and Windows reparse points are excluded.
- One root folder per scan; no combined multi-root scans or custom exclusions yet.
- If a path is too long, shorten it and rescan. See [usage and validation boundaries](docs/DEVELOPMENT.md#使用与验证边界) for the detailed limits.
- Network shares, removable media and real screen-reader behavior have not completed validation. See [usage and validation boundaries](docs/DEVELOPMENT.md#使用与验证边界) (Chinese).

## Development

To run the latest repository features or contribute, start with the [development and verification guide](docs/DEVELOPMENT.md) (Chinese), which covers prerequisites, startup, builds and tests.

Further reading: [product scope](docs/PRODUCT.md) · [interface design](docs/DESIGN.md) · [architecture and cleanup contract](docs/DEVELOPMENT.md#架构) · [candidate evidence](docs/CANDIDATE_EVIDENCE.md) · [accessibility checks](docs/ACCESSIBILITY_VALIDATION.md) · [isolated installation checks](docs/INSTALLATION_VALIDATION.md).

## License

Guijian is released under the [MIT License](LICENSE).

## Credits

[WxCleaner](https://github.com/yqxie1991/WxCleaner) inspired the initial idea of organizing files received through WeChat, which grew into organizing duplicates in arbitrary folders.

<p align="center"><sub>If Guijian helps you organize your files, a ⭐ can help others discover it.</sub></p>
