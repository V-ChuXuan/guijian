# candidate-evidence Specification

## Purpose
Communicate uncertain single-file outcomes honestly and associate candidates with source identities, checksums and observed verification records.

## Requirements

### Requirement: Distinguish unknown single-file outcomes
The single-file flow SHALL distinguish trusted failed-item reports and known pre-operation rejections from internal or unclassified request errors. Unknown outcomes SHALL preserve the actual error, state that cleanup could not be confirmed and instruct users to inspect file state. The dialog SHALL NOT claim that cleanup never started, automatically retry or directly resubmit the same target.

#### Scenario: Execution succeeds but its response fails
- **WHEN** the request rejects without a trustworthy result
- **THEN** the dialog displays uncertainty and a return-to-inspection action instead of direct recycling

#### Scenario: Trusted failure
- **WHEN** a known pre-operation refusal or failed-item report is received
- **THEN** the specific failure remains visible and any returned session is preserved without misclassifying the result as unknown

### Requirement: Preserve decisions and keyboard access
Unknown outcomes SHALL NOT fabricate reports, reset manual choices or automatically rescan. Keyboard users SHALL have a reachable close action after pending ends. Closing and opening a new target SHALL reset local uncertainty state.

#### Scenario: Return to review
- **WHEN** a user closes the uncertain dialog
- **THEN** existing choices remain and keyboard focus returns to a usable review entry

### Requirement: Package explicit candidate evidence
A candidate directory SHALL include the specified installer and SHA-256 checksum, source revision/dirty/file fingerprints and supplied verification records. Missing or invalid required inputs SHALL fail generation, and existing output directories SHALL NOT be overwritten. Evidence SHALL distinguish observed checks from unexecuted checks and SHALL NOT infer passed checks from an installer existing.

#### Scenario: Dirty local source
- **WHEN** a local candidate is generated
- **THEN** the installer digest and actual source identity including uncommitted file fingerprints are recorded alongside explicit checks

#### Scenario: Missing inputs
- **WHEN** an installer or verification input is missing or invalid
- **THEN** generation fails without reporting successful verification

### Requirement: Retain CI candidates without publishing
After the existing checks and NSIS build succeed, CI SHALL generate candidate evidence tied to the workflow revision/run/attempt and actual check outcomes. A pinned official artifact action SHALL request 14-day retention and fail on missing files. This job SHALL NOT claim separate native, Shell or installation checks ran, publish releases or increase repository content permissions.

#### Scenario: CI candidate
- **WHEN** the job successfully builds its installer
- **THEN** the candidate and evidence are retained together for that run without treating them as a published release
