# Delta Spec: intake-ui

## ADDED Requirements

### Requirement: Click-to-source highlighting
The UI SHALL render each fact with its provenance; clicking a fact with a `bbox` SHALL scroll the datasheet view to `source.page` and highlight the `bbox` region.

#### Scenario: Click a sourced fact (AC-10.1)
- **WHEN** the user clicks a rendered fact that has a `bbox`
- **THEN** the datasheet image scrolls to `source.page` and highlights the `bbox` region

### Requirement: HOLD facts are visually distinct
The UI SHALL render HOLD facts visually distinct from trusted facts and labeled for review.

#### Scenario: Hold fact rendering (AC-10.2)
- **WHEN** a HOLD fact is rendered
- **THEN** it is visually distinct (for example amber) and labeled "review"

### Requirement: Refusal citations visible without extra clicks
When a REFUSE verdict is rendered, both the cited datasheet line and the cited rule line SHALL be visible to the user without additional clicks.

#### Scenario: Refusal shows both citations (AC-7.2)
- **WHEN** a REFUSE verdict is rendered
- **THEN** the datasheet line and the rule line are both visible without extra clicks

### Requirement: Structured change entry
The UI SHALL let the user describe a proposed change through structured input that produces a typed change descriptor, and SHALL display the descriptor that was evaluated alongside the verdict.

#### Scenario: Change entry to verdict
- **WHEN** the user submits a proposed change through the structured form
- **THEN** the system evaluates the resulting change descriptor and displays the verdict with the descriptor that was evaluated
