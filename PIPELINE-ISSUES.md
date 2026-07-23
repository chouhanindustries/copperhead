# Pipeline issues — claude-code provider, `copperhead create` from a brief

Driving `copperhead create --brief brief.md` end-to-end with the `claude-code`
(saved-login Claude Agent SDK) provider, from just a product brief, through all
8 stages. Each issue found while getting the pipeline to complete is logged
here with root cause and fix.

Test bed: `../copperhead-test` (USB-C power breakout brief).

---

## Issue 1 — spec-seed stage contract never matches a numbered heading (BLOCKER)

**Symptom:** spec-seed runs, writes a complete `docs/SPEC.md`, commits, then
prints `stage spec-seed: run succeeded but the stage contract is not met yet
(partial work committed); re-run copperhead create to continue this stage`.
Re-running loops forever — each run commits but the pipeline never advances to
stage 2. (Visible as repeated `copperhead: create pipeline stage: spec-seed`
commits in the test repo history.)

**Root cause:** the stage-completion contract is a brittle literal substring
match. `src/commands/create.ts`:

```ts
isComplete: (root, docs) => docHasContent(root, path.join(docs, 'SPEC.md'), '## Budgets'),
```

and `docHasContent` does `.includes('## Budgets')`. The model wrote a valid,
complete SPEC with the section titled `## 3. Budgets and constraints (...)`, so
the literal string `## Budgets` never appears and the check returns false. The
same brittleness affects the layout stage's `## Draft quality` marker.

**Fix:** add a heading-aware matcher `docHasHeading` that matches any Markdown
heading whose text contains the marker word, ignoring `#` level, numbering
(`3.`), and trailing decoration. Point spec-seed and layout at it.

**Status:** fixed.

---

## Issue 2 — claude-code tool-call parser silently drops calls whose payload contains ``` fences (BLOCKER, silent data loss)

**Symptom:** the architecture stage ran, "succeeded", committed, but `docs/SUBSYSTEMS.md`
was never created, so the stage contract failed and the pipeline stalled. The
transcript shows the model *did* emit a correct `write_file` call for
`docs/SUBSYSTEMS.md` — but `Turn.toolCalls` for that turn was empty. The call
was never executed and no error was returned, so the model assumed success,
hallucinated the tool result, and called `finish`.

