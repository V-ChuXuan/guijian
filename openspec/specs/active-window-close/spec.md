# active-window-close Specification

## Purpose
Preserve the active scan or cleanup and its final report when the user closes the native window, while allowing normal exit after the operation finishes.

## Requirements

### Requirement: Protect active operations from native window close
The application SHALL prevent CloseRequested while Rust AppState owns an active scan or cleanup. A stop request SHALL NOT release this protection before operation completion or abandonment.

#### Scenario: Close during cleanup
- **WHEN** the native window receives a close request during cleanup
- **THEN** the process remains open, the operation is unchanged and its final report can return

#### Scenario: Stop is pending
- **WHEN** the user requests stop and the operation has not completed
- **THEN** native close remains blocked

#### Scenario: Idle close
- **WHEN** no scan or cleanup is active and the native window receives a close request
- **THEN** normal close behavior is allowed

### Requirement: Explain blocked close without changing the operation
The backend SHALL emit `operation-close-blocked` with no business payload on blocked close. DesktopApi SHALL expose `subscribeCloseBlocked(listener: () => void): Promise<Unlisten>`. React SHALL display the existing stop-before-close message and release its subscription on unmount. Neither this event nor its handler SHALL automatically cancel or exit.

#### Scenario: Notice received
- **WHEN** React receives the blocked-close event
- **THEN** it displays `操作进行中，请先停止后再关闭窗口` without changing the session or operation

#### Scenario: Notice subscription fails
- **WHEN** subscribing to the event rejects
- **THEN** React handles the error with a notice-unavailable message and backend protection remains active
