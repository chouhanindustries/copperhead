# add-mcp-server: Proposal

## Why

Coding agents (Claude Code, Codex, and every MCP host) are already being pointed at KiCad repos through raw tool servers that expose ungated file edits: the host agent can rewrite a `.kicad_sch` with no spec gate, no verification, no rollback. Copperhead's invariants only protect users whose entry point is the copperhead CLI. A thin MCP wrapper makes the gated pipeline the thing the host agent calls, so the invariants survive the integration and copperhead meets the agent audience where it already works (roadmap Phase 3, items 1 and 2).

## What Changes

- **New command: `copperhead mcp`**, a stdio MCP server exposing the pipeline as opaque tools:
  - `copperhead_check` — runs `check` (with optional `fab`/`strict` inputs) and returns the JSON report.
  - `copperhead_do` — takes a change-request string, runs the full gated `do` loop (spec gate, edit, verify, repair, rollback), and returns the run summary (result, commit, files touched, verification state, transcript path). The host agent never sees or drives intermediate steps.
  - `copperhead_sync` — verify phase always; resolve phase only when the `resolve` input is true.
  - `copperhead_init` — scaffolds docs-memory in a KiCad repo.
- **Structural opacity**: the server exposes no file-edit, no raw KiCad, and no partial-loop tools. There is nothing to reach around; a host agent integrating copperhead cannot bypass spec-gating or verification-gating by construction.
- **Safety inheritance**: dirty-tree refusal, path sandbox, secret redaction, and budgets apply unchanged; the MCP layer adds no privileges. `copperhead_do` runs non-interactive (AUTO marker), and the server refuses `do`/`sync --resolve` when no API key env var is present, with a message distinguishing agent-loop tools from the LLM-free ones.
- **Companion skill**: a published Claude Code / Codex skill instructing agents to use these tools instead of editing `.kicad_*` files directly, shipped in the repo under `integrations/`.

## Capabilities

### New Capabilities

- `mcp-server`: the `copperhead mcp` command, the four tool contracts (inputs, outputs, error shapes), the opacity guarantee, and non-interactive/key-handling semantics.

### Modified Capabilities

- `cli-surface`: the CLI gains the `mcp` command.

## Impact

- **Code**: new `src/mcp/server.ts` (stdio transport, tool schemas, dispatch into the existing command implementations); `src/commands/` refactored so `check`/`do`/`sync`/`init` expose callable entry points returning structured results (the CLI already builds these for `--json`).
- **Dependencies**: `@modelcontextprotocol/sdk` (runtime); no transport beyond stdio in this change.
- **Distribution**: MCP registry listings and the companion skill under `integrations/` (registry submission is a task, not a spec).
- **Unchanged contracts**: CLI behavior identical; no new network surface (stdio only; LLM calls happen exactly where the CLI already makes them).
