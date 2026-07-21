# rerun-create-stages: Proposal

## Why

The create pipeline is strictly forward-only — it resumes at the first incomplete stage and offers no way to deliberately redo one — while design iteration is inherently backward: the BOM changes after the schematic exists, budgets tighten after layout, a footprint swap invalidates the outline (#24). Worse, the completion probes it resumes by are shallow existence checks that false-positive on blank bootstrap files and on `init`'s own doc templates, so the pipeline can skip stages whose work never happened (#23). Today the only workarounds are hand-deleting artifacts until the probes read "incomplete", or free-form `do` requests that don't know they are redoing a stage.

## What Changes

- **`copperhead create --stage <name>`**: re-run exactly one stage with its normal prompt and gates, against the *existing* artifacts (revise, don't recreate).
- **`copperhead create --from <name>`**: re-run a stage and every stage downstream of it in dependency order.
- **`copperhead create --dry-run`**: print stage status (complete / stale / incomplete, with which upstream artifact changed) and what a run would do; write nothing.
- **The stage dependency graph becomes data**: each stage declares the named artifacts it `consumes` and `produces` (spec-budgets, subsystems, bom, schematic, pinout, board, layout-intent, outputs, firmware, devplan). Edges derive from the vocabulary, so invalidation is per-artifact, not "everything after".
- **Stage completion records**: at each stage's completing commit, `.copperhead/create-state.json` records the stage, run id, and content hashes of its consumed and produced artifacts — the same spirit as `init`'s `generatedHashes`.
- **Staleness + downstream propagation**: a stage is stale when a recorded input hash no longer matches the artifact's current hash. After a re-run whose outputs actually changed, consumer stages are marked stale and either auto-reconcile in dependency order with a scoped prompt naming exactly what changed (autonomous default), or are reported for the human to pick (`--dry-run` / `--interactive`). Unchanged outputs invalidate nothing.
- **Completion inference becomes record-first**: the completion record is authoritative; stages without a record fall back to the stage table's existing completion probes. (Strengthening those probes into per-stage contracts is #23's territory, addressed separately by PR #29 — this change is agnostic to the fallback and composes with it.)
- **Run metadata records re-runs**: which stage re-ran, why (which upstream artifact hash changed), and what it invalidated — extending the existing run-observability surfaces.

## Capabilities

### New Capabilities

- `pipeline-invalidation`: the stage dependency graph (consumes/produces artifact vocabulary), stage completion records with content hashes, staleness computation, and downstream reconciliation semantics.

### Modified Capabilities

- `create-pipeline`: stage completion inference becomes completion-record-first (existing probes as fallback); the stage runner gains targeted re-run and stale-reconciliation modes.
- `cli-surface`: `create` gains `--stage <name>`, `--from <name>`, and `--dry-run`.
- `run-observability`: run metadata for a `create` stage records the re-run trigger (requested vs stale), the changed upstream artifacts, and the stages it invalidated.

## Impact

- **Code**: `src/commands/create.ts` (stage table gains consumes/produces, runner gains re-run/invalidation flow), new stage-state module (completion records, hashing, staleness), `src/cli.ts` (new flags), `src/agent/runmeta.ts` (stage re-run fields). The stage table's `isComplete` probe bodies are deliberately untouched to compose with PR #29 (#23).
- **Specs**: SPEC.md §2.5 (pipeline), §3 (CLI surface), new acceptance criteria section for stage re-runs and invalidation; delta specs per capability above.
- **Docs site**: `reference/cli.md`, `workflows/create-from-brief.md`.
- **Issues**: closes #24. #23 is handled separately (PR #29); completion records additionally end the probe ambiguity for any stage that has run under this change.
- **Compatibility**: repos created before this change have no `create-state.json`; the contract fallbacks cover them, and the first completed stage run starts the record. No breaking CLI changes.
