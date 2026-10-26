## Why

Single-file cleanup treats unclassified request failures like ordinary failed items, re-enabling submission when the result might be unknown. Candidate installers also lack retained checksums and source/verification identities.

## What Changes

- Separate trusted item failures and known pre-operation refusals from uncertain single-file outcomes, preserving actual errors and keyboard access without direct resubmission.
- Package an explicit NSIS installer with SHA256SUMS, source revision/dirty fingerprints and supplied verification records.
- Retain candidates as pinned-action CI artifacts for 14 days, without publishing releases or increasing content permissions.

## Capabilities

### New Capabilities
- `candidate-evidence`: Explicit uncertain single-file outcomes and traceable installer candidates.

### Modified Capabilities
None.

## Impact

Frontend dialog/App, tests, a small Node tool, CI artifact step and documentation. No Rust/IPC or runtime dependencies. Root task `10-26-guijian-candidate-evidence` owns execution state.
