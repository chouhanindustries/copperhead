# pipeline-invalidation — Delta Spec

## ADDED Requirements

### Requirement: Stage dependency graph as data
Each `create` pipeline stage SHALL declare the named artifacts it consumes and produces, over a closed artifact vocabulary (`brief`, `spec`, `subsystems`, `bom`, `pinout`, `schematic`, `board`, `layout-intent`, `outputs`, `firmware`, `devplan`) whose members resolve to concrete file sets via the repo config. Dependency edges SHALL derive from produces→consumes intersections, so invalidation is computed per artifact, never as "every later stage".

#### Scenario: Edges name what flows
- **WHEN** the stage table is inspected
- **THEN** `schematic` consumes `bom` and `subsystems` and produces `schematic` and `pinout`; `firmware` consumes `pinout`; `outputs` consumes `board` and `bom` — matching the documented pipeline graph

#### Scenario: Non-descendants are unaffected
- **WHEN** a re-run changes only the `board` artifact
- **THEN** `firmware` (which consumes only `pinout`) is not marked stale

### Requirement: Stage completion records with content hashes
When a stage's `do`-loop run reaches its commit AND the stage's completion probe passes against the post-run state, a completion record SHALL be written to `.copperhead/create-state.json` — inside the same commit as the stage's work — containing the stage name, run id, completion timestamp, and SHA-256 content hashes of every consumed artifact (as read at stage start) and every produced artifact (as read at commit time). A committed run whose completion probe fails SHALL be recorded nowhere (the commit itself is kept) and the runner SHALL say so. Multi-file artifacts SHALL hash the sorted list of (path, file-hash) pairs; directory-walked artifacts (`schematic`, `outputs`, `firmware`) SHALL remain path-sensitive even with a single file, so a rename never escapes detection; a missing file SHALL hash to a distinct sentinel so appearance and disappearance register as changes. Timestamps SHALL never affect a hash.

#### Scenario: Record rides the stage commit
- **WHEN** a stage completes, its probe passes, and it commits
- **THEN** the same commit contains both the stage's edits and the updated `.copperhead/create-state.json` entry for that stage

#### Scenario: Refused or failed stages record nothing
- **WHEN** a stage run ends by refusal, rollback, or `--dry-run`
- **THEN** `.copperhead/create-state.json` is unchanged for that stage

#### Scenario: A committed run that produced no work stays unrecorded
- **WHEN** a stage run passes the loop gates and commits but its completion probe fails (its artifacts were never produced)
- **THEN** no completion record is written, the runner reports the withheld record, and the next `create` classifies the stage incomplete and re-runs it

#### Scenario: Renaming the sole file of a walked artifact registers
- **WHEN** the only file under `firmware/` is renamed with identical bytes
- **THEN** the `firmware` artifact hash changes and its consumers classify stale

### Requirement: Staleness classification
At the start of every `create` invocation, each stage SHALL be classified from its completion record and the current working tree: **fresh** (record exists, the completion probe passes, all recorded input hashes match), **stale** (record exists, probe passes, at least one input hash differs — the differing artifact names retained), **incomplete** (the stage's completion probe fails, with or without a record), or **assumed-complete** (no record but the completion probe passes). A record SHALL never outrank a failing probe: a recorded stage whose probe fails is incomplete, not fresh. The completion probe is the stage table's existing `isComplete` check, called as-is. Assumed-complete stages SHALL NOT be auto-re-run on hash grounds.

#### Scenario: Deleting a completed stage's work reclassifies it incomplete
- **WHEN** `docs/SUBSYSTEMS.md` is deleted after the architecture stage completed with a record
- **THEN** the next `create` classifies architecture incomplete and re-runs it, rather than skipping it as fresh while its consumers go stale against a missing input

#### Scenario: Upstream edit marks the consumer stale
- **WHEN** BOM.md is edited after the `schematic` stage completed
- **THEN** the next `create` classifies `schematic` as stale, naming `bom` as the changed input

#### Scenario: Untouched inputs stay fresh
- **WHEN** no consumed artifact of a completed stage changed since its record was written
- **THEN** the stage is classified fresh and is skipped by a default `create` run

### Requirement: Downstream invalidation and reconciliation
After a targeted stage re-run completes, its produced artifacts SHALL be re-hashed; if none changed, no downstream stage is invalidated. For each changed artifact, stages consuming it SHALL be marked stale and, in autonomous mode, re-run in dependency order under the same rule applied transitively. Each stale stage SHALL run with its normal prompt plus a reconciliation preamble naming the changed upstream artifacts and instructing revision of existing artifacts (not recreation), with all normal gates (proposal validation, ERC/DRC, obligations ledger, single commit) unchanged. In `--interactive` mode the stale set SHALL be presented for confirmation before reconciliation runs.

#### Scenario: Changed output cascades in dependency order
- **WHEN** `create --stage part-selection` changes BOM.md
- **THEN** `schematic` and `outputs` are marked stale and re-run in dependency order, while stages not consuming a changed artifact are skipped

#### Scenario: No-op re-run invalidates nothing
- **WHEN** a re-run stage commits no change to its produced artifacts
- **THEN** every downstream stage keeps its prior classification and none re-runs

### Requirement: State file resilience
A missing, corrupt, or unparseable `.copperhead/create-state.json` SHALL degrade to "no completion records" (contract fallbacks apply) with a printed warning; it SHALL never abort the run or raise an unhandled error.

#### Scenario: Corrupt state degrades gracefully
- **WHEN** `create` starts with an unparseable `create-state.json`
- **THEN** a warning is printed, all stages classify via contract probes, and the run proceeds
