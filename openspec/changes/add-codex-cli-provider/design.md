# Design: Local Codex CLI provider

## Context

The agent loop already normalizes providers behind `Provider.chat(messages, tools) -> Turn`. The Codex SDK controls a local Codex CLI thread and reuses its saved authentication, but Codex is itself an agent with filesystem and command capabilities. Letting it edit the target repository directly would bypass Copperhead's two core invariants.

## Decisions

### D1 — Use the official Codex SDK against the user's installed CLI

`makeProvider` loads the optional `@openai/codex-sdk` peer only when a `codex` model is selected, then constructs `CodexProvider` with `codexPathOverride` set to `COPPERHEAD_CODEX_PATH` or `codex` on `PATH`. Direct API users therefore do not install the Codex SDK or its platform package. Codex users install the adapter explicitly, while execution still chooses their installed CLI and its `codex login` state instead of requiring `OPENAI_API_KEY`.

### D2 — Codex is reasoning-only

The Codex thread runs with `sandboxMode: read-only`, `approvalPolicy: never`, network access disabled for model-initiated commands, and web search disabled. Each provider instance receives a unique temporary working directory rather than the target hardware repository. The read-only sandbox enforces mutation isolation, but it does not confine native reads to that directory; avoiding built-in shell/filesystem/MCP reads is prompt-enforced. Only Copperhead dispatches file and KiCad tools.

### D3 — Structural gating is mirrored in structured output

Every SDK turn receives a JSON Schema. `toolCalls[].name` is an enum built from that turn's `availableTools(ctx)`. Before proposal validation the enum cannot represent `edit_file` or `write_file`; after validation the next turn's schema can. Returned names and JSON arguments are validated again before entering the normalized `Turn` type. If that validation fails, the provider keeps the message cursor unchanged and gives the same thread one corrective retry containing the validation error and still-unprocessed input.

### D4 — One Codex thread per Copperhead run

The provider retains a Codex `Thread` across loop turns. The first prompt carries the Copperhead system prompt and user request. Later turns send only new user nudges and Copperhead tool results, avoiding replay of the full conversation while preserving Codex reasoning state. SDK token usage maps into the existing transcript totals.

### D5 — Explicit provider namespace

`codex` selects the user's Codex default model. `codex:<model-id>` selects an explicit Codex model. Other non-Claude model strings continue to route to the direct OpenAI API, preserving backward compatibility.

## Failure behavior

Missing optional SDK, CLI, or authentication produces an actionable provider error. CLI/authentication failures point to `codex login status`. The normal loop failure path restores the git snapshot and writes the transcript. Codex does not silently fall back to a paid API provider.

## Security properties

- Copperhead never receives the saved ChatGPT credential; the Codex CLI owns authentication.
- Codex cannot mutate the target repo through its native tools.
- The current Copperhead tool catalog is the structured-output allowlist.
- `check` imports no provider and performs no model or network call.
