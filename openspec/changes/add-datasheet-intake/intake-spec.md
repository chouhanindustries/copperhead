# SPEC: copperhead datasheet intake (TypeScript)

> Source spec provided as context for this change. Buildable technical spec with testable acceptance criteria. This file is the contract: nothing is "done" until its acceptance criteria pass. Fact markers: **[verified]** from Sarvam docs, **[verify-live]** confirm before hardcoding, **[decision]** a build choice you can change.

---

## 1. Purpose

Point the tool at a component datasheet plus a proposed change to an existing board. It extracts typed, source-cited, confidence-scored facts from the datasheet using Sarvam Document Intelligence, checks the change against the board's constraint registry, and returns APPROVE / REFUSE / HOLD with the exact datasheet line and the exact rule line cited. Every fact is traceable to its datasheet region; low-confidence facts are held, never trusted.

The demo is a completed decision, not a knowledge graph.

## 2. Scope and non-goals

**In scope:** one part class; ~5 parametric fields; one board with a documented current budget and a rail voltage; three change evaluations; a persisted registry; a click-to-source UI; a verification manifest.

**Non-goals (do not build):** the full four-layer knowledge graph; topologies/failures layers; KiCad file editing; multi-part or multi-board; general datasheet Q&A; auth/multi-user; mobile. Anything here is an automatic scope violation.

## 3. Stack [decision]

- **Language:** TypeScript throughout.
- **App:** Next.js (App Router) + React. Server route calls Sarvam; a single page handles upload, verdict, and the datasheet highlight overlay. (Alt: Vite + Express if you prefer; the contract is identical.)
- **Sarvam SDK:** `sarvamai` npm package (`npm install sarvamai`) [verified package name]. Namespaces mirror the Python SDK in camelCase; **confirm exact method names against `node_modules/sarvamai` types** [verify-live]. The REST job contract in section 5 is the source of truth if the SDK wrapper differs.
- **Persistence:** a `constraints.json` file on the server (read/write via `fs`). No database.
- **State:** the registry file is the single source of truth for facts + constraints.

## 4. Data model (TypeScript)

```ts
// --- Provenance (from Sarvam Digitise bounding boxes) ---
export interface BoundingBox { page: number; x: number; y: number; width: number; height: number; } // normalized 0..1
export interface SourceRef { page: number; bbox?: BoundingBox; snippet?: string; }

// --- A typed fact extracted from a datasheet (from Sarvam Extract) ---
export interface ExtractedFact {
  key: string;                 // canonical predicate key, e.g. "pin_input_leakage_uA"
  rawField: string;            // the field label Extract used, e.g. "Input leakage current"
  value: number | string;
  unit?: string;               // normalized, e.g. "uA", "V"
  confidence: number;          // 0..1, from Sarvam Extract per-field confidence
  status: "trusted" | "hold";  // derived: confidence < THRESHOLD => "hold"
  source: SourceRef;           // datasheet page + bbox
}

// --- A board constraint (the "budget"; project knowledge) ---
export type ConstraintKind = "budget_sum" | "max" | "min" | "equality";
export interface Constraint {
  id: string;                  // "sleep_current_budget"
  description: string;         // human contract line, quoted in the refusal
  kind: ConstraintKind;
  limit: number;
  unit: string;
  affects: string[];          // fact keys this constraint consumes, e.g. ["pin_input_leakage_uA"]
  source: string;             // where the rule came from, e.g. "board SPEC sleep budget"
}

export interface Registry {
  part: string;
  facts: ExtractedFact[];
  constraints: Constraint[];
}

// --- The proposed change and the verdict ---
export type Decision = "APPROVE" | "REFUSE" | "HOLD";
export interface Verdict {
  change: string;                 // "add 100k pull-up on GPIO12"
  decision: Decision;
  reason: string;                 // one engineer-grade sentence
  citedFact?: ExtractedFact;      // the datasheet line
  citedConstraint?: Constraint;   // the rule line
  computed?: { expression: string; result: number; limit: number; unit: string };
  proposedFix?: string;           // "use the MCU internal pull-up (leakage within budget)"
}

// --- Exportable audit artifact ---
export interface VerificationManifest {
  timestampISO: string;           // pass in; do not call Date.now() in shared code paths
  part: string;
  change: string;
  checksRun: string[];
  factsUsed: ExtractedFact[];
  verdict: Verdict;
  sarvam: { extractModel: string; digitiseModel: string };
}
```

**Confidence policy [decision]:** `CONFIDENCE_THRESHOLD = 0.75`. Any fact below it, or flagged by a datasheet footnote qualifier, gets `status: "hold"`. A HOLD fact can never produce an APPROVE or a REFUSE; it produces a HOLD verdict naming the field to re-check. A wrong fact is worse than a missing one.

