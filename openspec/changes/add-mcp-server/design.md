# add-mcp-server: Design

## Context

The MCP ecosystem's existing KiCad servers expose fine-grained operations (edit this footprint, run DRC) and leave the loop to the host agent, which is precisely the architecture copperhead exists to reject: the host loop has no spec gate, no verification obligation, no rollback. The wrapper's entire value is that it exposes outcomes, not operations. The CLI commands already produce structured results for `--json`, so the server is a transport, not a reimplementation.

## Goals / Non-Goals

**Goals:**

- Any MCP host can run the full gated pipeline with four tools and zero copperhead knowledge.
- Impossible-by-construction bypass: no tool the server exposes can mutate repo files outside the gated loop.
- Results are self-describing enough for a host agent to relay honestly (verification state, rollback occurrence, transcript path).

**Non-Goals:**

- No HTTP/SSE transport in this change (stdio covers Claude Code, Codex, and desktop hosts; remote transport belongs with a hosted story).
- No streaming of intermediate agent turns over MCP (the run summary is the contract; the transcript file has the detail).
- No `create` exposure yet: multi-stage runs can exceed host tool timeouts; it needs a job-style pattern, deferred.
- No MCP resources/prompts surface beyond the four tools.

## Decisions

- **D1: Opaque outcome tools, not operation tools.** Tool granularity is the security boundary: exposing only whole-pipeline invocations means spec-gating and verification-gating cannot be skipped by any sequence of tool calls. Alternative: expose the internal tool families over MCP — rejected; that reproduces the competitor architecture and forfeits both invariants.
- **D2: `mcp` as a CLI subcommand on stdio.** Hosts configure `copperhead mcp` as a stdio server; no daemon, no port, no separate binary to version. The official TypeScript SDK handles the protocol.
- **D3: Server calls the command layer, not the CLI.** `check`/`do`/`sync`/`init` get exported entry points returning the same structured objects `--json` prints; the server serializes those. Shelling out to our own CLI would double process management and lose typed errors. This refactor is the main code motion in the change.
- **D4: Non-interactive by default, and honest about keys.** `copperhead_do` runs with the AUTO marker (no y/n gate to answer over MCP). At startup the server detects available API keys; `copperhead_check` and `copperhead_init` always work, and `copperhead_do`/`copperhead_sync` (resolve) return a typed error naming the missing env var when no key exists. Alternative: accept keys as tool inputs — rejected; keys stay in env vars per the safety rails, never in tool-call payloads that hosts may log.
- **D5: Long-run handling via progress notifications.** A `do` run can take minutes; the server emits MCP progress notifications while the loop runs so hosts do not time out, and the tool result is returned when the run commits or rolls back. No detach/poll pattern in this change (that is what keeps `create` out of scope).
- **D6: Errors are results, not protocol errors.** A rollback after `maxRepairCycles` is a successful tool call whose result says `status: "rolled_back"` with the transcript path; protocol-level errors are reserved for misuse (bad input, missing repo, missing key). Host agents relay results far better than they relay exceptions.

## Risks / Trade-offs

- [Host agent edits `.kicad_sch` with its own file tools anyway] → out of copperhead's control by definition; the companion skill instructs against it, and the pre-commit hook plus `check` in CI still catch the damage. The wrapper narrows the sanctioned path; it cannot confiscate the host's own tools.
- [Tool timeout on slow `do` runs despite progress notifications] → summary includes the transcript path; a timed-out host can re-check repo state with `copperhead_check`, and the run itself completes or rolls back regardless (the subprocess is not killed by host timeout).
- [SDK/protocol churn] → thin surface (four tools, stdio); protocol version pinned in tests with golden request/response fixtures.
- [Concurrent tool calls racing one repo] → the server serializes mutating tools per repo with the existing dirty-tree guard as backstop; concurrent `check` calls are safe and unrestricted.

## Migration Plan

Additive command. Registry listing and skill publication follow implementation; nothing to migrate. If the SDK breaks, the CLI is unaffected.

## Open Questions

- Whether `copperhead_do` should accept a `dry_run` input mapping to `--dry-run` (leaning yes: cheap, lets host agents propose before committing).
- Skill packaging format for Codex (Claude Code's skill format is settled; Codex equivalent may lag; ship what exists, note the gap in integrations/README).
