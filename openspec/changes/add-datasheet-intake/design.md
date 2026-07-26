# Design: add-datasheet-intake

## Context

Copperhead's Phase 1 agent edits KiCad projects and verifies them with ERC/DRC, but it has no knowledge layer: nothing connects a proposed change to the component documentation that would justify or refuse it. The companion SPEC (datasheet intake) defines a demo-scoped surface that extracts typed, source-cited, confidence-scored facts from a datasheet using Sarvam Document Intelligence and evaluates a proposed change against a board constraint registry, returning APPROVE / REFUSE / HOLD with citations.

Two constraints shape the design. First, the repo's existing contracts must not move: `check` stays LLM-free and network-free, the CLI build stays untouched, and the offline suite stays green. Second, the demo must be resilient by construction: Sarvam allows 10 requests/minute on all plans, so a fixtures fallback is a requirement, not an optimization.

The external contract facts (endpoints, job states, limits) and the confidence policy come from the intake SPEC and are restated in the delta specs; this document records how we build to them.

## Goals / Non-Goals

**Goals:**

- A deterministic, fail-closed verdict engine whose decisions are reproducible from stored inputs.
- Every trusted fact traceable to a datasheet page and bounding box; provenance enforced by types, not runtime checks.
- The demo survives rate limiting: cached fixtures serve the full flow with zero network calls.
- The existing copperhead CLI, tests, and CI are byte-for-byte unaffected.

**Non-Goals:**

- No knowledge graph, no KiCad editing from this surface, no multi-part or multi-board evaluation, no general datasheet Q&A, no auth, no mobile (SPEC non-goals; automatic scope violations).
- No LLM anywhere in this surface for this change: change descriptors are structured input, not natural language. Natural-language change parsing is a later stage.
- No database: the registry is a JSON file; content-hash caches are files on disk.

## Decisions

### D1: Self-contained `intake/` workspace, not a root workspace conversion

The new code lives in `intake/` at the repo root with its own `package.json`, `tsconfig.json`, and vitest config: a Next.js (App Router) app plus a pure core. The root package is not converted to npm workspaces and root CI does not build `intake/`.

- Why: converting the root to workspaces touches the existing build and lockfile for zero benefit to the CLI. An isolated directory keeps the blast radius at exactly zero for Phase 1 contracts.
- Alternative considered: `packages/core` + `apps/web` monorepo. Right shape for the product later, premature for one app; the same split is preserved inside `intake/` (see D2) so the lift-out remains mechanical.

### D2: Ports-and-adapters around a pure core

Inside `intake/`: `core/` (data model, fact pipeline, verdict engine, manifest builder) imports nothing from Next.js, `node:fs`, or any SDK. I/O lives behind two ports:

- `DocumentIntelligenceProvider`: `extract(doc, fieldSpec)` and `digitise(doc)`. Implemented by `SarvamProvider` (SDK/REST) and `FixtureProvider` (cached JSON). `USE_FIXTURES=true` selects the provider at composition time; it is a provider swap, not an if-branch inside logic.
- `RegistryStore`: load/save of the registry file, implemented with `fs` in the server layer only, using write-temp-then-rename so a crashed write cannot corrupt `constraints.json`.

Why: the core is where all the tests and all the reuse live; the Sarvam SDK surface is a verify-live unknown, so it must be quarantined behind an interface we control.

### D3: Content-hash extraction cache

Extraction results are cached at `fixtures/cache/<sha256(pdf)>-<hash(fieldList)>.json` (Extract) and `<sha256(pdf)>.digitise.json` (Digitise). The job runner checks the cache before creating any Sarvam job.

- Why: a datasheet needs extracting once, ever. Fact reuse on a second change (registry-memory) falls out of the cache plus the registry rather than being a special case, and pre-generating demo fixtures is the same code path as normal caching.

### D4: The verdict engine is a pure function and fails closed

