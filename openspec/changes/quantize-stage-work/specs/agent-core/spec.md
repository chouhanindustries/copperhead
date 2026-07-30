# agent-core delta spec

## ADDED Requirements

### Requirement: KiCad edits are size-capped at the tool layer

`edit_file` SHALL refuse a replacement string larger than `maxEditBytes`
(`.copperhead/config.json`, default 8192) when the target is a KiCad file, and
SHALL return a corrective message naming the cap, the attempted size, the setting
that changes it, and the current symbol or footprint count. The refusal SHALL make
no change on disk. A `maxEditBytes` of `0` SHALL disable the cap. Non-KiCad files
SHALL be unaffected.

#### Scenario: An oversized schematic edit is redirected, not applied

- **WHEN** the agent calls `edit_file` on `board.kicad_sch` with a 17,884-character `new_string` and the cap is 8192
- **THEN** the call returns a refusal that names the cap and the current symbol count, and the file is unchanged

#### Scenario: Docs are not capped

- **WHEN** the agent writes a 20 kB section into `docs/SPEC.md`
- **THEN** the edit is applied normally

#### Scenario: The cap can be turned off

- **WHEN** `maxEditBytes` is `0`
- **THEN** KiCad edits of any size are accepted

### Requirement: A second unverified KiCad edit is refused

`edit_file` SHALL track unverified edits per KiCad file kind. Each accepted edit to
a `.kicad_sch` increments the schematic counter and each accepted edit to a
`.kicad_pcb` increments the board counter. `run_erc` SHALL reset the schematic
counter and `run_drc` the board counter, whether or not the check passed. When a
counter has reached `maxUnverifiedEdits` (default 1), a further edit to that kind
SHALL be refused with an instruction to run the corresponding check first.
`maxUnverifiedEdits` of `0` SHALL disable the gate.

#### Scenario: Two schematic edits without a check

- **WHEN** the agent calls `edit_file` twice on the schematic in one turn with no `run_erc` between them
- **THEN** the first edit applies and the second is refused with "run run_erc"

#### Scenario: Edit, verify, edit passes

- **WHEN** the agent batches `edit_file`, `run_erc`, `edit_file` in one reply
- **THEN** both edits apply

#### Scenario: A failing check still permits the repair edit

- **WHEN** `run_erc` reports violations after an edit
- **THEN** the counter is reset and the next schematic edit is accepted

### Requirement: Verified work is checkpoint-committed

When `run_erc` or `run_drc` reports clean, at least one edit has been made since the
last checkpoint, the run is not a dry run, and `checkpointCommits` is not disabled,
the loop SHALL commit the paths this run has touched with a message prefixed
`copperhead: checkpoint —`, SHALL re-snapshot the working tree, and SHALL use that
new snapshot as the rollback target for any later failure. Checkpoint commits SHALL
stage only paths the run touched, never the whole tree.

#### Scenario: A mid-run failure keeps verified work

- **WHEN** two units are checkpointed and the run then exits `provider-error`
- **THEN** the rollback restores the tree to the second checkpoint, and both units remain committed

#### Scenario: Unrelated dirty work is not swept in

- **WHEN** a run started with `--allow-dirty` over a tree containing an unrelated modified file, and a checkpoint is taken
- **THEN** the checkpoint commit does not contain that file and the file is still modified in the working tree afterwards

#### Scenario: Dry runs never checkpoint

- **WHEN** the run is a dry run
- **THEN** no checkpoint commit is made

### Requirement: Per-run turn cost and edit pressure are accounted

The loop SHALL record wall time per turn alongside per-turn token usage, and SHALL
count, over the run, the number of accepted file edits, total edited bytes, the
largest single edited payload, and the number of ERC/DRC verifications. `RunStats`
SHALL carry these so every terminal branch reports them. A refused or reverted
edit SHALL NOT be counted.

#### Scenario: Per-turn rows carry wall time

- **WHEN** any run ends
- **THEN** each `perTurn` row in the `run-end` event has a `ms` field

#### Scenario: Edit pressure is reported

- **WHEN** a run makes 51 edits and 6 verifications
- **THEN** `run-end` reports `edits: 51`, `verifications: 6`, and the largest edited payload in bytes

### Requirement: Output and wall budgets end a run on their own exit paths

When `maxTokensOut` or `maxWallMs` is supplied for a run and the cumulative output
tokens or elapsed wall time passes it, the loop SHALL end the run through the
failure path with exit path `token-budget-exhausted` or `wall-budget-exhausted`
respectively. These SHALL be distinct from `turn-budget-exhausted`.

#### Scenario: Output budget stops the run

- **WHEN** a run has `maxTokensOut: 1000` and its cumulative output passes 1000
- **THEN** the run fails with exit path `token-budget-exhausted` and the work is preserved and rolled back exactly as for other failures

### Requirement: An oversized turn is told to split, not aborted

When `maxTurnOut` is supplied and a single turn's output tokens exceed it, the loop
SHALL inject a corrective user message instructing the model to split its next unit
into smaller edits, and SHALL continue the run.

#### Scenario: One huge turn does not end the stage

- **WHEN** `maxTurnOut` is 8000 and a turn emits 43,629 output tokens
- **THEN** the run continues and the next user message tells the model to split the unit
