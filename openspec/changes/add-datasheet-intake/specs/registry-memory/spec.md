# Delta Spec: registry-memory

## ADDED Requirements

### Requirement: Trusted fact persistence
When a verdict is APPROVE or REFUSE, the system SHALL write the trusted facts used to the registry (`constraints.json`) with value, confidence, and source, using an atomic write (temp file then rename) so a crashed write cannot corrupt the registry.

#### Scenario: Facts persisted after a verdict (AC-8.1)
- **WHEN** a part's evaluation completes with APPROVE or REFUSE
- **THEN** the trusted facts are written to `constraints.json` with value, confidence, and source

### Requirement: Fact reuse without re-extraction
For a subsequent change on a part whose facts are already stored, the system SHALL reuse the stored facts and SHALL NOT re-call Sarvam for facts already present.

#### Scenario: Second change on the same part (AC-8.2)
- **WHEN** a second change on the same part is evaluated
- **THEN** the system reuses stored facts and makes no new Sarvam extraction call

### Requirement: Correction propagation
When a user corrects a mis-read fact value, the system SHALL save the correction, recompute the affected verdict live, and update the manifest, without any re-extraction.

#### Scenario: Corrected fact recomputes verdict (AC-9.1)
- **WHEN** a user corrects a mis-read fact value and saves
- **THEN** the affected verdict recomputes live and the manifest updates, with no full re-extraction