**Root cause:** `src/agent/providers/claude-code.ts` parsed tool calls by
matching ``` fences with a non-greedy regex:

```
/```(?:json)?\s*([\s\S]*?)```/gi
```

The `write_file` payload's `content` was a full markdown doc (SUBSYSTEMS.md)
that itself contained ``` code fences (a block diagram). The non-greedy match
stopped at the first *inner* ``` fence, capturing a truncated JSON fragment.
`JSON.parse` threw, `toToolCall` returned null, and — by the parser's tolerant
design — the whole call was dropped as if it were prose. Writing any markdown
doc that contains a code block would trigger this.

**Fix:** replace fence-delimited extraction with a string-aware, brace-balanced
scan (`scanJsonObject`) that walks the reply tracking JSON string quoting and
escaping, so braces and backticks inside string values never terminate the
object. Multiple calls and bare (unfenced) calls still work; a stray unbalanced
`{` in prose retries from the next candidate instead of aborting discovery.
Regression test added: a `write_file` whose `content` has nested ``` fences now
parses intact.

**Status:** fixed. Full suite green (225 passed).

---

## Issue 3 — create pipeline has no way to bootstrap the initial KiCad project (BLOCKER, "#19")

**Symptom (anticipated + confirmed by code):** the create pipeline starts from
a brief with no `.kicad_sch`/`.kicad_pcb`, and `config.schematic`/`board` are
null. The schematic stage's contract requires `config.schematic` set + symbols
present + drift-clean, but nothing can create the first KiCad file:
`write_file` explicitly refuses KiCad files (`filetools.ts`: "use edit_file with
anchors instead") and `edit_file` only edits files that already exist. Only
`copperhead init` sets `config.schematic`, and it requires a pre-existing
schematic. So the schematic stage could never satisfy its contract — the same
never-advancing stall as Issue 1, referenced in a code comment as "the future
fix for #19".

**Fix:** new `src/kicad/bootstrap.ts` scaffolds a minimal, kicad-cli-loadable
empty project — an ERC-clean empty schematic, a DRC-clean board with a default
30x20mm outline, and a `.kicad_pro` — then wires `config.schematic`/`board`.
`runCreate` calls it just before the schematic stage (no-op once a project
exists), and the schematic stage prompt now tells the agent the project already
exists and must be populated with `edit_file`. Project filename slug is derived
from the brief's H1. Tests: `test/bootstrap.test.ts` (slug derivation, files
created + config wired + kicad-cli loads them, idempotent).

**Status:** fixed (mechanism). Whether the agent then fully captures an
ERC-clean schematic by anchored edits is a separate, model-capability question
tracked as the pipeline runs.

---

## Issue 4 — edit unlocked and used in the same turn is silently dropped; empty schematic then passes every gate (BLOCKER, false success)

**Symptom:** the schematic stage ran, the model authored a full schematic,
reported "ERC clean" and "drift clean", and finished — but
`usb-c-power-breakout.kicad_sch` still had **0 symbols**. The stage contract
(symbols > 0) correctly refused to advance, so the pipeline would loop forever
with the model convinced each time that it had succeeded.

**Root cause (two compounding bugs):**

1. *Same-turn unlock+edit is dropped.* In one 44k-char reply the model emitted
   `propose_change → validate_change → edit_file(...huge schematic...) → run_erc
   → finish`. The `edit_file` JSON was well-formed and valid, but the turn's
   advertised tool catalog is computed once at turn start (`loop.ts`
   `availableTools(ctx)`), when edit tools were still locked. The claude-code
   parser only accepts calls whose name is in that catalog, so `edit_file` was
   left as prose and never executed. No error is fed back — a silent no-op.
   `dispatchTool` re-checks the unlock live at call time, so the batch *would*
   have worked if the call had reached dispatch.
2. *Empty schematic is a false green.* Because the edit never applied, `run_erc`
   ran against the still-empty scaffold — which passes with 0 violations — and
   `check_drift` treats an empty sheet as bootstrap (clean). So every gate the
   model checked said "good", giving it no signal that nothing was captured.

**Fix:** advertise every tool each turn (`loop.ts` now maps `TOOLS`, not
`availableTools(ctx)`), keeping `dispatchTool` as the live unlock gate. A
`propose→validate→edit` batch in one reply now works end to end (fewer turns —
an efficiency win too), and a premature edit returns an actionable "unlock
first" error instead of vanishing. `edit_file`/`write_file` descriptions now
state the proposal requirement so the model orders the batch correctly. Full
suite green (228). Secondary (not yet fixed): `run_erc` reporting "clean" on a
zero-symbol schematic is misleading — a zero-symbol warning would harden the
gate against any future silent-drop.

**Status:** fixed (primary). Confirmed live — the schematic populates (symbols
appear, ERC runs clean on real content) instead of finishing empty.

---

## Issue 5 — no resilience: a hung turn stalls forever, a failed stage just stops, and every retry re-pays for the same tokens (FEATURE)

**Motivation:** across these runs the pipeline had three reliability gaps. (a) A
single provider turn can run for minutes with no way to tell a slow turn from a
hung one, and nothing ever times it out — a genuinely stuck SDK call would stall
the run indefinitely. (b) When a stage failed or ended without meeting its
contract, `runCreate` simply returned and stopped; the operator had to notice and
re-run by hand. (c) Any retry or restart re-ran the model from scratch, paying
again for identical turns.

**Fix — a recovery layer, all config-gated (`src/config.ts` defaults):**

1. *Turn watchdog* (`turnTimeoutMs`, default 300000). `recovery.ts:withTimeout`
   races each `provider.chat` against a deadline; on timeout the loop tears down
   the hung call (`provider.close()` drops its subprocess/cwd) and retries the
   turn, up to 3 times, before failing the run. A hang now self-heals instead of
   stalling forever.

2. *LLM self-diagnosis + auto-retry* (`maxStageRetries`, default 2). When a stage
   fails or misses its contract, `runCreate` asks the model — on a fresh,
   tool-less turn (`recovery.ts:diagnoseStageFailure`) — to read the failure and
   the transcript tail and return `{verdict: retry|abort, reason, guidance}`. On
   `retry` the stage runs again with the guidance prepended; on `abort`, or once
   the retry budget is spent, the pipeline stops and reports for a human. It fails
   safe: any error/hang/garbage in diagnosis resolves to `abort`, so recovery can
   never itself loop the pipeline.

3. *Response cache* (`llmCache`, default on). `response-cache.ts:CachingProvider`
   hashes each turn's `(messages, tools)` and stores the `Turn` under
   `.copperhead/llm-cache/` (kept out of git by a `*` .gitignore). An identical
   later call — a watchdog retry, an auto-retry that didn't change the prompt, or
   a fresh `copperhead create` after a stop — replays from disk at zero token
   cost, up to the point where inputs first diverge. A retry that *does* change
   the prompt (diagnosis guidance appended) misses and calls the model fresh, so
   the cache never pins the run to a stale failing response.

Tests: `test/recovery.test.ts` (watchdog resolve/timeout/disabled; diagnosis
parse + fail-safe + tool-less; cache hit/replay/zero-usage/miss). Full suite green.

**Status:** implemented.

---

<!--
Issues 6+ were surfaced by driving the pipeline to completion on the USB-C power
breakout brief; the fuller analysis (with the I1-I13 identifiers referenced
below) lives in `../copperhead-test/run-logs/ISSUES-FOUND.md`.
-->

## Issue 6 — `git add -A` aborts on KiCad's git-backed `.history/` local-history dir (BLOCKER, I6)

**Symptom:** the schematic stage did all its work (ERC clean, drift clean, 9
symbols) then the run **failed at commit**: `commit failed: git add -A → error:
'.history/' does not have a commit checked out ... fatal: adding files failed`
(exit 128).

**Root cause:** KiCad >=9 writes a git-backed local-history directory
(`.history/`, with its own nested `.git`) into the project the first time
`kicad-cli` touches it. copperhead runs `kicad-cli` for ERC/DRC, so `.history/`
appears mid-run; left untracked it is a nested repo with an unborn HEAD, so `git
add -A` in the parent aborts. This breaks the commit step of **every**
KiCad-touching stage on any KiCad-10 machine.

**Fix:** `ensureIgnored(repo, ['.history/'])` in [git.ts](src/util/git.ts),
called before every `git add -A` in `commitAll` and `preserveFailedRun`. It
appends `.history/` to the repo's root `.gitignore` (idempotent, best-effort,
never throws). Local history is never a project artifact, so ignoring it is also
correct.

