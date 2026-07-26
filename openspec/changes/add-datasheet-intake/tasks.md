# Tasks: add-datasheet-intake

## 1. Workspace scaffold

- [ ] 1.1 Create `intake/` with its own `package.json` (Next.js App Router, React, TypeScript, vitest), `tsconfig.json`, and a README stating the workspace is isolated from the root CLI build
- [ ] 1.2 Add `intake/.env.example` documenting `SARVAM_API_KEY` and `USE_FIXTURES`; confirm root `.gitignore` covers `intake/.env` and add `intake/fixtures/cache/` handling (cache committed only for demo fixtures)
- [ ] 1.3 Define the core data model in `intake/core/model.ts`: `BoundingBox`, `SourceRef`, `ExtractedFact`, the `TrustedFact` variant requiring `bbox`, `Constraint`, `Registry`, `ChangeDescriptor`, `Verdict`, `VerificationManifest`

## 2. Fact pipeline (pure core)

- [ ] 2.1 Implement unit normalization and canonical key mapping with table-driven conversions (mA to uA, V, ohm); unit tests including AC-2.1 (0.033 mA becomes 33 uA) and unconsumed extra fields (AC-2.2)
- [ ] 2.2 Implement confidence gating: threshold 0.75, footnote-qualifier flag, missing-bbox downgrade; unit tests for AC-4.1 and AC-3.1
- [ ] 2.3 Implement provenance stitching (Extract field to Digitise region by label, then value plus unit, within page); unmatched fields become held facts; tests with adversarial inputs (empty regions, duplicate labels, unicode, malformed bboxes)

## 3. Verdict engine (pure core)

- [ ] 3.1 Implement registry parsing and validation with typed errors; malformed registry refuses to evaluate (AC-5.1, AC-5.2 tests)
- [ ] 3.2 Implement `evaluate(change, facts, constraints)` covering `budget_sum`, `max`, `min`, `equality`; HOLD dominance (AC-4.2), missing-fact HOLD, refusal with `computed` and citations (AC-6.1, AC-6.2), approval path (AC-6.3), determinism test running evaluation 3 times (AC-6.4)
- [ ] 3.3 Implement refusal reason and proposed-fix construction (one sentence naming value, limit, deviation; specific fix) with tests (AC-7.1)
- [ ] 3.4 Implement manifest builder with injected timestamp and a reproducibility test: re-running the engine on a manifest's stored inputs yields the identical verdict (AC-11.1)

## 4. Ingestion layer

- [ ] 4.1 Define the `DocumentIntelligenceProvider` port and implement `FixtureProvider` serving cached Extract and Digitise JSON with zero network (AC-12.2 test)
- [ ] 4.2 Verify-live the `sarvamai` SDK surface against `node_modules/sarvamai` types; implement `SarvamProvider` (create, upload, start, poll, download), falling back to the REST job contract if the SDK differs
- [ ] 4.3 Implement the job runner: poll timeout 90 s at 2 s interval with typed timeout error (AC-1.3), exponential backoff on 429/503 up to 3 retries (AC-12.1), page budgeting (at most 2 pages submitted)
- [ ] 4.4 Implement the content-hash cache (sha256 of document plus field-list hash) consulted before any job creation, with tests
- [ ] 4.5 Generate and commit fixtures for the demo datasheets (Extract and Digitise JSON), including one hard scanned or stamped source for GT-6

## 5. Registry memory

- [ ] 5.1 Implement `RegistryStore` with atomic write (temp then rename); persist trusted facts with value, confidence, source after APPROVE or REFUSE (AC-8.1 test)
- [ ] 5.2 Implement fact reuse: a second change on the same part evaluates from stored facts with no provider call (AC-8.2 test asserting zero extraction calls)
- [ ] 5.3 Implement correction propagation: saving a corrected fact value recomputes the verdict and manifest with no re-extraction (AC-9.1 test)

## 6. UI

- [ ] 6.1 Build the single-page flow: datasheet upload, ingestion progress, fact list, structured change form producing a `ChangeDescriptor`, verdict card showing the evaluated descriptor
- [ ] 6.2 Render the datasheet with a bbox overlay; click-to-source scrolls to the page and highlights the region (AC-10.1); HOLD facts amber and labeled "review" (AC-10.2)
- [ ] 6.3 Refusal card shows both citations without extra clicks (AC-7.2); manifest export downloads the JSON (AC-11.1)
- [ ] 6.4 Correction flow in the UI: edit a held or wrong fact, save, watch the verdict recompute live (drives AC-9.1)

## 7. Golden tests and demo acceptance

- [ ] 7.1 Encode GT-1 through GT-5 as vitest integration tests over the fixture provider (deterministic, offline, asserting verdicts, citations, reuse, and correction propagation)
- [ ] 7.2 Run GT-6 (hard scanned document) live once, capture its fixtures, then encode it as an offline test
- [ ] 7.3 Run the end-to-end demo acceptance: GT-1, GT-2, GT-3 back to back, cold, twice, each writing a registry entry and downloadable manifest, inside 3 minutes; record the fallback demo video
- [ ] 7.4 Measure and record the trusted-fact rate across all demo datasheets in the change's notes (informs the autonomy claim)
