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

**Status:** fixed (primary). Re-running to confirm the schematic populates.

---