**Status:** fixed.

---

## Issue 7 — stage retry does not re-scaffold after a rollback wipes it (BLOCKER, cascade, I7)

**Symptom:** after a commit failure (Issue 6), the failure path (`restore()`:
`git reset --hard` + `git clean -fd`) deleted the still-untracked scaffold
(`.copperhead/config.json` + the empty KiCad files). The schematic bootstrap ran
**once per stage** (outside the attempt loop), so the retry ran against a missing
config.json and cascaded into ENOENT churn.

**Fix:** `bootstrapKicadProject` is now called at the top of **each attempt** in
the retry loop ([create.ts](src/commands/create.ts)), not once per stage
(idempotent, a no-op when the project exists, re-creates it after a rollback).

**Status:** fixed.

---

## Issue 8 — leaked `/tmp` scratch dirs accumulate across runs and fill the disk (BLOCKER, resource leak, I8)

**Symptom:** ~30 min into a run the filesystem hit 100% and every write failed
with `ENOSPC`, halting the session. The kicad-cli wrapper creates a fresh
`mkdtemp` per ERC/DRC/export and removes it in a `finally`, but a watchdog-killed
turn or aborted stage skips that cleanup, so `copperhead-*` dirs accumulate
across runs.

**Fix:** `sweepStaleTempDirs()` in [tmp.ts](src/util/tmp.ts), called at the top
of `runCreate`, removes leaked `copperhead-*` scratch dirs from earlier runs. It
is **age-gated** (default 2h) so a concurrent run's fresh dirs are never touched,
and best-effort (never throws, never blocks a run). Breaks the cross-run
accumulation that actually filled the disk. Tested in `test/tmp-sweep.test.ts`.

