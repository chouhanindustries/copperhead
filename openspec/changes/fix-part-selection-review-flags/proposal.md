# fix-part-selection-review-flags: Proposal

## Why

Stage 3 tells the agent to flag every newly selected MPN as `UNVERIFIED`, matching the repository safety rule that Copperhead does not claim to have verified a datasheet. Its completion predicate required at least one MPN that did not start with `UNVERIFIED`. A model that followed the prompt could therefore finish a valid BOM but remain stuck, while deleting the review marker was enough to make the stage pass. Issue #133 records this loophole.

The inverse rule would break resume compatibility: an existing concrete MPN may no longer carry the marker after a human reviews it. Such a BOM must not become incomplete merely because the review happened.

## What Changes

- Stage-3 completion reads canonical BOM tables through the shared Markdown-table parser and resolves the MPN column by its header.
- A concrete selected MPN completes the stage with or without an `UNVERIFIED` marker. Bare markers, empty cells, and placeholder values do not count.
- The stage prompt gives new selections the explicit form `UNVERIFIED: <concrete MPN>` and says that a bare marker is only a scaffold placeholder.
- Focused tests cover new flagged selections, previously reviewed unflagged selections, and the incomplete placeholder/header-only cases.

## Capabilities

### Modified Capabilities

- `create-pipeline`: stage 3 gains a completion contract that distinguishes a selected MPN from the `init` placeholder without treating removal of the review marker as proof of selection.

## Impact

- **Code**: `src/commands/create.ts` changes only the part-selection completion predicate and its prompt text.
- **Tests**: `test/stage-completion.test.ts` covers both resumable concrete-MPN forms and the false-positive cases.
- **Specification**: `openspec/specs/SPEC.md` documents the review-marker and resume behavior.
- **Unchanged contracts**: no network or datasheet lookup is added; the gate proves that an MPN was selected, not that the MPN or its datasheet was verified.