## 5. Sarvam integration contract [verified endpoints]

Base host `api.sarvam.ai`. Auth header carries the `api_subscription_key` from dashboard.sarvam.ai. Two tools, both Sarvam Vision:

- **Extract** returns fields you describe, each with a confidence score. Drives `ExtractedFact.value/confidence`.
- **Digitise** returns structured text with **bounding boxes**. Drives `ExtractedFact.source.bbox` and the click-to-source UI.

**Job flow (async batch, verified):**
1. Create job: `POST /doc-digitization/job/v1` with `{ language, output_format }`. Returns `job_id` (+ storage upload target).
2. Upload the file to the returned storage target (the SDK's upload method wraps this; raw REST uploads to the returned Azure blob URL).
3. Start: transition the job to running.
4. Poll: `GET /doc-digitization/job/v1/{job_id}/status` until `job_state` is `Completed` (or `PartiallyCompleted` / `Failed`). States: `Pending | Accepted | Running | Completed | PartiallyCompleted | Failed`.
5. Retrieve: `GET /doc-digitization/job/v1/{job_id}/download-files` returns a ZIP with the primary-format file + page-level structured JSON (always present).

**SDK shape (confirm casing against the package types) [verify-live]:**
```ts
import { SarvamAI } from "sarvamai";
const client = new SarvamAI({ apiSubscriptionKey: process.env.SARVAM_API_KEY! });
// mirrors Python client.document_intelligence.create_job(...) / job.upload_file / start / wait / download
```

**Hard limits [verified]:** 10 pages/PDF, 10 images/ZIP, 50-200 MB/file, **10 requests/min on all plans**. Feed only the 2 relevant datasheet pages (ratings + electrical characteristics). Exceeding 10 pages returns `400`.

**Resilience requirements:**
- Wrap polling in a timeout (the SDK wait has none by default). `POLL_TIMEOUT_MS = 90_000`, poll interval 2s.
- On 429/503, exponential backoff (base 1s, factor 2, max 3 retries).
- Pre-generate and cache each demo datasheet's Extract + Digitise JSON to `/fixtures`; a `USE_FIXTURES=true` env flag serves cached results so the live demo survives throttling. This is a required fallback, not optional.

## 6. Functional requirements and acceptance criteria

Each requirement is done only when every AC passes. AC are written Given / When / Then and must be demonstrable.

### FR-1: Datasheet ingestion
The system sends the datasheet to Sarvam Extract (field list) and Digitise (bounding boxes) and assembles `ExtractedFact[]`.
- **AC-1.1** Given a real datasheet page and a field list, When ingestion runs, Then at least 4 fields return with a numeric/string value and a `confidence` in [0,1]. [verified path]
- **AC-1.2** Given a completed Digitise result, When a fact is assembled, Then its `source.page` is set and, for at least the leakage fact, `source.bbox` is populated.
- **AC-1.3** Given the job exceeds `POLL_TIMEOUT_MS`, When polling, Then the system throws a typed timeout error and falls back to fixtures if `USE_FIXTURES=true`, never hanging the UI.

### FR-2: Fact typing and unit normalization
Raw Extract fields map to canonical keys and normalized units.
- **AC-2.1** Given "Input leakage current = 0.033 mA", When normalized, Then `{ key:"pin_input_leakage_uA", value:33, unit:"uA" }`.
- **AC-2.2** Given a field the registry does not consume, When mapping, Then it is stored but not required for any verdict (no crash on extra fields).

### FR-3: Provenance
Every fact carries a source reference.
- **AC-3.1** Given any `ExtractedFact` used in a verdict, When inspected, Then `source.page` is present; if `bbox` is absent the fact is downgraded to `hold`.

### FR-4: Confidence gating (HOLD)
- **AC-4.1** Given a fact with `confidence < 0.75`, When status is derived, Then `status === "hold"`.
- **AC-4.2** Given a HOLD fact is the deciding input, When a change is evaluated, Then the verdict `decision === "HOLD"` and `reason` names the exact field to re-check. No APPROVE/REFUSE is emitted from a HOLD fact.

### FR-5: Constraint registry
Load a `constraints.json` with the board budget + rail.
- **AC-5.1** Given `constraints.json`, When loaded, Then at least one `budget_sum` constraint (sleep current, limit 25, unit "uA") and one `max` constraint (rail voltage) parse into `Constraint[]`.
- **AC-5.2** Given a malformed constraints file, When loaded, Then the system reports the error and refuses to evaluate (fail closed), rather than approving by default.

### FR-6: Change evaluation engine
Given a change + facts + constraints, produce a `Verdict`.
- **AC-6.1 (REFUSE / budget)** Given the change "add 100k pull-up" contributing 33uA and a 25uA `budget_sum`, When evaluated, Then `decision==="REFUSE"`, `computed` shows `33 > 25 uA`, `citedFact` is the leakage fact, `citedConstraint` is the sleep budget.
- **AC-6.2 (REFUSE / max)** Given a part whose `abs_max_vin_V` is below the rail `max` constraint, When evaluated, Then `decision==="REFUSE"` citing both lines.
- **AC-6.3 (APPROVE)** Given a change within all constraints with all trusted facts, When evaluated, Then `decision==="APPROVE"`.
- **AC-6.4 (determinism)** Given identical inputs, When evaluated 3 times, Then the verdict is identical each time.

### FR-7: Cited refusal + proposed fix
- **AC-7.1** Given a REFUSE, When rendered, Then `reason` is one sentence naming the measured value, the limit, and the deviation, and `proposedFix` is present and specific (e.g. internal pull-up).
- **AC-7.2** Given a REFUSE, When rendered, Then both the datasheet line and the rule line are visible to the user without extra clicks.

### FR-8: Registry persistence and reuse (memory)
- **AC-8.1** Given an evaluated part, When the verdict is APPROVE or REFUSE, Then the trusted facts are written to `constraints.json` with value + confidence + source.
- **AC-8.2** Given a second change on the same part, When evaluated, Then the system reuses stored facts and does NOT re-call Sarvam for facts already present.

### FR-9: Correction propagation
- **AC-9.1** Given a user corrects a mis-read fact value, When saved, Then the affected verdict re-computes live and the manifest updates, with no full re-extraction.

### FR-10: Click-to-source (UI)
- **AC-10.1** Given a rendered fact with a `bbox`, When the user clicks it, Then the datasheet image scrolls to `source.page` and highlights the `bbox` region.
- **AC-10.2** Given a HOLD fact, When rendered, Then it is visually distinct (e.g. amber) and labeled "review".

### FR-11: Verification manifest
- **AC-11.1** Given any completed verdict, When the user exports, Then a `VerificationManifest` (JSON) downloads containing `checksRun`, `factsUsed` (with sources), the `verdict`, and the Sarvam model ids.

### FR-12: Resilience
- **AC-12.1** Given a 429 from Sarvam, When calling, Then the client retries with backoff up to 3 times before failing.
- **AC-12.2** Given `USE_FIXTURES=true`, When ingesting, Then cached Extract/Digitise JSON is used and no network call is made.

## 7. Golden test cases (the demo must pass all)

| ID | Input | Expected verdict | Proves |
|---|---|---|---|
| **GT-1** | Datasheet + "add 100k pull-up on a sleeping GPIO" | **REFUSE**: 33uA > 25uA sleep budget; cite pin-leakage line + budget line; fix = internal pull-up | JTBD, Creativity, DI traceability |
| **GT-2** | Part with abs-max Vin 3.6V, board rail 5V + "drive this pin from the 5V rail" | **REFUSE**: 5V > 3.6V abs-max; cite both | JTBD repeatability |
| **GT-3** | Datasheet where the leakage value sits under a footnote / low-confidence extraction | **HOLD**: confidence < 0.75, name the field to re-check; datasheet cell highlighted | DI controlled uncertainty, Delight |
| **GT-4** | After GT-3, user corrects the held value | Verdict re-computes to APPROVE/REFUSE live; manifest updates | Memory (correction propagation) |
| **GT-5** | Second change on the same part | Reuses stored facts, no new Sarvam extract call | Memory (reuse) |
| **GT-6** | One hard scanned / hand-annotated / stamped source doc | Extracts with an uncertain region flagged HOLD | DI L3 to L4 lift |

**End-to-end demo acceptance:** GT-1, GT-2, GT-3 run back to back, cold, twice, each writing a registry entry + downloadable manifest, with zero builder intervention, inside 3 minutes.

## 8. Seed data (ask me to fill these in)

`constraints.json` starter:
```json
{
  "part": "TBD-part",
  "facts": [],
  "constraints": [
    { "id": "sleep_current_budget", "description": "board sleeps within 25 uA", "kind": "budget_sum", "limit": 25, "unit": "uA", "affects": ["pin_input_leakage_uA"], "source": "board SPEC sleep budget" },
    { "id": "rail_voltage_max", "description": "no pin driven above the 3.3V rail abs-max", "kind": "max", "limit": 3.3, "unit": "V", "affects": ["abs_max_vin_V"], "source": "board SPEC rail" }
  ]
}
```
Extract field list starter: `supply voltage range (V)`, `quiescent current (uA)`, `per-pin input leakage current (uA)`, `absolute maximum input voltage (V)`, `recommended pull-up resistance (ohm)`.

## 9. Definition of done
Every FR's AC pass; the six golden cases pass; the end-to-end demo acceptance passes twice cold; a fallback recording exists; `constraints.json` and one manifest are produced live.