**Status:** fixed (cross-run leak). Intra-run temp-dir reuse and `.history/`
pruning remain documented follow-ups.

---

## Issue 9 — a UTF-8 multibyte char split across a stream chunk lands as U+FFFD in machine-recorded docs (DEFECT, I2)

**Symptom:** a `record_decision` wrote `Rd = 5.1k� ± 5% to GND` to
`docs/DECISIONS.md` — the `Ω` mangled to U+FFFD (`�`). An identical `Ω` a few
turns earlier survived intact, the signature of a multibyte char split across an
SDK streaming chunk boundary and decoded per-chunk upstream.

**Fix:** `corruptionError()` in [tools.ts](src/agent/tools.ts) rejects any
`write_file`/`edit_file`/`record_decision` whose content-bearing args contain
U+FFFD, returning a message that tells the model to re-emit the value (or spell
it ASCII). The corruption is nondeterministic, so the retry almost always lands
clean; U+FFFD never appears in a legitimate PCB doc, so there are no false
positives. Tested in `test/corruption-guard.test.ts`. The root decode bug is
upstream in the SDK.

**Status:** mitigated in copperhead (guard); root cause upstream.

---

## Issue 10 — schematic symbols are LLM-authored, so a canonical lib_id can carry invented pins (DEFECT-risk + INEFFICIENCY, I9 + I4)

**Symptom:** the schematic-stage prompt had the model hand-draw the entire
`lib_symbols` block (every pin, name, electrical type, geometry). Each lib_id was
a real canonical KiCad part, but the pins under it were invented, so a
`USB_C_Receptacle_USB2.0` with a wrong shield/CC pin would pass ERC (which only
checks the net graph as drawn) while being wrong. The model also burned turns
iterating grid alignment on geometry it should never have authored.

**Fix:** new [symlib.ts](src/kicad/symlib.ts) and a `verify_symbols` tool
([tools.ts](src/agent/tools.ts)) read the installed `.kicad_sym` libraries,
resolve each `lib_symbols` entry by lib_id (following `extends`), and report pins
that diverge from the real part plus lib_ids that do not exist in the installed
KiCad (with the closest real names). The stage prompt
([create.ts](src/commands/create.ts)) now directs the model to (a) work **one
part at a time** with a `run_erc` after each, so a geometry slip stays local
instead of forcing a full-block rewrite (I4), and (b) run `verify_symbols` and
reconcile every finding, adopting the real name when a symbol was renamed across
KiCad versions. Verification rather than blind auto-splice: KiCad 10 renamed the
brief's `USB_C_Receptacle_USB2.0`, so a by-lib_id splicer would fail on the most
important part. Tested in `test/symlib.test.ts`.

**Status:** fixed (verification + prompt). Full auto-resolver remains a
follow-up.

---

## Issue 11 — drift checker misreads doc tables, positional columns, and byte-exact values (BLOCKER + INEFFICIENCY, I5 + I12 + I11)

