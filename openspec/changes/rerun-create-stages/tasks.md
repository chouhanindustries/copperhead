# Tasks: rerun-create-stages

## 1. Stage-state module (src/memory/stagestate.ts)

- [x] 1.1 Define the artifact vocabulary and resolution: `ArtifactName` union, `resolveArtifact(name, repoRoot, config, briefPath?) → string[]` mapping each name to its file set (design D1: `schematic` = every `.kicad_sch` under the configured schematic's directory; `spec` = docs/SPEC.md + .copperhead/constraints.json; `outputs`/`firmware` = recursive dir listings)
- [x] 1.2 Implement content hashing: sha256 per file, multi-file artifacts hash the sorted (relPath, fileHash) list, missing files hash to the `absent` sentinel (design D2); unit tests for order-independence, absence, and no-timestamp sensitivity
- [x] 1.3 Implement `create-state.json` load/save: versioned shape `{version, stages: {name: {completedAt, runId, inputs, outputs}}}`; corrupt or unparseable file degrades to empty with a warning, never throws (state-file resilience scenario); unit tests
- [x] 1.4 Implement staleness classification: `classifyStages(repoRoot, config, briefPath) → {stage, status: fresh|stale|incomplete|assumed-complete, changedInputs[]}[]` (design D4); unit tests for each classification and for the upstream-edit-marks-consumer-stale scenario

## 2. Contract fallback probes — DESCOPED

- [x] 2.1 ~~Replace the shallow `isComplete` probes~~ Descoped: #23 is addressed by PR #29 in the same file; this change calls the stage table's `isComplete` as-is and must not touch the probe bodies (see design D4)

## 3. Stage table and graph

- [x] 3.1 Add `consumes`/`produces` to each `Stage` entry per the design D1 table; derive `descendantsOf(stage)` from produces→consumes edges; assert the STAGES array order is a valid topological order (unit test)
- [x] 3.2 Unit tests: edge derivation matches the documented graph; `board`-only change does not touch `firmware`

## 4. Loop seam for completion records

- [x] 4.1 Add optional `beforeCommit` hook to `RunOptions`, invoked in the finish path after all gates pass and the changelog append, immediately before `commitAll`; a hook throw routes to the existing `commit-failed` exit path (design D3)
- [x] 4.2 Test via scripted provider: hook fires only on the commit path (not on refuse/dry-run/rollback), and a file it writes lands in the run's single commit

## 5. Create runner: plan, targeted re-runs, invalidation

- [x] 5.1 Rework `runCreate` to plan from `classifyStages`: default mode runs incomplete + stale stages in order, skipping fresh/assumed-complete; record inputs hash at stage start, write the completion record via `beforeCommit`, re-hash outputs after each run
- [x] 5.2 Implement `--stage <name>`: run the one stage (revision preamble when previously completed), then propagate — changed outputs mark consumers stale and re-run transitively in dependency order in autonomous mode; unchanged outputs end the run (issue #24 example flow)
- [x] 5.3 Implement `--from <name>`: force-re-run the stage and its graph descendants only, in dependency order
- [x] 5.4 Implement reconciliation and revision preambles (design D6): changed-artifact names + paths, revise-not-recreate instruction, pointer to `check_drift` for specifics
- [x] 5.5 Implement `--interactive` behavior: print the stale set and gate reconciliation on the existing `confirm` seam
- [x] 5.6 Implement `create --dry-run`: print every stage's classification and what the mode would run; write nothing; exit 0
- [x] 5.7 Offline tests with scripted providers: default-run healing, --stage propagation on changed vs unchanged outputs, --from descendant selection, dry-run writes nothing (`git status` clean)

## 6. CLI surface

- [x] 6.1 Add `--stage <name>`, `--from <name>`, `--dry-run` to the `create` command; validate stage names against the table (exit non-zero listing valid names), enforce `--stage`/`--from` mutual exclusion
- [x] 6.2 Tests: unknown stage name error lists valid stages; mutually exclusive flags rejected

## 7. Observability

- [x] 7.1 Extend `RunMetaInput.stage` with `trigger` and `changedInputs`; render on all three surfaces (run-start event, `## Environment`, CLI header); emit plan/stale/invalidation log lines from the runner
- [x] 7.2 Test: a stale-triggered stage's metadata carries `trigger: 'stale'` and the changed artifact names on all three surfaces

## 8. Spec + docs sync

- [x] 8.1 Update SPEC.md: §2.5 pipeline (stage graph, completion records, staleness/invalidation), §3 CLI surface (`create --stage/--from/--dry-run`), and a new AC-9 section with binary criteria mirroring the delta-spec scenarios
- [x] 8.2 Update docs site: `reference/cli.md` (new flags) and `workflows/create-from-brief.md` (re-run + invalidation walkthrough)
- [x] 8.3 Full offline suite green (`npm test`, 151 passed / 7 key-gated skips against kicad-cli 10.0.4), typecheck clean; draft PR #33 opened (closes #24; notes composition with PR #29 for #23)

## 9. Adversarial-review remediation (post-implementation review, 2026-07-21)

- [x] 9.1 Probe-gate completion records: `beforeCommit` writes the record only when the stage's completion probe passes post-run; withheld records are logged (review finding 1/2 — also resolves the PR #29 semantic deadlock)
- [x] 9.2 Demote recorded stages whose probe fails now to `incomplete` in classification (finding 1: a record never outranks a failing probe; AC-9.9)
- [x] 9.3 Path-sensitive hashing for walked artifacts (schematic/outputs/firmware) so a sole-file rename registers; skip `.git`/`node_modules`/`.copperhead` in walks; exclude KiCad `_autosave-*` sheets (findings 3/6)
- [x] 9.4 Skip a queued stage that turned fresh before popping (finding 4)
- [x] 9.5 `create --dry-run` and stage-name validation run before model/kicad-cli resolution — deterministic, no API key needed (finding 5)
- [x] 9.6 Reconciliation preamble names artifact locations (design D6 promise); dirty-tree warning in targeted modes; delta-spec overwrite wording corrected (finding 7 + nits)
- [x] 9.7 Rework runner tests for probe-gated record semantics (init-based fixture, stage-aware scripted provider, kicad-cli shim) and add coverage for 9.1/9.2, AC-9.9, and the dirty-tree warning
- [x] 9.8 Post-adaptation hardening: mid-run classification warnings are logged, and `saveStageRecord` preserves an unreadable state file as `create-state.json.corrupt` instead of silently erasing other stages' records
