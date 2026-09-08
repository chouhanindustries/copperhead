# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Stage 3 completion recognizes concrete MPN selections

The part-selection stage SHALL be complete only when a canonical `docs/BOM.md` table contains at least one data row whose MPN cell names a concrete selected part. The completion predicate SHALL locate the MPN column by its header and SHALL ignore table headers, separator rows, non-canonical supporting tables, and empty tables.

For a new model-authored selection, the stage prompt SHALL require the form `UNVERIFIED: <concrete MPN>` with a datasheet-verifiable justification. The completion predicate SHALL recognize that flagged form by removing the review marker and testing the remaining selection. It SHALL also recognize an existing concrete MPN without the marker, because a human may clear `UNVERIFIED` after review and the completed stage must remain resumable.

A blank cell, bare `UNVERIFIED`, or an explicit placeholder such as `TBD`, `TODO`, `UNKNOWN`, `N/A`, `NONE`, or question marks SHALL NOT count as a selected MPN. Adding or deleting the marker without adding a concrete selection therefore cannot make an untouched scaffold pass.

This is a content-shape gate only. Passing it SHALL NOT be reported as datasheet, pricing, availability, or manufacturer verification.

#### Scenario: New flagged selection completes stage 3

- **WHEN** the canonical BOM contains `UNVERIFIED: RC0603FR-0710KL` in its MPN column
- **THEN** the MPN is recognized as a concrete selection and can satisfy the stage-3 completion predicate

#### Scenario: Human-reviewed selection remains resumable

- **WHEN** the canonical BOM contains `RC0603FR-0710KL` after a human clears its review marker
- **THEN** the MPN remains a concrete selection and stage 3 does not become incomplete solely because the marker was removed

#### Scenario: Bare review marker is still a placeholder

- **WHEN** every BOM data row has an empty MPN cell or the bare value `UNVERIFIED`
- **THEN** stage 3 remains incomplete

#### Scenario: Header and separator do not masquerade as a part

- **WHEN** the canonical BOM contains only its header and separator rows
- **THEN** stage 3 remains incomplete

#### Scenario: Named placeholder is not a selection

- **WHEN** the only MPN value is `UNVERIFIED: TBD`
- **THEN** stage 3 remains incomplete
