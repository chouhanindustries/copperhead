---
title: CLI reference
description: Every copperhead command, flag, and exit code.
sidebar:
  order: 1
---

```text
copperhead [global options] [<command>]
```

With no subcommand, `copperhead` starts the interactive agent shell. Every command probes `kicad-cli` before doing anything and exits 1 if it cannot be found (two exceptions: `doctor` reports a missing binary instead of failing, and `create --dry-run` is deterministic and needs neither `kicad-cli` nor a model). Resolution order: `COPPERHEAD_KICAD_CLI` when set, then `kicad-cli` on your `PATH`, then the macOS KiCad.app bundle locations. Setting `COPPERHEAD_KICAD_CLI` to a path that does not exist is an error naming that path, not a silent fall back to `PATH`. A `.env` in the working directory is loaded before any command resolves a model or a provider; a real environment variable always beats the file.

## Commands at a glance

| Command | Flow | LLM? | What it does |
| --- | --- | --- | --- |
| `repl` (default) | [Edit an existing board](/workflows/edit-existing-board/) | Yes | Interactive agent shell; each prompt is one `do`-equivalent run. |
| `demo` | [Simple demo](/getting-started/demo/) | Tour no / pipeline yes | Tour of what copperhead does, or run the USB-C breakout create pipeline. |
| `init` | Setup | No | Scaffolds `docs/` from an existing schematic. |
| `check` (`verify`) | Either | No | ERC, DRC, drift, constraints, spec validation. CI-safe. |
| `do` | [Edit an existing board](/workflows/edit-existing-board/) | Yes | One change: propose, edit, verify, propagate, commit. |
| `create` | [Design from a brief](/workflows/create-from-brief/) | Yes | Full pipeline from a markdown brief to an output package. |
| `sync` | Either | Verify phase no, resolve phase yes | Reconciles docs, files, and constraints. |

## Global options

| Option | Description |
| --- | --- |
| `--repo <path>` | Target repository. Defaults to the current directory. |
| `--json` | Machine-readable output on stdout. |
| `-V, --version` | Print the version. |

Global options go before the subcommand: `copperhead --json check`.

## `copperhead` / `copperhead repl`

Interactive agent shell (default when no command is given). On a TTY it takes over the full window (alternate screen, restored on exit): banner on top, input pinned at the bottom, each line runs the same gated loop as `copperhead do`, then returns to the prompt. Ctrl+C twice exits; PgUp/PgDn scroll the session history; Esc dismisses the slash menu; a pasted multi-line request arrives as one request instead of submitting at its first newline. Every session mirrors its log to `.copperhead/runs/repl-<timestamp>.log` (ANSI stripped, secrets redacted with the same write-time redactor as the run transcripts).

```bash
copperhead
copperhead "add reverse-polarity protection on VIN"   # seed request, then stay in the shell
copperhead repl --model claude-code
```

| Option | Description |
| --- | --- |
| `--model <model>` | Model / provider selection (same as `do`). When no model is configured anywhere (flag, `COPPERHEAD_MODEL`, config, `.env` API keys), the shell offers an interactive picker instead of refusing to start. |
| `--max-turns <n>` | Turn budget per request. |
| `--allow-dirty` | Permit a dirty working tree, same meaning and same default (off) as on `do`. |
| `--interactive` | Pause for approval after each proposal validates. |

Slash commands inside the shell: `/help`, `/demo`, `/examples`, `/status`, `/check`, `/parts`, `/nets`, `/bom`, `/sync`, `/drift`, `/constraints`, `/openspec`, `/config`, `/git`, `/runs`, `/last`, `/model`, `/version`, `/clear`, `/quit` (`/exit`, `/q`). Type `/` to see live filtered suggestions immediately; ↑/↓ + Enter picks one, Tab completes. `/model` opens an arrow-key picker and switches the session model in place. Requires a TTY (or a seed request for a one-shot non-TTY run). `--json` is refused; use `copperhead do … --json` instead.

## `copperhead demo`

Tour of what the agent does, or an end-to-end create pipeline against the packaged USB-C power breakout brief (same as `npm run demo:simple`).

```bash
copperhead demo --tour                 # overview only (no LLM)
copperhead demo --model cursor         # scaffold + create pipeline
copperhead demo --dir /tmp/my-demo     # custom demo repo path
```