`evaluate(change, facts, constraints) -> Verdict` performs no I/O, reads no clock, and uses no randomness. Determinism (identical inputs give identical verdicts) is a property of the architecture, not a test target. Fail-closed rules are encoded once, in the engine:

- A HOLD fact that is a deciding input forces a HOLD verdict; APPROVE and REFUSE are unreachable from held facts.
- A missing required fact forces HOLD naming the missing field.
- A malformed registry refuses to evaluate; there is no approve-by-default path.

Timestamps are injected by the caller at the manifest boundary; no `Date.now()` in shared code paths.

### D5: Provenance enforced by the type system

The fact model distinguishes a `TrustedFact` (requires `source.page` and `source.bbox`) from a held fact structurally. The pipeline stitches Extract fields to Digitise regions by field-label and value match within the page; when no region matches, the fact is constructed as held. No code path can build a trusted fact without a bounding box.

- Why: AC-3.1 (bbox absent downgrades to hold) becomes unrepresentable rather than a runtime assertion someone can forget.

### D6: Structured change descriptors, no LLM

A proposed change enters as a typed `ChangeDescriptor { kind, label, contributions: [{ factKey, value?, unit }] }` built from a structured UI form. The three golden changes (pull-up contribution to a `budget_sum`, rail voltage against `abs_max`, a within-budget change) are all expressible this way.

- Why: keeps the entire surface deterministic and testable offline, and defers the one genuinely fuzzy component (NL parsing) to a later change where it can emit the same descriptor type.

### D7: Resilience budget

`POLL_TIMEOUT_MS = 90_000` with a 2 s poll interval, wrapped around the SDK wait (which has no timeout of its own). On 429/503: exponential backoff, base 1 s, factor 2, max 3 retries. All failures are typed errors (`SarvamTimeoutError`, `SarvamRateLimitError`), and with `USE_FIXTURES=true` the timeout path falls back to fixtures instead of hanging the UI. Only the relevant datasheet pages (at most 2) are submitted, far under the 10-page limit.

### D8: Secrets and redaction follow the repo's existing rules

`SARVAM_API_KEY` lives only in env vars. Any logged or persisted output (manifests, cached responses, server logs we control) passes through the same write-time redaction posture as copperhead transcripts. `.env` is already gitignored; the cache directory contains only Sarvam response JSON, which carries no key material.

## Risks / Trade-offs

- [Sarvam SDK method names/casing are unverified] → The REST job contract is the source of truth; `SarvamProvider` is written against the port so an SDK-vs-REST swap touches one file. Confirm against `node_modules/sarvamai` types at task time.
- [Extract-to-Digitise bbox stitching may not match cleanly] → Match by field label, then by value-plus-unit within the page; anything unmatched becomes a held fact (fail closed). GT-6 (scanned doc) is the stress test.
- [Live demo throttling at 10 req/min] → Fixtures are a required, tested code path (AC-12.2), pre-generated for every demo datasheet; the demo script runs with fixtures warm.
- [Extraction accuracy on ugly datasheets is unknown] → The confidence gate is the safety net: bad extractions become HOLDs, not wrong verdicts. Measure the trusted-fact rate across the demo sheets before relying on autonomy claims.
- [JSON-file registry has no concurrency story] → Acceptable for a single-user demo; atomic rename prevents corruption. The `RegistryStore` port is the seam for SQLite later.

## Migration Plan

Additive only: a new `intake/` directory, new fixtures, and docs. No existing file's behavior changes. Rollback is deleting the directory.

## Open Questions

- Seed part selection and the two datasheet pages to feed (SPEC section 8 says to ask; needed before fixture generation).
- Exact `sarvamai` SDK method casing and upload flow (verify-live against package types).
- Whether the demo registry ships with the starter constraints from SPEC section 8 verbatim (sleep budget 25 uA, rail max 3.3 V) or values matched to the chosen seed part.
