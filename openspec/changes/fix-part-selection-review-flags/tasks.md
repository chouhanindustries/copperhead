# fix-part-selection-review-flags: Tasks

## 1. Part-selection completion predicate

- [x] 1.1 Parse canonical BOM tables with the shared table parser and resolve the MPN column by header name
- [x] 1.2 Recognize concrete MPN text with or without the `UNVERIFIED` review marker
- [x] 1.3 Reject blank cells, bare review markers, and explicit placeholder values
- [x] 1.4 Keep the stage prompt honest by requiring `UNVERIFIED: <concrete MPN>` for new selections

## 2. Regression coverage

- [x] 2.1 Prove a flagged concrete MPN completes the stage
- [x] 2.2 Prove an existing human-reviewed unflagged MPN remains complete
- [x] 2.3 Prove empty/header-only tables, bare markers, and `UNVERIFIED: TBD` remain incomplete

## 3. Specification and validation

- [x] 3.1 Clarify the selection-versus-verification contract in the source specification
- [x] 3.2 Run focused stage-completion tests, the full test suite, typecheck, and OpenSpec validation