**Symptom:** at the finish gate `check_drift` produced false mismatches on
already-correct docs, three distinct ways: (a) a second table in BOM.md/PINOUT.md
(a quiescent-current roll-up, a net legend) had its rows read as parts/pins "not
in schematic" (I5); (b) a reasonable 3-column `Refdes|Pin|Net` PINOUT read the
Net by a fixed index 3 and reported every pin as `NC`, an unwinnable finish loop
that burned ~163k tokens (I12); (c) semantically-identical value encodings
(`Ihold≥3A` vs `Ihold>=3A`, `0.1"` vs `0.1in`) compared with raw `!==` and
whack-a-moled the model across finish attempts (I11).

**Fix (all in [bom-table.ts](src/memory/bom-table.ts) +
[drift.ts](src/memory/drift.ts)):**
- `parseCanonicalTables`/`parseCanonicalRows` keep only the table(s) whose header
  is a Refdes/Pin contract row, ignoring supporting tables (I5).
- `parsePinoutRows` resolves Refdes/Pin/Net by **header name**, tolerant of the
  optional Name/Notes columns, stripping backticks; `pinoutColumnReport` lets the
  gate say "no Net column" instead of emitting per-pin `NC` (I12).
- `foldEncodings`/`normalizeValue` fold the common equivalences (≥/>=, Ω/ohm,
  µ/u, the inch mark, smart quotes) and compare case/space-insensitively, so only
  a semantic value difference is flagged; applied to the value and footprint
  compares (I11).

Tested in `test/bom-table.test.ts` (auxiliary-table isolation, header-name
column resolution, semantic value equality).

**Status:** fixed.

---

## Issue 12 — a malformed fenced tool call is silently dropped; the model misdiagnoses it as a broken tool (INEFFICIENCY + DEFECT-in-artifact, I10)

**Symptom:** the model emitted a `{"tool":...}` block one closing brace short.
The tolerant parser could not balance the outer object, matched the inner `args`
object (no `tool` key), dispatched **zero calls with no error**, and the model
concluded the *tool* was broken, wrote that false claim into a committed stage
summary, and fell back to slower single-item calls.

**Fix:** `detectMalformedCall` in
[claude-code.ts](src/agent/providers/claude-code.ts) recognizes the near-miss (a
turn that dispatched no call but whose text names a catalog tool via
`"tool":"<name>"`) and returns a one-line re-emit nudge, plumbed through a new
`Turn.nudge` field ([types.ts](src/agent/types.ts)); the loop
([loop.ts](src/agent/loop.ts)) surfaces it in place of the generic continue
prompt. Preserves the parser's no-throw contract, adds a signal exactly where the
silence misled. Tested in `test/claude-code-provider.test.ts`.

**Status:** fixed.

---

## Issue 13 — the turn-timeout budget is cumulative per stage, so a few slow-but-recovered turns hard-fail a healthy stage (INEFFICIENCY, I1)

**Symptom:** `maxTurnTimeouts` is a cumulative budget of 3 for the whole stage.
Large-output capture turns (a full `lib_symbols` + instances edit, ~40k output
tokens) legitimately run several minutes; sporadic timeouts on independent big
turns accumulate and hard-fail a stage that was only slow, not stuck.

**Fix:** the per-stage timeout floor was raised (300000 → 600000 in
[config.ts](src/config.ts)), and [loop.ts](src/agent/loop.ts) now resets the
timeout budget on any **productive** turn, so the budget catches a genuinely,
repeatedly stuck turn rather than capping the total count of recoverable slow
turns.

**Status:** fixed. Deeper per-turn-deadline backoff remains a follow-up.

---

## Issue 14 — no way to tell a slow turn from a hung one, no whole-run cost view, no printed resume point (OBSERVABILITY, 5.1 / 5.2 / 5.3)

**Motivation:** a 44k-char turn looked identical to a hang for up to 10 minutes;
a design's cost was scattered across per-stage summaries with nothing aggregating
them; and on a stop the operator had to reconstruct the resume command by hand.

