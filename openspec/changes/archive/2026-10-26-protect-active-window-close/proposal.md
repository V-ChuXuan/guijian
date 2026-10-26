## Why

Real native validation showed that closing the window during cleanup exited before its report returned. The user needs the completed-item report and remaining selections before leaving.

## What Changes

- Reject native window close while Rust owns an active scan or cleanup, including a pending stop.
- Emit `operation-close-blocked` without business payload; display the existing stop-before-close message.
- Preserve normal idle close and explicit cancellation commands.

## Capabilities

### New Capabilities
- `active-window-close`: Native close protection during file operations.

### Modified Capabilities
None.

## Impact

Tauri window handler, AppState query, DesktopApi subscription and React notice. No new dependencies, automatic cancellation, persistence or installation changes. Task state and evidence belong to root Trellis task `10-26-guijian-native-validation`.