| Option | Description |
| --- | --- |
| `--tour` | Print the overview and exit. Honours the global `--json`, which emits `{ "tour": [...lines] }`. |
| `--model <model>` | Model for the create pipeline. |
| `--interactive` | Re-enable human gates during create. |
| `--dir <path>` | Demo repo directory. Default `demo-runs/usb-c-breakout` (or `COPPERHEAD_DEMO_DIR`). |

## `copperhead init`

Scaffolds design docs from an existing schematic. Idempotent.

```bash
copperhead init [--path <dir>] [--force] [--no-hooks]
```

| Option | Description |
| --- | --- |
| `--path <dir>` | Where to look for KiCad files. Default `.`. |
| `--force` | Overwrite generated docs that have been hand-edited. |
| `--no-hooks` | Skip installing the git pre-commit hook. |

Reports each file as `created`, `unchanged`, or `REFUSED`. Exits 1 if anything was refused, 0 otherwise.

## `copperhead do`

The core loop: propose, edit, verify, propagate, commit.

```bash
copperhead do "<change request>" [options]
```

| Option | Description |
| --- | --- |
| `--model <model>` | `codex`, `cursor`, `gpt-5`, `claude`, `claude-code`, or a provider-specific model id. Saved-login providers: `codex` (Codex CLI), `cursor` (Cursor Agent CLI), `claude-code` (Claude Code). |
| `--max-turns <n>` | Turn budget for this run. Overrides `maxTurns` from config. |
| `--allow-dirty` | Permit a dirty working tree. The snapshot keeps tracked changes as a `git stash create` object and untracked files as a tree object, so a rollback restores both. |
| `--dry-run` | Propose the diff and write nothing. |
| `--interactive` | Pause for approval once the proposal validates. |

Exits 1 if the run ends in failure, 0 otherwise.

## `copperhead check`

Alias: `copperhead verify`.

```bash
copperhead check
```

Runs ERC, DRC, doc-drift detection, constraint checks, and OpenSpec validation. Makes **no LLM calls and no network requests**, which is a contract, not a tendency: this is what makes it safe to run in CI and in a pre-commit hook.

ERC and DRC are skipped when no schematic or board is configured, rather than failing.

| Exit code | Meaning |
| --- | --- |
| `0` | Everything agrees. |
| `1` | At least one check failed, or `kicad-cli` is missing. |

With `--json`, prints a result object with `ok` plus per-check detail for `erc`, `drc`, `drift`, `openspec`, and `constraints`.

## `copperhead doctor`

```bash
copperhead doctor [--model <model>]
```

Environment preflight: checks whether this machine can actually run a copperhead command, **before** you start one. Unlike `check`, it looks at the model provider, the one thing `check` cannot, since `check` is contractually LLM-free. Makes **no LLM calls and no network requests**; the credential check is presence-only (it verifies a required API key is set, not that it authenticates).

Checks, in order:

- **node** — at least the version copperhead requires.
- **kicad-cli** — present on PATH (a missing binary is reported, not thrown).
- **git** — present on PATH (copperhead snapshots and commits its work).
- **provider** — resolves the model the same way a run does (`--model` > `COPPERHEAD_MODEL` > config > available key) and checks its credential. Saved-login providers (`codex`, `cursor`, `claude-code`) need no key and report `info`.
- **project** — informational: whether `.copperhead/config.json` exists and what it wires. Never blocks.

| Exit code | Meaning |
| --- | --- |
| `0` | Ready — no critical check failed. |
| `1` | Not ready — a `[FAIL]` item needs fixing. |

With `--json`, prints `{ ok, checks: [{ name, status, detail, hint? }] }`.

## `copperhead sync`

Verifies the whole design state and resolves drift. Two phases: a deterministic verify phase, then an LLM resolve phase.

```bash
copperhead sync [--model <model>] [--dry-run]
```

| Option | Description |
| --- | --- |
| `--model <model>` | Model for the resolve phase. |
| `--dry-run` | Print the inconsistency report and write nothing. |

| Exit code | Meaning |
| --- | --- |
| `0` | Clean, or drift resolved successfully. |
| `1` | The resolve phase failed. |
| `2` | Requirement violations found. |

