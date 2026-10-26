## Purpose

Keep large duplicate-file review responsive through bounded display while preserving full-session cleanup decisions and keyboard access.

## ADDED Requirements

### Requirement: Bound review rendering while preserving all results
The review view SHALL display at most 50 filtered groups per page and at most 50 files per expanded group. It SHALL provide group and file page controls only when their result range needs multiple pages. Every matching group and file SHALL remain reachable.

#### Scenario: Many duplicate groups
- **WHEN** a scan has more than 50 matching groups
- **THEN** only the current group page is mounted and controls identify its range and allow reaching other pages

#### Scenario: A large duplicate group
- **WHEN** an expanded group contains more than 50 files
- **THEN** only its current file page is mounted and the other files remain reachable through file page controls

### Requirement: Keep decisions and filters independent of pagination
Pagination SHALL change display only. Search and pending filters SHALL evaluate the complete session. Changing a filter SHALL reset the group page to the first page. A shortened result range SHALL not leave the view on a nonexistent page. Cleanup summaries, last-keeper protection, keep-group and restore-recommendations SHALL retain their existing complete-session or complete-group scope.

#### Scenario: Select files across pages
- **WHEN** the user changes choices and moves between group or file pages
- **THEN** choices persist and cleanup totals include selected files on hidden pages

#### Scenario: Search for an off-page file
- **WHEN** a search matches a file outside the current page
- **THEN** its group is reachable in the filtered results, the group's file page initially shows the first matching file, and no selection changes occur

#### Scenario: Browse after a search
- **WHEN** the user changes a group's file page after its search result appears
- **THEN** manual file-page navigation remains available without changing the search or choices

#### Scenario: The final page shrinks
- **WHEN** a session update or filter reduces the available pages
- **THEN** the view displays a valid page and no manual choices are reset

### Requirement: Preserve keyboard and single-scroll behavior
Page controls SHALL have accessible group/file names and range information. Changing a page SHALL not leave keyboard focus on an unmounted element. The review SHALL keep its existing single vertical scrolling region, row-menu focus return and readable relative-path descriptions.

#### Scenario: Keyboard page change
- **WHEN** the user activates page navigation with the keyboard
- **THEN** focus remains on a connected, reachable control or the new page content, and ordinary keyboard navigation can continue
