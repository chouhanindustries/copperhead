# Design: rerun-create-stages

## Context

`copperhead create` (design D10 of build-copperhead-phase-1) runs eight stages, each a `do`-loop invocation, and infers stage completion from repo state so the pipeline is resumable with no separate state file. Two consequences have now been observed in practice:

- The pipeline is forward-only. Resuming always means "first incomplete stage onward"; there is no way to deliberately redo a stage after its inputs changed (#24).
- The completion probes are shallow. File-existence and literal-marker checks false-positive on blank bootstrap files and on `init`'s own doc templates (which contain `## Budgets` and `## Draft quality` — exactly the markers `create` probes for), so stages get skipped over work that never happened (#23).

Building blocks already in the codebase: the obligations ledger implements fine-grained affects-propagation *within* a run; `checkDrift` detects a stale BOM/PINOUT-vs-schematic edge deterministically; `init` already uses content hashes (`generatedHashes`) to distinguish generated from hand-edited docs; run metadata (AC-8) records stage identity and the brief's sha256. This change lifts the same ideas to stage granularity.

## Goals / Non-Goals

**Goals:**

- Targeted re-runs: `create --stage <name>` and `create --from <name>`, revising existing artifacts under the normal gates.
- The stage dependency graph as data: per-stage `consumes`/`produces` over a named artifact vocabulary, so invalidation is per-artifact.
- Staleness from content hashes recorded at stage completion; downstream reconciliation that is automatic in autonomous mode and report-only under `--dry-run`.
- Completion-record-first inference, with the stage table's existing `isComplete` probes as the fallback for unrecorded stages. (Strengthening the probes themselves is #23, addressed separately in PR #29; this design calls the probe and is agnostic to its internals.)

**Non-Goals:**

- No sub-stage (per-file or per-symbol) invalidation; the stage is the unit of work.
- No stage-state integration into plain `do` runs; `do` does not write completion records. (A `do` edit that changes a crossing artifact is still caught: the hash mismatch surfaces as staleness at the next `create` run.)
- No stored diffs or artifact snapshots; staleness says *what* changed, and the agent's own tools (`read_file`, `check_drift`) recover the specifics.
- No changes to the `do` loop's gating, verification, or commit semantics beyond one optional pre-commit hook seam.

## Decisions

### D1 — Artifact vocabulary: named, hashable, resolved from config

A small closed set of artifact names, each resolving to a concrete file set: `brief` (the `--brief` file), `spec` (docs/SPEC.md + `.copperhead/constraints.json`), `subsystems`, `bom`, `pinout`, `layout-intent`, `devplan` (one doc each), `schematic` (every `.kicad_sch` under the configured schematic's directory — hierarchical sheets are separate files and must count), `board` (the configured `.kicad_pcb`), `outputs` (`outputs/` recursively), `firmware` (`firmware/` recursively).

Stage table (edges name what actually flows, per the issue):

| Stage | consumes | produces |
|---|---|---|
| spec-seed | brief | spec |
| architecture | spec | subsystems |
| part-selection | spec, subsystems | bom |
| schematic | bom, subsystems | schematic, pinout |
| layout-draft | schematic | board, layout-intent |
| outputs | board, bom | outputs |
| firmware | pinout | firmware |
| devplan | schematic, firmware, layout-intent | devplan |

Alternative considered: free-form path globs per stage — rejected because a closed vocabulary keeps the graph auditable and lets spec scenarios name edges (`bom → schematic`) instead of paths.

### D2 — Hashing: sha256 of content; multi-file artifacts hash the sorted (path, hash) list

Timestamps never participate, so a no-op regeneration of identical bytes invalidates nothing. A missing file hashes to the sentinel `"absent"`, so appearance/disappearance is a change like any other. `outputs` regeneration is expected to produce different bytes (KiCad embeds dates in gerbers); that is acceptable because `outputs` is a sink — no stage consumes it, so nothing cascades.

### D3 — Completion records in `.copperhead/create-state.json`, committed with the stage's own commit

Shape: `{ "version": 1, "stages": { "<name>": { "completedAt", "runId", "inputs": { "<artifact>": "<hash>" }, "outputs": { "<artifact>": "<hash>" } } } }`. Input hashes are computed from the working tree at stage start; output hashes at commit time. The file is committed (it is design state, like `generatedHashes`), and it must ride the *same commit* as the stage's work — a separate bookkeeping commit would break "exactly one commit per verified change".

To land it in that commit, `RunOptions` gains an optional `beforeCommit` hook, invoked in the loop's finish path after all gates pass (and after the changelog append) and immediately before `commitAll`. The create runner passes a callback that writes the completion record; `git add -A` then includes it. A hook failure follows the existing `commit-failed` exit path. This is the only loop change.

**The record is probe-gated at commit time, and an unmet contract halts the pipeline.** A run can pass the loop's gates without producing the stage's artifacts (nothing in `finish` requires the products to exist — the #23 failure mode). The record asserts "this stage's work exists as committed", so `beforeCommit` writes it only if the stage's completion probe passes against the post-run state; otherwise the commit still lands (partial verified work is kept), the stage stays unrecorded, and the runner halts with `ok:false` and a "contract is not met yet, re-run to continue" message — the halt-on-unmet-contract semantics main adopted in the create-pipeline hardening, kept here so a re-run genuinely continues the same stage rather than advancing past absent work.

Alternative considered: the runner writes the record after `runAgentLoop` returns — rejected because the record would be uncommitted (dirty tree for the next stage, orphaned after the last one) and could never be atomic with the work it describes.

### D4 — Staleness: recorded input hash ≠ current hash; unrecorded stages fall back to contract probes

At plan time (`create` start, any flag combination), each stage is classified:

- **fresh**: completion record exists and every recorded input hash matches the current hash.
- **stale**: record exists, some input hash differs (the differing artifact names are kept for the prompt and the report).
- **incomplete**: no record and the stage's `isComplete` probe says the work is absent.
- **assumed-complete**: no record but the probe passes (pre-existing repos, repos built before this change). Assumed-complete stages get a record the next time they run; they are never auto-re-run on hash grounds because there are no recorded hashes to compare.

The fallback is the stage table's `isComplete` probe, called as-is. Its bodies are deliberately not modified here: PR #29 (issue #23) strengthens them into per-stage contracts in the same file, and this change must compose with it, not collide.

**A record never makes missing work fresh — but changed inputs outrank a failing probe.** For recorded stages, classification compares input hashes first: any mismatch classifies `stale` regardless of the probe, because drift-aware probes (the schematic stage's, since the create-pipeline hardening on main) fail precisely *because* an upstream artifact changed, and demoting there would lose the stale trigger, changed-input names, and reconciliation preamble in the flagship BOM-edit case. Only a recorded stage whose inputs all still match and whose probe fails now — deleted work product, or probes grown stricter since the record was written — is `incomplete` and runs from scratch. Without that demotion, a record would substitute "ran and committed" for "work exists", and a stage whose artifact disappeared would be skipped forever while its consumers went stale against a missing input.

### D5 — Run planning: default heals, `--stage` targets, `--from` forces downstream

- **default (no flags)**: run every stage that is incomplete or stale, in pipeline order, skipping fresh/assumed-complete ones. This makes plain `create` self-healing: drift introduced between runs (including by `do`) is picked up automatically.
- **`--stage <name>`**: run exactly that stage (with the revision preamble if it had completed), then recompute its output hashes. Outputs unchanged → done, nothing invalidated. Outputs changed → consumers of the changed artifacts become stale and, in autonomous mode, re-run in dependency order (transitively, same rule). In `--interactive` mode the stale set is printed and the existing `confirm` seam asks before reconciling.
- **`--from <name>`**: force-re-run the stage and its graph *descendants* (reachable via produces→consumes edges), in dependency order — not the list-order remainder, so `--from layout-draft` does not pointlessly re-run `firmware`.
- **`--dry-run`**: print the classification of every stage (fresh / stale with changed artifacts / incomplete / assumed-complete) and exactly what the chosen mode would run; write nothing, exit 0.
- Stage names are validated against the table; an unknown name lists the valid ones. `--stage` and `--from` are mutually exclusive.

Dependency order is the existing STAGES array order, which is already a valid topological order of the graph; the graph only *filters* which stages run.

### D6 — Reconciliation prompts: scoped, drift-grounded, revise-not-recreate

A stale stage runs with its normal stage prompt plus a generated preamble: which upstream artifacts changed (by name and path), the instruction to *revise* the existing artifacts to reconcile with those changes rather than recreate them, and to lean on `check_drift` output for the exact disagreements (that is where "R1 10k → 4.7k" specificity comes from — deterministically, not from stored diffs). A `--stage`/`--from` re-run of a completed stage gets the same revise-not-recreate preamble minus the changed-artifact list. All normal gates apply unchanged: proposal, ERC/DRC, obligations ledger, single commit.

### D7 — Observability: the re-run story lands in the existing AC-8 surfaces

`RunMetaInput.stage` gains `trigger: 'initial' | 'requested' | 'from' | 'stale'` and `changedInputs?: string[]`; both render in the CLI header and `summary.md ## Environment`. The create runner emits `stage-plan` (the full classification), `stage-stale`, and `stage-invalidated` transcript-level log lines, and the pipeline's final line reports what ran vs. skipped. Collection stays LLM-free and probe failures stay non-fatal (AC-8.3 discipline).

### D8 — Module placement

New module `src/memory/stagestate.ts` (artifact resolution, hashing, record load/save, staleness classification) beside the other `.copperhead/` state owners (constraints, scaffold). `src/commands/create.ts` keeps the stage table and gains the planner/invalidation flow; `src/cli.ts` adds the flags. A corrupt or unparseable `create-state.json` degrades to "no records" (contract fallbacks) with a warning, never a crash.

## Risks / Trade-offs

- [Agent recreates instead of revising on a re-run] → the preamble is explicit, and structurally `write_file` refuses to overwrite existing files, so wholesale recreation of an existing doc is impossible; edits must go through anchored `edit_file`.
- [`spec` artifact bundles SPEC.md with constraints.json, so a constraint recorded by a *downstream* stage changes the `spec` hash and marks architecture/part-selection stale] → this is arguably correct (a new constraint *should* trigger reconsideration), but noisy in the common case; mitigation: a stage's own outputs are re-hashed into its consumers' records when the consumer runs, and the reconciliation prompt lets the agent close a no-op revisit cheaply ("no change needed" + finish). If it proves too noisy in practice, split `constraints` into its own artifact in a follow-up.
- [Hash-based staleness cannot say *what* changed inside an artifact] → accepted; `check_drift` and the docs themselves recover specifics deterministically. Stored diffs would require snapshotting content into state, which bloats a committed file.
- [Assumed-complete stages (pre-existing repos) can hide genuinely half-done work] → same exposure as today (and narrowed further once PR #29's contract probes land); the first targeted re-run starts the record and ends the ambiguity.
- [Stricter completion probes coexisting with records] → resolved when main's create-pipeline hardening (drift-aware schematic probe, footprint-requiring layout probe, halt on unmet post-run contract) was merged into this change: probes drop into the unrecorded fallback, the record gate, and the post-run halt unchanged; changed-input staleness outranks probe failure so drift-aware probes cannot shadow the stale flow; and probe-gated records mean the halt's "re-run to continue" is always true. PR #29 remains open with an overlapping-but-narrower version of the same hardening; if it lands, its probe bodies replace these the same way.
- [beforeCommit hook widens the loop surface] → it is optional, fires only after every gate has passed, and a throw routes to the existing `commit-failed` path; no gate can be bypassed through it.
- [A stage's agent can write outside its declared produces — notably `record_constraint` dual-writes constraints.json, part of the `spec` artifact] → such changes deliberately do not cascade within the invocation (`changedThisRun` tracks declared produces only); they surface as ordinary staleness on the next default `create`. Do not "fix" this during a rebase: re-queueing non-descendants mid-run reopens the infinite-loop surface the ran-set guard closes.
- [A stage that edits an artifact it also consumes records pre-edit input hashes and classifies stale once on the next run] → costs one no-op reconcile run, then settles. Accepted over re-hashing inputs at commit time, which would mask genuinely concurrent upstream edits.

## Migration Plan

No migration step. Repos without `create-state.json` classify via contract probes (D4) and accrete records as stages run. Rollback = revert the code; an existing `create-state.json` is inert data no other code path reads.

## Open Questions

- Should `sync` learn to read `create-state.json` and report stale stages in its inconsistency report? Natural follow-up, out of scope here.
- Whether `devplan`'s consumes set (schematic, firmware, layout-intent) is too broad in practice — tune after live runs.
