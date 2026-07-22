---
title: CLI reference
description: Every copperhead command, flag, and exit code.
sidebar:
  order: 1
---

```text
copperhead [global options] <command>
```

Every command probes `kicad-cli` before doing anything and exits 1 if it is not on your `PATH`. A `.env` in the working directory is loaded before any command resolves a model or a provider; a real environment variable always beats the file.

## Commands at a glance

| Command | Flow | LLM? | What it does |
| --- | --- | --- | --- |
| `init` | Setup | No | Scaffolds `docs/` from an existing schematic. |
| `check` (`verify`) | Either | No | ERC, DRC, drift, constraints, spec validation. CI-safe. |
| `do` | [Edit an existing board](/workflows/edit-existing-board/) | Yes | One change: propose, edit, verify, propagate, commit. |
| `create` | [Design from a brief](/workflows/create-from-brief/) | Yes | Full pipeline from a markdown brief to an output package. |
| `sync` | Either | Verify phase no, resolve phase yes | Reconciles docs, files, and constraints. |
| `export bom` | Ordering | No | Writes a supplier-format BOM from `docs/BOM.md`. Deterministic, no network. |

## Global options

| Option | Description |
| --- | --- |
| `--repo <path>` | Target repository. Defaults to the current directory. |
| `--json` | Machine-readable output on stdout. |
| `--plain` | Plain log-style output with no interactive status line. Useful for CI logs and pipes. |
| `-V, --version` | Print the version. |

Global options go before the subcommand: `copperhead --json check`.

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
| `--model <model>` | `codex`, `gpt-5`, `claude`, `claude-code`, or a provider-specific model id. `codex` uses the saved local Codex login; `claude-code` uses your logged-in Claude Code (no `ANTHROPIC_API_KEY`). See [Configuration](/reference/configuration/#saved-login-claude-code). |
| `--max-turns <n>` | Turn budget for this run. Overrides `maxTurns` from config. |
| `--allow-dirty` | Permit a dirty working tree. The snapshot is taken with `git stash create`. |
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
```

| Option | Description |
| --- | --- |
| `--brief <file>` | **Required.** The product brief, in markdown. |
| `--model <model>` | `codex`, `gpt-5`, `claude`, or `claude-code` (saved-login Claude Code, no `ANTHROPIC_API_KEY`). |
| `--interactive` | Re-enable the human gates: spec approval, and a pause before export. |

Exits 1 if any stage fails to complete, 0 when the pipeline finishes.

### Pipeline stages

Each stage is a full `do` loop with its own prompt and gate. Stage completion is inferred from repo state, so the pipeline is resumable: rerun the same command after a failure and it skips what is done and resumes at the first incomplete stage.

| # | Stage | Produces |
| --- | --- | --- |
| 1 | `spec` | `docs/SPEC.md`, plus every budget recorded as a constraint |
| 2 | `architecture` | `docs/SUBSYSTEMS.md` |
| 3 | `parts` | `docs/BOM.md`, MPNs flagged `UNVERIFIED` |
| 4 | `schematic` | The `.kicad_sch`, ERC clean after each sheet |
| 5 | `layout` | Draft placement and critical routing, DRC clean, plus a `## Draft quality` section in `LAYOUT.md` |
| 6 | `outputs` | `outputs/`: gerbers, drill, DXF, STEP, SVG, `BOM.csv`, and a JLCPCB assembly BOM (`outputs/jlcpcb-bom.csv`, as [`export bom`](#copperhead-export-bom) writes) |
| 7 | `firmware` | `firmware/` scaffold, `pins.h` generated from `PINOUT.md` |
| 8 | `devplan` | `docs/DEVPLAN.md` |

Stages build on each other's uncommitted state, so `create` runs them as if `--allow-dirty` were set.

## `copperhead export bom`

Turns the drift-checked `docs/BOM.md` into a file a supplier accepts without hand-editing. Deterministic, LLM-free, and network-free, so it is safe anywhere `check` is. It reads `BOM.md` (never the schematic), so it inherits the drift guarantee and refuses to export while `BOM.md` disagrees with the schematic.

```bash
copperhead export bom --supplier <name> [--boards <n>] [--spares <percent>] [--include-unverified]
```

| Option | Description |
| --- | --- |
| `--supplier <name>` | **Required.** `jlcpcb`, `digikey`, or `mouser`. JLCPCB gets the assembly-service format (Comment, Designator, Footprint, LCSC Part #, designators grouped per line); DigiKey and Mouser get cart-upload lists (MPN, manufacturer, quantity, customer reference). |
| `--boards <n>` | Order quantity in boards. Default `1`. |
| `--spares <percent>` | Spare-parts percentage. Default `10`. |
| `--include-unverified` | Opt `UNVERIFIED` rows that carry an MPN back in. Never includes MPN-less rows. |

Writes `outputs/<supplier>-bom.csv` and prints the path plus the included/excluded counts. Per-line quantity is `ceil(perBoardCount × boards × (1 + spares/100))`, raised to `perBoardCount × boards + 2` for passive lines (footprints `R_`/`C_`/`L_`), because percentage-only spares under-order low-count passives.

Rows without an MPN, and rows still flagged `UNVERIFIED`, are excluded from the supplier file and named in a warnings footer on stderr (stdout stays clean for `> file` redirects).

`docs/BOM.md` may carry optional `Manufacturer` and `LCSC` columns beyond the base `Refdes | Value | Footprint | MPN | Rationale`; the exporter matches columns by header, so add them when you want them populated. Only *appending* columns is safe: keep `Refdes | Value | Footprint` first and in that order, because the drift check reads those three by position.

| Exit code | Meaning |
| --- | --- |
| `0` | The supplier file was written. |
| `1` | A bad flag, a missing `BOM.md`, or drift between `BOM.md` and the schematic. |

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
