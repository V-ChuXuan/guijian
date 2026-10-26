## Purpose

Keep cleanup outcomes and scan diagnostics reachable at large scales, and disclose known path limits before confirmation without changing authoritative cleanup decisions.

## ADDED Requirements

### Requirement: Bound cleanup outcome display
The result view SHALL mount at most 50 matching cleanup records per page. Outcome counters and filters SHALL apply to the complete report. Every record SHALL remain reachable with its complete path, reason and existing path actions. Recycled files SHALL not gain a reveal action. Changing a filter or receiving a new report SHALL start at the first page; shrinking a result range SHALL leave a valid page.

#### Scenario: Many successful results
- **WHEN** a report contains more than 50 moved files
- **THEN** the result view shows a bounded page and complete counts, with later paths reachable by pagination

#### Scenario: Filter results
- **WHEN** a user changes between unprocessed, moved and all records
- **THEN** the page resets and filtering considers every report item without changing the report

### Requirement: Lazily display bounded scan diagnostics
The scan issue summary SHALL show the complete count even without duplicate groups. Collapsed diagnostics SHALL not mount issue detail rows. Expanded diagnostics SHALL mount at most 50 issue rows per page, preserving every path and reason.

#### Scenario: Expand and close many diagnostics
- **WHEN** a user expands a summary with more than 50 issues and later closes it
- **THEN** all issue pages are reachable while expanded and detail rows are unmounted while closed

### Requirement: Preserve accessible navigation and display scope
Record and diagnostic pagination SHALL expose distinct names and range units, support keyboard activation and leave focus on a connected usable element after content changes. The views SHALL preserve their single content scrolling region and avoid extra controls for single-page data.

#### Scenario: Change a page by keyboard
- **WHEN** a user activates a record or diagnostic page control
- **THEN** the new range is displayed and keyboard navigation can continue from a reachable focus target

### Requirement: Preview the existing Shell path limit
The UI SHALL warn on review rows and single-file confirmation when a normalized Shell path has at least 260 UTF-16 units, matching the existing two extended-path prefix conversions. Batch confirmation SHALL count affected selected files across the complete session and state that the estimate includes them. These notices SHALL NOT change selections, counters, estimated bytes, cleanup authorization or final backend checks, and a missing notice SHALL NOT guarantee successful recycling.

#### Scenario: Boundary and extended paths
- **WHEN** normalized paths have 259 or 260 UTF-16 units, including extended drive and UNC paths or non-BMP characters
- **THEN** only paths at or above the existing limit receive the long-path notice

#### Scenario: Affected files outside the displayed page
- **WHEN** selected affected paths exist on hidden review pages
- **THEN** batch confirmation counts them while preserving the original choices and explaining the estimate scope
