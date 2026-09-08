# fix-part-selection-review-flags: Design

## Context

The part-selection stage uses a lightweight repository-state predicate so `create` can resume after a completed stage. `init` seeds BOM rows with the literal MPN placeholder `UNVERIFIED`, while the stage prompt requires new selections to retain that same word as a human-review flag. The previous predicate conflated the flag with the placeholder by rejecting every MPN beginning with it.

The repository already has a shared canonical Markdown-table parser in `src/memory/bom-table.ts`. Using it avoids treating table headers, separators, supporting tables, or pipe-bearing prose as selected parts.

## Goals / Non-Goals

**Goals:**

- Let a newly selected and honestly flagged MPN complete stage 3.
- Keep an existing concrete MPN resumable after a human clears the review flag.
- Ensure deleting or retaining a bare marker cannot turn an empty selection into a passing one.
- Read only the canonical BOM table and locate the MPN column by name.

**Non-Goals:**

- No datasheet, pricing, availability, or manufacturer verification.
- No part-research tools or network access.
- No claim that every BOM row is correct merely because the shape gate passes.

## Decisions

- **D1: Test the selection after removing the review marker.** The predicate strips `UNVERIFIED` and surrounding punctuation, then requires meaningful remaining text. Thus both `UNVERIFIED: RC0603FR-0710KL` and `RC0603FR-0710KL` represent the same concrete selection, while bare `UNVERIFIED` represents none.
- **D2: Preserve reviewed BOMs.** The marker is required by the prompt for new model-authored selections, but not by the resume predicate. Humans may clear the flag after review, and repository-state inference must preserve that legitimate state.
- **D3: Reject explicit placeholders syntactically.** `TBD`, `TODO`, `UNKNOWN`, `N/A`, `NONE`, and question-mark-only values do not count after marker removal. This remains a shape check and makes no semantic claim about other text.
- **D4: Reuse canonical table parsing.** `parseCanonicalTables` identifies the BOM table and excludes headers and separators. The predicate finds the `MPN` column from the header instead of assuming a fixed split offset.

## Risks / Trade-offs

- A syntactically concrete but invented MPN can still pass. This is intentional for this change: verification needs grounded part-research data and belongs to the separate part-research work.
- Requiring every BOM row to carry a concrete MPN would broaden the existing completion contract and could strand valid resumed repositories. This change retains the prior at-least-one-selection threshold while fixing how that selection is recognized.

## Migration Plan

No migration is needed. Existing reviewed BOMs continue to complete, newly flagged concrete selections begin completing, and untouched `init` placeholders remain incomplete.
