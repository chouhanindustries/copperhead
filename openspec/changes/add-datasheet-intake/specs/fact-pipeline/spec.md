# Delta Spec: fact-pipeline

## ADDED Requirements

### Requirement: Fact typing and unit normalization
The system SHALL map raw Extract fields to canonical predicate keys with normalized units, as pure functions with no I/O.

#### Scenario: Milliamp leakage normalized to microamps (AC-2.1)
- **WHEN** the raw field "Input leakage current = 0.033 mA" is normalized
- **THEN** the resulting fact is `{ key: "pin_input_leakage_uA", value: 33, unit: "uA" }`

#### Scenario: Unconsumed fields are stored without crashing (AC-2.2)
- **WHEN** Extract returns a field that no registry constraint consumes
- **THEN** the fact is stored but not required for any verdict, and evaluation does not crash

### Requirement: Provenance on every fact
Every `ExtractedFact` SHALL carry a `SourceRef` with `source.page` set. A fact used in a verdict without a bounding box SHALL be downgraded to `hold`. The type system SHALL make a trusted fact without a bounding box unrepresentable.

#### Scenario: Missing bbox downgrades to hold (AC-3.1)
- **WHEN** a fact used in a verdict has `source.page` but no `bbox`
- **THEN** the fact's status is `hold`

### Requirement: Confidence gating
The system SHALL derive fact status from Sarvam's per-field confidence using `CONFIDENCE_THRESHOLD = 0.75`: any fact below the threshold, or flagged by a datasheet footnote qualifier, gets `status: "hold"`.

#### Scenario: Low confidence becomes hold (AC-4.1)
- **WHEN** a fact has `confidence < 0.75`
- **THEN** its derived `status` is `"hold"`

#### Scenario: Footnote qualifier becomes hold
- **WHEN** an extracted value is flagged by a datasheet footnote qualifier
- **THEN** its derived `status` is `"hold"` regardless of confidence

### Requirement: Provenance stitching
The system SHALL join Extract fields to Digitise regions by field label, then by value-plus-unit match within the page; a field with no matching region SHALL be constructed as a held fact.

#### Scenario: No matching Digitise region
- **WHEN** an Extract field cannot be matched to any Digitise bounding box on its page
- **THEN** the fact is created with `status: "hold"` and no `bbox`
