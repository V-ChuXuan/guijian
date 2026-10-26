# 归简

## Purpose

Windows 10/11 exact-duplicate file organizer. Find nonempty files with identical
content, let users review retained copies, and recycle only confirmed duplicates.

## Documentation and Branches

- Chinese comes first: `README.md` is the complete Chinese homepage and
  `README.en.md` is the complete English version. Put the Chinese language link
  before English; keep `README.zh-CN.md` as a short compatibility entry.
- Keep `main` as this project's only branch unless the user explicitly requests
  another branch. This convention does not authorize commits or pushes.

## Code Map and Stack

- `desktop/src-tauri`: Rust 1.97.0 and Tauri 2; manifests and lockfile in this directory.
- `desktop/src`: React 19 and TypeScript; `desktop/package.json` and `pnpm-lock.yaml`.
- Node 24.12.0 and pnpm 12.8.1 are fixed by project configuration.
- Read `docs/PRODUCT.md`, `docs/DESIGN.md` and `docs/CLEANUP_CONTRACT.md`
  for product, UI and cleanup contracts.

## Development Workflow

Use root Trellis and native implementation/check subagents with assigned files.
Write regressions before refactoring. Preserve the existing stack and dependencies.

Understand the affected flow before editing, reuse existing patterns, keep changes
surgical and define observable acceptance. Resolve facts by inspection; ask for
material product decisions. Preserve unrelated edits and existing error handling.

## Complexity Budget

- Do not silently expand scope for theoretical robustness.
- Before adding complexity for a speculative race condition or security edge
  case, explain the concrete failure mode, evidence of likelihood (or uncertainty),
  and implementation/maintenance cost; obtain user buy-in.
- If the extra protection is unnecessary for the agreed scope, omit it and
  continue the requested work.
- This does not waive required input validation, access control, data-integrity
  safeguards, or fixes for demonstrated failures.

## Commit Attribution

- Preserve the project's commit convention. For Conventional Commits, use
  `type(scope): [AI] description` when AI materially authored or modified content
  included in the commit.
- Drafting only the commit message does not require the marker.
- The marker records AI involvement, not review or verification status.
- Do not invent tool/model attribution or co-author identities.
- Commit attribution does not grant permission to commit or push.

## Frontend Consistency

- Before UI work, read `DESIGN.md` at the workspace root
  (`E:/Git_Code/pardo_item/DESIGN.md`). Follow the project's existing design system
  and more specific UI rules first.
- Reuse existing components, design tokens, and approved dependencies. Prefer
  mature libraries over custom implementations of complex behavior.
- Prefer UI components whose source can be inspected and adapted locally;
  preserve accessibility and upstream license requirements.
- Keep one coherent design language. Do not add overlapping libraries without
  a concrete gap and approval.

### Reference Stack — Examples for React Projects

- UI components and visual style: shadcn/ui with Nova styling.
- Icons: Lucide.
- Animation: Motion.
- Resizable panel layouts: react-resizable-panels.
- Drag and drop: dnd-kit.
- Shared client state: Zustand.

Use these examples as a starting point when the project has no established
choice. Follow the existing project stack first; do not automatically install
every example or migrate existing code to match this list. Use native layout
and local component state when sufficient. Before adopting a library, check
compatibility with the project's framework and installed versions.

## Verification

From `desktop`: `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm build`.
From `desktop/src-tauri`: `cargo fmt --check`,
`cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`.
Dependency downloads are allowed. Tests use synthetic temporary files and fake
trash ports. Do not recycle actual user files for verification.

Run the smallest relevant checks and report observed results and gaps.

## Domain and Data Constraints

- Exact nonempty content only; preserve full SHA-256 and file identity checks.
- Keep at least one verified copy; recycle only approved paths, never permanently delete.
- Preserve manual decisions and disclose incomplete scans.
- Keep the compact accessible Windows design and existing keyboard behavior.

## Workspace Integration

- Project rules own development methods, technical constraints and verification.
  Root AGENTS.md governs folder orchestration, cross-project actions, shared
  resources and safety. See root docs/adr/0006-workspace-project-handoff.md.
- Root Trellis alone owns task lifecycle, execution permission and owned paths.
  Keep task artifacts/history there; never initialize project-local .trellis/ or
  copy its managed block. Use absolute root script paths from this directory.
- Before writes, confirm this project, applicable nested instructions, execution
  directory and task scope. A command workdir does not relocate a session or prove
  that instructions reloaded. Verify actual host state separately.
- Keep runtime state project-local where the host supports it; ignore .omx/ in Git.
  Preserve user pauses, host permissions and external/destructive authorization.

## Project Authorization

User authorized local refactoring. No automatic commit, push, publication,
project moves or modification of unrelated data. Preserve existing local edits.
