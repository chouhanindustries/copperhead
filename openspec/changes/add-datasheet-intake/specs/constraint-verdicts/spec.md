# Delta Spec: constraint-verdicts

## ADDED Requirements

### Requirement: Constraint registry loading
The system SHALL load a `constraints.json` registry containing the board's constraints (`budget_sum`, `max`, `min`, `equality`), each with an id, human description, limit, unit, affected fact keys, and source.

#### Scenario: Valid registry parses (AC-5.1)
- **WHEN** `constraints.json` is loaded
- **THEN** at least one `budget_sum` constraint (sleep current, limit 25, unit "uA") and one `max` constraint (rail voltage) parse into `Constraint[]`

#### Scenario: Malformed registry fails closed (AC-5.2)
- **WHEN** a malformed constraints file is loaded
- **THEN** the system reports the error and refuses to evaluate; it never approves by default

### Requirement: Deterministic fail-closed verdict engine
The system SHALL evaluate a structured change descriptor against facts and constraints as a pure function (no I/O, no clock, no randomness, no LLM) producing a `Verdict` with `decision`, `reason`, `citedFact`, `citedConstraint`, and `computed`. A HOLD fact SHALL never produce an APPROVE or REFUSE.

#### Scenario: Budget refusal (AC-6.1)
- **WHEN** the change "add 100k pull-up" contributing 33 uA is evaluated against a 25 uA `budget_sum`
- **THEN** `decision === "REFUSE"`, `computed` shows 33 > 25 uA, `citedFact` is the leakage fact, and `citedConstraint` is the sleep budget

#### Scenario: Abs-max refusal (AC-6.2)
- **WHEN** a part whose `abs_max_vin_V` is below the rail `max` constraint is evaluated for a drive-from-rail change
- **THEN** `decision === "REFUSE"` citing both the datasheet fact and the rule

#### Scenario: Approval within constraints (AC-6.3)
- **WHEN** a change within all constraints with all trusted facts is evaluated
- **THEN** `decision === "APPROVE"`

#### Scenario: Determinism (AC-6.4)
- **WHEN** identical inputs are evaluated 3 times
- **THEN** the verdict is identical each time

#### Scenario: HOLD fact forces HOLD verdict (AC-4.2)
- **WHEN** a HOLD fact is the deciding input for a change
- **THEN** the verdict `decision === "HOLD"` and `reason` names the exact field to re-check; no APPROVE or REFUSE is emitted

#### Scenario: Missing required fact forces HOLD
- **WHEN** a constraint's affected fact key has no stored fact at evaluation time
- **THEN** the verdict is HOLD naming the missing field

### Requirement: Cited refusal with proposed fix
A REFUSE verdict SHALL carry a one-sentence engineer-grade `reason` naming the measured value, the limit, and the deviation, plus a specific `proposedFix`.

#### Scenario: Refusal content (AC-7.1)
- **WHEN** a REFUSE verdict is rendered
- **THEN** `reason` names the measured value, the limit, and the deviation in one sentence, and `proposedFix` is present and specific (for example, use the MCU internal pull-up)

### Requirement: Verification manifest export
The system SHALL export, for any completed verdict, a `VerificationManifest` JSON containing the timestamp (injected by the caller, never `Date.now()` in shared code paths), part, change, `checksRun`, `factsUsed` with sources, the `verdict`, and the Sarvam model ids.

#### Scenario: Manifest download (AC-11.1)
- **WHEN** the user exports after any completed verdict
- **THEN** a `VerificationManifest` JSON downloads containing `checksRun`, `factsUsed` with sources, the `verdict`, and the Sarvam model ids

#### Scenario: Manifest reproducibility
- **WHEN** the engine is re-run on the facts, constraints, and change stored in a manifest
- **THEN** it produces a verdict identical to the manifest's verdict
