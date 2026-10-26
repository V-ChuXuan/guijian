## Why

Review groups are bounded, but cleanup receipts and collapsed scan diagnostics still generate every record. Current source output with 10,000 records contains 10,000 receipt rows or hidden diagnostic rows. Users also learn about the known Shell long-path limit only after confirming cleanup.

## What Changes

- Page cleanup records and expanded scan issues in ranges of at most 50, preserving complete statistics, filters, paths and actions.
- Do not mount scan issue details while collapsed; support diagnostics even without duplicate groups.
- Preview the existing normalized Shell path limit before cleanup, with accessible row and confirmation notices. Keep selections, estimates and final Rust checks unchanged; disclose estimates include affected selected files.
- Validate reachable records, keyboard focus, boundary behavior and real production component display counts.

## Capabilities

### New Capabilities
- `result-diagnostics`: Bounded result and diagnostic display with advisory path-limit notices.

### Modified Capabilities
None.

## Impact

Frontend components, tests, shared local pagination, existing benchmark modes and usage contracts. No new dependencies, backend commands or cleanup permissions. Root task `10-26-guijian-result-diagnostics` owns execution state.