**Fix:**
- *Liveness heartbeat (5.1).* A streaming provider reports cumulative
  streamed-output length via a new `ChatOpts.onStream`
  ([types.ts](src/agent/types.ts),
  [claude-code.ts](src/agent/providers/claude-code.ts)); the loop
  ([loop.ts](src/agent/loop.ts)) emits a periodic elapsed/streamed heartbeat
  (`heartbeatMs`, default 30000) rendered by
  [render.ts](src/agent/render.ts), so a working large turn visibly grows while a
  hung one stays frozen.
- *Per-stage cost table (5.2).* `RunResult` now carries `stats` + `cacheHits`
  (`CachingProvider.cacheHits`,
  [response-cache.ts](src/agent/response-cache.ts)); `runCreate`
  ([create.ts](src/commands/create.ts)) accumulates per-stage wall/turns/tokens/
  cache-hit% across attempts and prints a stage-by-stage table with a TOTAL at
  the end of the run (and on a stop).
- *Resume point (5.3).* On any stop, `runCreate` prints the exact
  `copperhead create ...` command (reconstructed from the run's own options) and
  which stage it resumes at.

Tested in `test/observability.test.ts` and `test/create-stage-turns.test.ts`.

**Status:** implemented.

---

## Issue 15 — a saved-login session/usage limit hard-fails the run as a generic provider error (ROBUSTNESS, I13)

**Symptom:** mid-layout a run died with `provider error: ... You've hit your
session limit · resets 1:40pm` and exited 1 like any other failure. But this is a
subscription usage cap: transient, time-scheduled (it names its own reset), and
every completed turn is already in `.copperhead/llm-cache/`, so re-running after
the reset replays them at ~0 tokens and resumes in place.

**Fix:** `sessionLimit()` in [retry.ts](src/util/retry.ts) detects this specific
error (distinct from a 429 and from a code bug) and extracts the reset time
verbatim; [loop.ts](src/agent/loop.ts) records a distinct `session-limit`
transcript event ([transcript.ts](src/agent/transcript.ts)) and surfaces the
reset time plus the resume path instead of a bare provider error. Tested in
`test/session-limit-disk.test.ts`.

**Status:** implemented (detection + surfacing). Optional auto-sleep-until-reset
remains a follow-up.

---

## Issue 16 — a full disk fails mid-run with an opaque ENOSPC (ROBUSTNESS, 4.1)

**Symptom:** when the filesystem was nearly full, a run failed partway through
with a raw `ENOSPC` from whichever write happened to lose, giving the operator no
actionable signal.

**Fix:** `assertDiskSpace()` in [preflight.ts](src/util/preflight.js) checks free
space (`statfs`) at the top of `runCreate` and refuses to start with an
actionable message when it is below a threshold (default 2 GiB, override
`COPPERHEAD_MIN_FREE_MB`). An unknown reading on an unsupported platform skips the
check rather than blocking a legitimate run. Pairs with Issue 8 (the temp-dir
sweep that reclaims the space in the first place). Tested in
`test/session-limit-disk.test.ts`.

**Status:** implemented.

---

## Issue 17 — claude-code re-sends the whole conversation every turn (~quadratic cost) (EFFICIENCY, 1.1)

**Symptom:** the claude-code provider spawns a fresh SDK subprocess per turn and
flattens the entire prior conversation into the prompt each call, so cost grows
~quadratically in turns; a single stage re-billed most of its history every turn.

**Fix:** opt-in session resume in
[claude-code.ts](src/agent/providers/claude-code.ts): once the SDK reports a
session id, the provider resumes it (`Options.resume`) and sends only the
messages added since the last turn (`renderDelta`), instead of replaying the
whole history. `makeProvider` ([loop.ts](src/agent/loop.ts)) enables it only when
the response cache is off (the two are mutually exclusive: the cache replays
turns the resumed session never saw). The system prompt
([prompts.ts](src/agent/prompts.ts)) also now tells the model to batch
independent tool calls in one reply and never open a stage with an empty-args
probe call, since turns are the scarce resource (1.4).

**Status:** implemented (opt-in).

---
