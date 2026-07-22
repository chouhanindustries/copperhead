<p align="center">
  <a href="https://copperhead.sh"><img src="https://raw.githubusercontent.com/chouhanindustries/copperhead/main/docs/branding/lockup-transparent.png" alt="copperhead" width="440"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/copperhead"><img src="https://img.shields.io/npm/v/copperhead?color=b87333" alt="npm"></a>
  <a href="https://github.com/chouhanindustries/copperhead/actions/workflows/ci.yml"><img src="https://github.com/chouhanindustries/copperhead/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/copperhead?color=15181c" alt="license"></a>
</p>

**Cursor for circuit boards.** An AI agent that designs, documents, and validates real PCBs from a prompt, working directly on existing KiCad repositories.

> **Status: early.** Phase 1 is implemented and the CLI runs. The [technical specification](openspec/specs/SPEC.md) is the source of truth; expect the surface to move before 1.0.

Full documentation lives at [docs.copperhead.sh](https://docs.copperhead.sh).

## What it is

An AI product-development agent for hardware: from a product brief to manufacturable files, firmware, and a build plan.

- **`copperhead create`**: full pipeline from a natural-language brief: spec, architecture, part selection, schematic, first-draft layout, then gerbers, firmware scaffold, and dev plan.
- **`copperhead do "<change>"`**: operates on an existing KiCad repo the way a coding agent operates on a codebase.

It reads and edits real `.kicad_sch` / `.kicad_pcb` files (s-expression text), maintains markdown design docs as memory, propagates every change across all artifacts that reference it, and verifies its own work by running `kicad-cli` ERC/DRC until the checks pass.

## Install

```bash
npm install -g copperhead   # or: npx copperhead check
```

### Requirements

- Node.js ≥ 20
- [KiCad](https://www.kicad.org/) ≥ 8 with `kicad-cli` on PATH
- One model backend: a locally installed, ChatGPT-authenticated [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), or `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the environment. `check` never calls an LLM.

## Quick start

In an existing KiCad repository:

```bash
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY
copperhead init                # scaffold docs/ from the schematic; idempotent
copperhead do "add reverse-polarity protection on VIN"
copperhead check               # ERC + DRC + doc drift; no LLM, CI-safe
```

Starting from nothing instead? Write a product brief and run `copperhead create --brief brief.md`. The [examples/](examples/) directory has ready-made briefs sorted by difficulty, plus a note on which one is designed to fail.

### Use your existing Codex login

No model API key is needed when Codex CLI is already authenticated:

```bash
npm install -g @openai/codex-sdk   # optional adapter, loaded only for --model codex
codex login status
copperhead do "rename net KEY_DAH to KEY_DASH" --model codex
```

Plain `codex` follows your Codex model configuration. Use `codex:<model-id>` for an explicit model. If the executable is not on `PATH`, set `COPPERHEAD_CODEX_PATH=/absolute/path/to/codex`.
The optional SDK also installs a compatible launcher; for a global install, use
`COPPERHEAD_CODEX_PATH="$(npm root -g)/@openai/codex/bin/codex.js"` as a fallback.

Codex's read-only sandbox prevents native writes but does not confine native reads. Copperhead instructs Codex not to use its own filesystem tools, but the CLI can technically read files such as `.env`. Codex also keeps session logs under `~/.codex/sessions/`; those files are outside Copperhead's transcript-redaction boundary and should be protected according to your local data-retention policy.

## How it works

It's a loop, and it looks a lot like pair-programming, except the codebase is a circuit board.

1. **Start from the docs.** Every decision lives in the design docs, so the agent reads those first and knows the whole design, not just the part in front of it.
2. **Talk through the change.** Describe what you want ("add an external key jack", "cut the sleep current"). The agent proposes the parts and circuit; you push back until the reasoning holds up.
3. **Edit the real files.** The agent writes changes straight into the KiCad schematic and the design docs, using the same part names and net names everywhere so nothing drifts.
4. **Propagate.** Change one value, like a charge current or a pin, and it carries across every doc and schematic that references it. The boring, easy-to-get-wrong step is the one the agent is best at.
5. **Check the work.** The agent runs ERC/DRC, reads the errors back, and fixes them. Nothing is "done" until the tools agree.
6. **Write down why.** Every real decision gets a one-line reason next to it, so the next change doesn't quietly undo it.

Two invariants make this trustworthy:

1. **Nothing starts without a spec.** The agent cannot touch a KiCad file until a validated change proposal exists; the edit tools are structurally unavailable until it does. Every edit is traceable to a documented intent.
2. **Nothing is "done" until the tools agree.** Every file mutation is followed by an ERC/DRC run before the agent reports success.

Spec-gated in, verification-gated out: the design can't drift from its requirements, because drift is a build failure.

## CLI

```text
copperhead init [--path hardware/]   # scaffold docs/ from an existing schematic; idempotent
copperhead do "<change request>"     # the core loop: propose, edit, verify, propagate, commit
copperhead check                     # ERC + DRC + doc-drift + spec validation; no LLM calls (alias: verify)
copperhead sync [--dry-run]          # verify the whole design state, resolve drift
copperhead create --brief brief.md   # brief → full output package
copperhead export bom --supplier jlcpcb   # supplier-ready ordering file from docs/BOM.md
```

Global flags: `--repo <path>` (default: cwd) and `--json` for machine-readable output. `do` and `create` take `--model` and `--interactive`; `do` also takes `--dry-run`, `--max-turns`, and `--allow-dirty`.

### Ordering (`export bom`)

`copperhead export bom` turns the drift-checked `docs/BOM.md` into a file a supplier accepts without hand-editing. It is deterministic, LLM-free, and network-free — safe anywhere `check` is, and it reads `BOM.md` (never the schematic) so it inherits the drift guarantee; it refuses to export while `BOM.md` disagrees with the schematic.

```bash
copperhead export bom --supplier jlcpcb                 # JLCPCB assembly CSV → outputs/jlcpcb-bom.csv
copperhead export bom --supplier digikey --boards 25    # DigiKey cart CSV, quantities for 25 boards
copperhead export bom --supplier mouser --spares 15     # Mouser cart CSV, 15% spare parts
```

- `--supplier <jlcpcb|digikey|mouser>` (required). JLCPCB gets the assembly-service format (Comment, Designator, Footprint, LCSC Part #, designators grouped per line); DigiKey and Mouser get cart-upload lists (MPN, manufacturer, quantity, customer reference).
- `--boards <n>` (default 1) and `--spares <percent>` (default 10) set the order quantity: `ceil(perBoardCount × boards × (1 + spares/100))`, raised to `perBoardCount × boards + 2` for passive lines (footprints `R_`/`C_`/`L_`) — losing a couple of 0402s to tweezers is the norm, and percentage-only spares under-order low-count passives.
- Rows without an MPN, and rows still flagged `UNVERIFIED`, are excluded from the supplier file and named in a warnings footer on stderr. `--include-unverified` opts the flagged-but-MPN'd rows back in (it never includes MPN-less rows). `create` stage 6 also emits `outputs/jlcpcb-bom.csv` automatically.

`docs/BOM.md` may carry optional `Manufacturer` and `LCSC` columns beyond the base `Refdes | Value | Footprint | MPN | Rationale` — the exporter matches columns by header, so add them when you want them populated in supplier files; `init` scaffolds the base columns only. Only *appending* columns is safe: keep `Refdes | Value | Footprint` first and in that order, because the drift check (`check`/`sync`, which the exporter gates on) reads those three by position — reordering them makes it compare the wrong cells and refuse the export with a spurious drift message.

Nothing is a black box: decisions land in an append-only `docs/DECISIONS.md`, every run writes a human-readable summary next to its transcript, and a per-run `docs/CHANGELOG.md` narrates the design history.

## What it is not

- **Not an autorouter.** Routing stays human or delegated; copperhead produces the DRC-clean draft that layout tools optimize from.
- **Not a new editor.** No walled garden; your KiCad install remains the editor.
- **Not the engineer of record.** A human signs off; the agent never claims a design is fab-ready beyond "ERC/DRC clean".

## Simple demo

From a checkout of this repo, run the smallest create-pipeline demo with the USB-C power breakout brief:

```bash
npm run demo:simple
```

The script creates or resumes a git repo at `demo-runs/usb-c-breakout/` and runs:

```bash
copperhead create --brief examples/simple/usb-c-breakout.md
```

Pass normal create flags after `--`, for example `npm run demo:simple -- --model claude`.
If a stage fails, rerun the same command; the demo repo keeps a baseline commit and ignores run transcripts so retries start from the last committed design state.

More briefs, including medium and hard tiers, live in [examples/](examples/).

## Maturity

Honest read of where the current release stands, so you can calibrate before pointing this at a board you care about:

- **Solid.** `init` and `check`/`verify` are deterministic, LLM-free, and covered by the offline test suite against a real KiCad fixture: scaffolding, ERC/DRC, the s-expression reader, drift detection, and fab export all run green in CI.
- **Implemented, not yet proven.** The agent loop (`do`, `sync --resolve`, `create`) is complete and structurally gated, but its acceptance tests need a live model and have not been observed passing end to end. Expect rough edges.
- **Always.** Every mutation runs inside a git snapshot and rolls back if verification fails, so the worst case is a no-op commit, not a mangled schematic. Work on a branch anyway.

## Open source

The entire tool (agent core, prompts, tools) is public under Apache-2.0, built on an open stack (KiCad, kicad-cli, [OpenSpec](https://github.com/Fission-AI/OpenSpec)). Everything it produces is plain markdown and JSON in your own repo: no proprietary formats, no lock-in. This is a Chouhan Industries project, and the same commitment that puts every hardware schematic in public applies to the tool that designs them.

## Contributing

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for setup and workflow. Note that your first pull request requires signing the [Contributor License Agreement](.github/cla/CLA.md); a bot posts instructions on the PR and signing is a one-time comment.

## Project layout

- [`AGENTS.md`](AGENTS.md): repository instructions loaded automatically by Codex and compatible coding agents; [`CLAUDE.md`](CLAUDE.md) provides the corresponding Claude Code guidance
- [`src/`](src/): CLI ([`cli.ts`](src/cli.ts), [`commands/`](src/commands/)), the provider-agnostic agent loop ([`agent/`](src/agent/)), the `kicad-cli` wrapper and s-expression reader ([`kicad/`](src/kicad/)), and doc/constraint memory ([`memory/`](src/memory/))
- [`test/`](test/): offline suite plus [`fixtures/`](test/fixtures/), a tiny known-good KiCad project
- [`openspec/specs/SPEC.md`](openspec/specs/SPEC.md): the full technical specification, including binary acceptance criteria
- [`openspec/changes/build-copperhead-phase-1/`](openspec/changes/build-copperhead-phase-1/): the implementation plan with proposal, design decisions, capability specs, and task checklist

## License

[Apache-2.0](LICENSE)