Exit code 2 is the important one. A requirement violation means the as-built design contradicts a stated requirement, and copperhead will **never** auto-resolve that: the fix is an engineering decision. Drift, where the docs disagree with the files, is resolvable and gets resolved.

## `copperhead create`

The full pipeline from a product brief to the output package.

```bash
copperhead create --brief brief.md [--model <model>] [--interactive]
copperhead create --brief brief.md --stage <name>   # re-run one stage, propagate real changes
copperhead create --brief brief.md --from <name>    # re-run a stage and everything downstream
copperhead create --brief brief.md --dry-run        # classify stages, write nothing
```

| Option | Description |
| --- | --- |
| `--brief <file>` | **Required.** The product brief, in markdown. |
| `--model <model>` | `codex`, `cursor`, `gpt-5`, `claude`, or `claude-code` (saved-login; no model API key for those three). |
| `--interactive` | Re-enable the human gates: spec approval, a pause before export, and confirmation before newly invalidated stale stages reconcile (staleness known at plan time is simply part of the run). |
| `--stage <name>` | Re-run exactly one stage against the existing artifacts (revise, not recreate), then reconcile every stage that consumes an output the re-run actually changed. Mutually exclusive with `--from`. |
| `--from <name>` | Force-re-run the named stage and its graph descendants: the stages reachable through consumed artifacts, not simply every later stage. |
| `--dry-run` | Print each stage's classification (`fresh`, `stale` with the changed artifacts, `incomplete`, `assumed-complete`) and what the invocation would run, then exit without writing. |

Exits 0 when the pipeline finishes and the final `check` is green; 1 if any stage fails to complete or the final `check` fails. Unknown stage names exit 1 and list the valid ones.

### Pipeline stages

Each stage is a full `do` loop with its own prompt and gate, and declares which artifacts it consumes and produces, so the stage dependency graph is data. When a stage completes, its commit records content hashes of those artifacts in `.copperhead/create-state.json`; a stage whose recorded inputs no longer match the working tree is *stale*. A plain `create` run re-runs stale and incomplete stages and skips fresh ones, so the pipeline is resumable and self-healing: rerun the same command after a failure, or after any edit that touched a stage's inputs, and exactly the affected stages run again.

| # | Stage | Consumes | Produces |
| --- | --- | --- | --- |
| 1 | `spec-seed` | the brief | `docs/SPEC.md`, plus every budget recorded as a constraint |
| 2 | `architecture` | spec | `docs/SUBSYSTEMS.md` |
| 3 | `part-selection` | spec, subsystems | `docs/BOM.md`, MPNs flagged `UNVERIFIED` |
| 4 | `schematic` | bom, subsystems | The `.kicad_sch` (ERC clean after each sheet) and `docs/PINOUT.md` |
| 5 | `layout-draft` | schematic | The `.kicad_pcb` (DRC clean) plus a `## Draft quality` section in `LAYOUT.md` |
| 6 | `outputs` | board, bom | `outputs/`: gerbers, drill, DXF, STEP, SVG, `BOM.csv` |
| 7 | `firmware` | pinout | `firmware/` scaffold, `pins.h` generated from `PINOUT.md` |
| 8 | `devplan` | schematic, firmware, layout-intent | `docs/DEVPLAN.md` |

Use these stage names with `--stage` and `--from`. Stages build on each other's uncommitted state, so `create` runs them as if `--allow-dirty` were set.

## Repo scripts

These are npm scripts in a copperhead checkout, not installed CLI commands.

| Script | What it does |
| --- | --- |
| `npm run demo:simple` | Runs the create pipeline against `examples/simple/usb-c-breakout.md` in `demo-runs/usb-c-breakout/`. See [Simple demo](/getting-started/demo/). |
| `npm run docs:dev` | Serves this documentation locally. |
| `npm run docs:build` | Builds the documentation site. |
| `npm test` | Runs the vitest suite. LLM-touching tests skip unless their provider is explicitly configured. |
| `npm run typecheck` | Type-checks without emitting. |
| `npm run build` | Compiles to `dist/`. |

Pass `create` flags through after `--`, for example `npm run demo:simple -- --model claude`. Override the target directory with `COPPERHEAD_DEMO_DIR`.
