# agent-core — Delta Spec

## ADDED Requirements

### Requirement: Project edits preserve verification policy

Before writing an anchored edit to a valid `.kicad_pro`, copperhead SHALL compare the candidate JSON with the current project and refuse a change that weakens represented verification policy. It SHALL refuse a new non-error rule severity, a reduction or unsafe removal of an existing severity, a reduction or removal of an existing numeric clearance, or an added verification exclusion.

The comparison SHALL occur before the file is written. Existing ignores MAY remain unchanged; severity tightening and removal of ignores or exclusions SHALL be allowed. Unrelated valid edits SHALL remain allowed, and a valid repair of an already-invalid project SHALL not be blocked for lacking a comparable baseline.

#### Scenario: DRC findings cannot be hidden with project severities

- **WHEN** an agent edit would add `ignore` severities for hole clearance or unconnected items
- **THEN** copperhead refuses the edit before writing the project file
- **AND** does not mark the project as touched

#### Scenario: Existing bootstrap policy remains usable

- **WHEN** a project contains existing ignored ERC link checks and an edit changes unrelated valid metadata
- **THEN** the edit succeeds without requiring those existing ignores to change

#### Scenario: Verification settings can become stricter

- **WHEN** an edit raises an existing severity, raises an existing clearance, or removes an ignore or exclusion
- **THEN** the edit is allowed

#### Scenario: Invalid project output is refused atomically

- **WHEN** an edit to a valid project would produce invalid JSON
- **THEN** copperhead refuses the edit and preserves the original bytes
