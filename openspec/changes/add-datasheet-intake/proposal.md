# Proposal: add-datasheet-intake

## Why

Copperhead can edit and verify boards, but it has no way to justify a change against the component's own documentation: the datasheet. Engineers today read PDFs by hand and carry budgets in their heads, which is exactly how bad pull-ups, blown abs-max ratings, and busted sleep budgets reach fabrication. This change adds a datasheet intake and verdict surface: point it at a component datasheet plus a proposed board change, and it returns APPROVE / REFUSE / HOLD with the exact datasheet line and the exact rule line cited. Every fact is typed, source-cited, and confidence-scored; low-confidence facts are held, never trusted, because a wrong fact is worse than a missing one.

## What Changes

- New datasheet ingestion pipeline using Sarvam Document Intelligence: Extract for typed fields with per-field confidence, Digitise for structured text with bounding boxes. Async job flow (create, upload, start, poll, download) with a poll timeout, backoff on 429/503, and a required fixtures fallback (`USE_FIXTURES=true`) so demos survive the 10 requests/minute plan limit.
- New fact pipeline: raw extracted fields map to canonical keys with normalized units (for example "Input leakage current = 0.033 mA" becomes `{ key: "pin_input_leakage_uA", value: 33, unit: "uA" }`), every fact carries a `SourceRef` (page, bounding box, snippet), and a confidence gate (`CONFIDENCE_THRESHOLD = 0.75`) derives `trusted` or `hold` status. A fact without a bounding box is downgraded to `hold`.
- New constraint registry and verdict engine: a `constraints.json` registry holds board rules (`budget_sum`, `max`, `min`, `equality`); a deterministic, fail-closed engine evaluates a proposed change against facts plus constraints and produces a `Verdict` with `citedFact`, `citedConstraint`, a computed expression, and a specific `proposedFix` on refusal. A HOLD fact can never produce APPROVE or REFUSE. Malformed registries refuse to evaluate rather than approving by default.
- New registry persistence and correction flow: trusted facts are written back to the registry with value, confidence, and source; a second change on the same part reuses stored facts with no new Sarvam call; a user correction to a held fact recomputes the verdict live without re-extraction.
- New single-page UI: upload, verdict display, and click-to-source (clicking a fact scrolls the datasheet view to its page and highlights its bounding box; HOLD facts render visually distinct and labeled "review").
- New exportable `VerificationManifest` JSON: checks run, facts used with sources, the verdict, and the Sarvam model ids, for every completed verdict.

Out of scope (non-goals, automatic scope violations): a knowledge graph, KiCad file editing from this surface, multi-part or multi-board evaluation, general datasheet Q&A, auth or multi-user, mobile.

## Capabilities

### New Capabilities

- `datasheet-ingestion`: Sarvam Extract and Digitise integration, the async job lifecycle, rate-limit resilience (backoff, poll timeout), content-addressed caching, and the fixtures fallback.
- `fact-pipeline`: fact typing, canonical keys, unit normalization, provenance stitching (joining Extract fields to Digitise bounding boxes), and confidence gating to `trusted` / `hold`.
- `constraint-verdicts`: constraint registry loading and validation, the deterministic fail-closed verdict engine, cited refusals with proposed fixes, and the exportable verification manifest.
- `registry-memory`: registry persistence of trusted facts, fact reuse on subsequent changes (no repeat extraction), and correction propagation with live verdict recompute.
- `intake-ui`: the upload-to-verdict page, click-to-source bounding-box highlighting, and HOLD styling.

### Modified Capabilities

None. This is a new, self-contained surface; the Phase 1 agent loop, CLI commands, and KiCad tooling requirements are unchanged.

## Impact

- New code lives in a self-contained workspace (Next.js App Router app plus a pure TypeScript core), isolated from `src/` so the existing CLI build, `check` contract, and test suite are untouched. Exact layout is a design decision (see design.md).
- New dependency: `sarvamai` npm package, plus Next.js and React for the UI workspace.
- New env var: `SARVAM_API_KEY` (env-only, never persisted; transcript-style redaction rules apply to any logged output). `.env` is already gitignored.
- New fixtures: cached Extract and Digitise JSON for the demo datasheets under the workspace's `fixtures/` directory.
- The Sarvam SDK method surface is a verify-live item: the REST job contract is the source of truth if the SDK wrapper differs.
