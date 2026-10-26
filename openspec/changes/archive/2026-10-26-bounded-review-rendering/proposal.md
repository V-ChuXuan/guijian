## Why

The production review component benchmark with 10,000 groups and 20,000 files still takes about 10.72 seconds to expand all and 2.29 seconds to update a selection, mounting 570,033 DOM elements. The review UI needs bounded rendering without changing authoritative cleanup selections.

## What Changes

- Display at most 50 matching groups per page and at most 50 files in each expanded group.
- Keep search, pending filters, group decisions and cleanup scoped to the full session.
- Preserve standard keyboard navigation, path descriptions and explicit group/file paging ranges.
- Validate real production component response and mounted counts, distinguishing current-page readiness from the old full-DOM workload.

## Capabilities

### New Capabilities
- `bounded-review`: Paginated review rendering with session-wide decisions.

### Modified Capabilities
None.

## Impact

Frontend review components, their tests and benchmark assertions, plus product/design documentation. No new dependencies or backend commands. Root Trellis task `10-26-guijian-review-scale` owns implementation state and verification records.
