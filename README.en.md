<div align="center">

<img src="desktop/assets/app-icon.svg" width="88" height="88" alt="Guijian icon">

# 归简

**Find exact duplicate files by content, review your choices, and move copies to the Windows Recycle Bin.**

Choose a folder → analyze files → review copies → confirm cleanup. A Windows desktop tool for people who want to organize duplicates while keeping control of what stays.

[Download](https://github.com/V-ChuXuan/guijian/releases/latest) · [Development](#development) · [简体中文](README.md) · [English](README.en.md)

</div>

This README describes the current source. Check the corresponding release notes for the features included in an installer.

## Quick Start

Requires Windows 10 / 11 x64 and Microsoft Edge WebView2 Runtime. Using the installer does not require Node.js or Rust.

1. Download the Windows x64 installer from [Releases](https://github.com/V-ChuXuan/guijian/releases/latest) and verify it against the release's `SHA256SUMS.txt`.
2. Install and open Guijian, then select a folder to inspect.
3. Wait for analysis and review any paths that could not be checked and their reasons.
4. Check the keep/recycle choices in each group, or keep the whole group.
5. Select “检查清理内容” (review cleanup), check the totals, and confirm moving the selected copies to the Recycle Bin.

The current installer has no Authenticode signature; Windows may show an unknown publisher. Installation, upgrade and uninstall still need [isolated validation](docs/INSTALLATION_VALIDATION.md).

## Features

- **Content-based matching:** only nonempty regular files with equal sizes and full SHA-256 hashes appear as duplicates; similar names are insufficient.
- **Manual review:** change individual keep/recycle choices or keep an entire group. Restoring recommendations requires confirmation before replacing your choices.
- **Search and filters:** search names or paths, or show groups with cleanup selections. Filters affect display only; cleanup still includes selections across the entire session.
- **Paged review:** display up to 50 groups per page and 50 files per expanded group page. Choices persist across pages; search covers the full session and opens the page containing the first matching file. Cleanup records and expanded scan diagnostics also show up to 50 entries per page.
- **Single-file and batch cleanup:** recycling one file updates the current results without rescanning or resetting choices in other groups.
- **Progress and stop:** see scan phases, cleanup counts and the current path. A cleanup stop takes effect after the current file finishes; completed work is not rolled back.
- **Result details:** failed or skipped items show paths and reasons, with copy and reveal actions. View successful records separately or return to inspect remaining selections.
- **Keyboard handling:** menu actions return focus to their trigger; single-file confirmation exposes the complete path relative to the scanned folder to keyboard users. Rescanning or changing folders asks before discarding manual changes.

## Architecture

Duplicate detection has three stages: group by file size, compare SHA-256 hashes of the first 64 KiB, then compute full SHA-256 hashes. The first two stages reduce full reads; final groups still require equal sizes and full hashes.

Cleanup protections:

- The default recommendation keeps the copy with the shortest full path. You can change it before cleanup; each group must retain at least one copy.
- Before acting, recheck the selected file and at least one retained copy for identity, size, modification time and full content. A changed target or lack of a verified retained copy prevents recycling.
- Recycle only confirmed paths. Recycling HTML does not include unselected associated resource folders; there is no permanent-delete option.
- Scanning and cleanup run locally. File paths and contents are not uploaded.
- Closing the native window during scanning or cleanup is blocked with a stop-first notice. Normal close is available after the result returns.

A command error means the cleanup result could not be confirmed, not that no files were processed. The UI keeps the actual error and does not retry automatically. Recycled capacity is an estimate; moving files to the Recycle Bin does not immediately free that space. See the [cleanup and session contract](docs/CLEANUP_CONTRACT.md).

Single-file cleanup distinguishes reported failures and known pre-operation refusals from uncertain outcomes. An uncertain result keeps the actual error and offers a return to inspect file state rather than direct resubmission.

## Limitations

Usage limits:

- No similarity matching for images, videos or other near-duplicate content. Empty files, symbolic links and Windows reparse points are not scanned as duplicate candidates.
- One root folder per scan; no combined multi-root scan or custom exclusions yet.
- Shell paths reaching 260 UTF-16 units are flagged before confirmation and rejected during cleanup. Choices and estimates remain unchanged; confirmation states when estimates include affected selected files. Shorten the path and rescan; Recycle Bin recovery for those paths has not been verified.
- Review is paged, but search still examines the full session; response depends on data size and hardware. The repository's rendering benchmark uses a synthetic review component, not the full app, disk scanning or a typical-hardware guarantee.
- Network shares, removable media, the full installation lifecycle and real screen-reader behavior have not completed validation. Local checks do not establish support for these cases.

Guijian cannot determine a file's value to you. Keep independent backups of important data.

## Development

Building from source requires Node.js 24.12.0, pnpm 12.8.1, Rust 1.97.0, Microsoft C++ Build Tools and WebView2 Runtime. Versions are pinned in `desktop/.node-version`, `desktop/package.json` and `desktop/src-tauri/rust-toolchain.toml`.

Start from the repository root:

```powershell
cd desktop
pnpm install --frozen-lockfile
pnpm tauri dev
```

Dependency installation changes the environment; development starts a native GUI.

Build the NSIS installer from the repository root:

```powershell
cd desktop
pnpm tauri build
```

Output goes to `desktop/src-tauri/target/release/bundle/nsis/`.

For local verification or CI handoff, retain the installer with checksums, source fingerprints and actual check records using [candidate evidence](docs/CANDIDATE_EVIDENCE.md). CI candidates are retained for a requested 14 days; they are not published releases or proof of installation validation.

Start routine checks from the repository root:

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

[Windows CI](.github/workflows/ci.yml) includes routine checks and an NSIS build; it does not publish installers.

<details>
<summary>Real Windows checks and rendering benchmark</summary>

Run each block separately from the repository root:

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

The first two check types recycle their own synthetic files; the benchmark starts isolated Edge. Each block starts at the repository root, not in the previous block's working directory.

Ordinary `cargo test` skips the real Recycle Bin checks. Explicit checks cover ordinary recycling, an occupied file, HTML resource isolation and long-path rejection. Samples stay in the Recycle Bin; it is never emptied by these tests. The manual [Windows release validation](.github/workflows/release-validation.yml) runs the Shell checks on a disposable Windows runner without uploading or publishing an installer.

Native checks first require the NSIS build above to produce `desktop/src-tauri/target/release/guijian-desktop.exe`. They cover real WebView2 / Tauri commands, events, stopping, remaining sessions and window close, rather than the full system folder-picker interaction. The rendering benchmark requires frontend dependencies and installed Edge, uses a production build and synthetic state, and excludes backend IPC. The single-cleanup check uses the production App with a synthetic API to verify uncertain results and keyboard access; it does not recycle files or inject real IPC faults. Avoid concurrent builds or tests while sampling. Scripts write assertion or source-fingerprint reports under `desktop/src-tauri/target/output/`.

The accessibility check only reads the initial native window's UIA controls, layout and actual DPI; it does not exercise keyboard input, screen-reader speech or the cleanup flow.

</details>

Technical documentation: the desktop app uses Tauri 2, React, TypeScript and Rust. See [product scope](docs/PRODUCT.md), [design system](docs/DESIGN.md), [cleanup and session contract](docs/CLEANUP_CONTRACT.md), [native accessibility checks](docs/ACCESSIBILITY_VALIDATION.md), and [isolated installation checks](docs/INSTALLATION_VALIDATION.md).

## License

Guijian is released under the [MIT License](LICENSE).

## Credits

[WxCleaner](https://github.com/yqxie1991/WxCleaner) inspired the initial idea of organizing files received through WeChat, which Guijian extended to duplicate-file organization in arbitrary folders.

<p align="center"><sub>If Guijian helps you, a ⭐ can help others discover it.</sub></p>
