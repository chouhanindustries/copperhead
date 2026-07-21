# Design: Local Codex CLI provider

## Context

The agent loop already normalizes providers behind `Provider.chat(messages, tools) -> Turn`. The Codex SDK controls a local Codex CLI thread and reuses its saved authentication, but Codex is itself an agent with filesystem and command capabilities. Letting it edit the target repository directly would bypass Copperhead's two core invariants.

## Decisions

### D1 — Use the official Codex SDK against the user's installed CLI

`CodexProvider` uses `@openai/codex-sdk` with `codexPathOverride` set to `COPPERHEAD_CODEX_PATH` or `codex` on `PATH`. This intentionally chooses the user's installed CLI and its `codex login` state instead of requiring `OPENAI_API_KEY` or using a separately bundled binary.

### D2 — Codex is reasoning-only

The Codex thread runs with `sandboxMode: read-only`, `approvalPolicy: never`, network access disabled for model-initiated commands, and web search disabled. Its working directory is an isolated temporary directory rather than the target hardware repository. The prompt explicitly forbids built-in shell/filesystem/MCP actions. Only Copperhead dispatches file and KiCad tools.

### D3 — Structural gating is mirrored in structured output

Every SDK turn receives a JSON Schema. `toolCalls[].name` is an enum built from that turn's `availableTools(ctx)`. Before proposal validation the enum cannot represent `edit_file` or `write_file`; after validation the next turn's schema can. Returned names and JSON arguments are validated again before entering the normalized `Turn` type.

### D4 — One Codex thread per Copperhead run

The provider retains a Codex `Thread` across loop turns. The first prompt carries the Copperhead system prompt and user request. Later turns send only new user nudges and Copperhead tool results, avoiding replay of the full conversation while preserving Codex reasoning state. SDK token usage maps into the existing transcript totals.

### D5 — Explicit provider namespace

`codex` selects the user's Codex default model. `codex:<model-id>` selects an explicit Codex model. Other non-Claude model strings continue to route to the direct OpenAI API, preserving backward compatibility.

## Failure behavior

Missing CLI or authentication produces a provider error that points to `codex login status`. The normal loop failure path restores the git snapshot and writes the transcript. Codex does not silently fall back to a paid API provider.

## Security properties

- Copperhead never receives the saved ChatGPT credential; the Codex CLI owns authentication.
- Codex cannot mutate the target repo through its native tools.
- The current Copperhead tool catalog is the structured-output allowlist.
- `check` imports no provider and performs no model or network call.
