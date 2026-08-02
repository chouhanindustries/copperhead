# Design: quantize-stage-work

## Context

`runAgentLoop` (`src/agent/loop.ts`) owns turns, budgets, snapshots and the
transcript; `runCreate` (`src/commands/create.ts`) owns stages, retries and the
run report; and `src/agent/tools.ts` is where every file mutation and every
verification passes through. That last one is the whole reason this change is
possible: it is the only place a "small verified quantum" rule can be a mechanism
rather than a sentence in a prompt.

The evidence is in the committed transcripts (`.copperhead/runs/`, issue #145):
one 65m46s schematic stage, 40 turns, 170,920 output tokens, 89% of them in five
turns, 51 `edit_file` calls against 6 `run_erc` calls, largest single edit 17,884
characters, exit `turn-budget-exhausted` with nothing committed.

Inherited constraints from SPEC.md that shape every decision below:

- KiCad files are edited by anchored exact-match text replace only; the
  s-expression layer never serializes (§1.3, design D4). Nothing here writes
  KiCad geometry; all new KiCad reading is read-only.
- Verification-gated out: no mutation is done until ERC (and DRC if the board
  changed) passes; persistent failure rolls back to the snapshot.
- `check` stays LLM-free and network-free. Nothing added here is imported by it.

## Goals / Non-Goals

**Goals**

- Cost concentration is a number in the run report, visible at turn 5 rather than
  at minute 66.
- A provider error costs one verified quantum, not a stage.
- The "work one part at a time" rule is enforced by the tool layer.
- A resumed stage continues at the first incomplete unit.

**Non-Goals**

- Sub-stage decomposition of `schematic` / `layout-draft` (see the proposal's
  out-of-scope section: the completion contracts cannot yet distinguish the
  states a split would need).
- Turn-budget escalation, `create --max-turns`, built-in per-stage turn defaults
  (issue #135) and layout quality scoring (issue #141).
- Currency cost estimation; tokens stay the unit.
- Any new runtime dependency. Everything here is Node, git, and the existing
  s-expression reader.

## Decisions

### D1 — Concentration metrics are a pure function over `perTurn`

`summarizeTurnCost(perTurn)` in the new `src/agent/turn-metrics.ts` takes the
`{turn, in, out, ms}` rows the loop already records and returns `p50TurnOut`,
`p95TurnOut`, `maxTurnOut`, `top5TurnShare`, `slowestTurnMs`. Percentiles use
nearest-rank on the sorted output values, which is what reproduces the issue's own
figures (median 177, top-5 share 0.89 for the 65-minute run) — that array is a
unit test. Being pure and transcript-shaped means the same function scores an
existing `run-end` event, so the 14 historical runs can be replayed without
instrumentation that did not exist when they ran.

Two degenerate cases are defined rather than left to float: an empty run reports
zeros with `slowestTurnMs: null`, and a run that emitted nothing (the observed
40-turn, 0-token cache replay) has a top-5 share of 0, not `NaN`.

Edit pressure (`edits`, `editBytes`, `largestEditBytes`, `verifications`,
`editBytesPerVerify`) is counted in `RunContext` at the tool layer, where the byte
count is exact, rather than re-derived from transcript arguments. `readRunTurnCost`
prefers the recorded figures and falls back to reconstructing them from `tool`
events for runs that predate the counters.

`perTurn` gains `ms` (wall time of that turn). It is additive to a JSON shape that
is only ever read by name, so existing transcripts stay readable and old rows
simply report `slowestTurnMs: null`.

### D2 — The quantum is enforced at the tool layer, and only on KiCad files

Two mechanisms, both in `edit_file`, both refusing before anything is written so a
refused call leaves the file byte-identical:

1. **Byte cap.** `new_string` longer than `maxEditBytes` is refused with a redirect
   that states the cap, the actual size, the setting that changes it, and the
   current symbol/footprint count so the model knows where it is. Default **8192**,
   not the 4 kB #145 suggests: a single canonical `lib_symbols` entry for a wide
   connector legitimately exceeds 4 kB, and a cap that makes a correct atomic edit
   impossible converts a batching problem into a deadlock. 8 kB still refuses every
   oversized edit the issue measured (17.9 kB, and the four over 11 kB) while
   leaving one real library symbol expressible. Configurable; `0` disables.
2. **Verify gate.** Each accepted edit to a `.kicad_sch` increments a schematic
   counter; `run_erc` resets it whether or not ERC passed. At `maxUnverifiedEdits`
   (default 1) the next schematic edit is refused with "run run_erc first".
   `.kicad_pcb` pairs with `run_drc` the same way. `0` disables the gate.

Resetting on a *failing* check is load-bearing, not lenient: the edit that fixes a
violation is the very edit a pass-only reset would refuse, so repair would
deadlock at the first violation.

Both apply to KiCad files only. Docs are not where the failure is: SPEC.md and
BOM.md are legitimately written in one pass, and capping them would break the
three doc stages for no measured benefit.

Tool calls batched into one turn dispatch sequentially, so `edit → run_erc → edit`
in a single reply passes the gate; `edit → edit → edit` does not. That is the
intended shape, and it is the shape the stage-4 prompt has always asked for.

`.kicad_pro` / `.kicad_sym` / `.kicad_mod` are size-capped (they are KiCad files)
but not verify-gated: neither ERC nor DRC checks them, so a gate on them could
never be cleared.

### D3 — Checkpoints commit a subset, then re-snapshot

A clean `run_erc`/`run_drc` that follows at least one edit commits **only the paths
this run touched** (`ctx.filesTouched`), via a new `commitPaths()` helper, with the
message `copperhead: checkpoint — <request> (ERC clean, N file(s))`. Committing a
subset rather than `git add -A` is what makes this safe under `--allow-dirty`,
which every create stage uses: a user's unrelated working changes are never swept
into a checkpoint.

The rollback target then moves: after each checkpoint the loop takes a fresh
`snapshot(repoRoot)` and uses it for any later `restore()`. That is the whole
mechanism — the existing snapshot machinery already captures the remaining dirty
tracked state (`git stash create`) and untracked files (a tree object), so rolling
back to a checkpoint restores everything else exactly as it was at checkpoint
time. Rejected alternative: keep the original snapshot and replay checkpoints on
failure. It needs new conflict handling for something `snapshot()` already does.

Checkpoint commits are prefixed distinctly from stage commits
(`copperhead: <request>`) so history stays greppable and a squash step remains
possible. Disabled by `checkpointCommits: false` and never taken on a dry run.
`commitPaths` adds paths one at a time and skips misses, because `git add` errors
outright on a pathspec that matches nothing and one stale entry must not cost the
whole checkpoint. A checkpoint that fails for any other reason is logged and the
run continues: it is an optimization against mid-response death, and it must never
itself become a failure mode.

### D4 — Stage budgets get their own exit paths; `maxTurnOut` is a nudge

`stageBudgets` is a new config map (`{ [stage]: { maxTokensOut?, maxWallMs?,
maxTurnOut? } }`) rather than a reinterpretation of the existing `budgets`, which
already means *design* budgets (sleep current, and so on) and is rendered verbatim
into the system prompt. Overloading it would make a hardware budget and a spend
budget indistinguishable to both the model and the reader.

`maxTokensOut` and `maxWallMs` are checked at the top of each turn — before the
turn is bought, since the point is to stop before paying for another oversized
emission — and end the run through the existing `fail()` path with new exit paths
`token-budget-exhausted` and `wall-budget-exhausted`. They are distinct from
`turn-budget-exhausted` because the remedy differs: more turns is exactly the
wrong answer to a stage that burned its tokens, and #135's escalation must not
fire on them.

`maxTurnOut` is different in kind: exceeding it means the *unit* was too big, not
that the stage is over. So it injects a user message telling the model to split the
next unit, and the run continues. Aborting there would throw away a turn that has
already been paid for. Invalid entries (zero, negative, non-integer) are dropped by
`normalizeStageBudgets` rather than applied, because a `maxTokensOut: 0` that was
honoured would end every run before its first turn — that is a config typo, not an
instruction.

### D5 — Stage progress is computed, not remembered

`stageProgress()` compares repo state against the stage's unit list: for
`schematic`, BOM.md refdes rows against symbols actually in the schematic; for
`layout-draft`, schematic symbols against footprints on the board (reading both
the KiCad 7+ `(property "Reference" …)` and the older `(fp_text reference …)`
forms). The result is appended to the stage prompt as one line, recomputed before
every attempt so a rollback or a checkpoint cannot leave it stale.

Combined with checkpoint commits this is what "resume at the first incomplete
unit" means in a pipeline whose resume story is repo-state inference (design D10):
the units that are done are committed, and the prompt names the ones that are not.
Deliberately not a stored cursor — a remembered index goes stale the moment a
rollback or a hand edit moves the tree, and a stale cursor is worse than none.
Stages with no countable unit list get no line and are untouched.

## Risks / Trade-offs

- **The verify gate costs turns.** One `run_erc` per schematic edit is more tool
  calls than a batched run makes today. That is the point — the batched run
  exhausted 40 turns and produced nothing — but a stage that was passing at 40
  turns could now need more. The gate is batch-friendly (`edit → run_erc → edit`
  in one reply is one turn), and `stageMaxTurns` already exists for the operator
  who needs headroom; #135 raises the defaults separately.
- **8 kB is a judgement call.** It is above the issue's suggestion and below every
  oversized edit the issue measured. If a real library symbol exceeds it, the
  operator raises `maxEditBytes`; the refusal message names the setting.
- **Checkpoints change what a rollback means.** A failed stage no longer returns
  the tree to its pre-stage state; it returns it to the last ERC-clean point. That
  is the intended trade (the alternative is the observed 66-minute total loss), but
  it is a visible behaviour change, so the CLI says so both when a checkpoint is
  taken and when a rollback lands on one.
- **The progress line is only as good as BOM.md.** A stage whose BOM is wrong gets
  a confidently wrong progress line. It is advisory prompt text, not a gate, so the
  cost is a misleading sentence rather than a wrong completion decision — and the
  drift checks already fail a BOM that disagrees with the schematic.
