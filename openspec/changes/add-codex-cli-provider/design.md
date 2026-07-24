# Design: Local Codex CLI provider

## Context

The agent loop already normalizes providers behind `Provider.chat(messages, tools) -> Turn`. The Codex SDK controls a local Codex CLI thread and reuses its saved authentication, but Codex is itself an agent with filesystem and command capabilities. Letting it edit the target repository directly would bypass Copperhead's two core invariants.

## Decisions

### D1 — Use the official Codex SDK against the user's installed CLI

`makeProvider` loads the optional `@openai/codex-sdk` peer only when a `codex` model is selected, then constructs `CodexProvider` with `codexPathOverride` set to `COPPERHEAD_CODEX_PATH` or `codex` on `PATH`. Direct API users therefore do not install the Codex SDK or its platform package. Codex users install the adapter explicitly, while execution still chooses their installed CLI and its `codex login` state instead of requiring `OPENAI_API_KEY`. When `codex` is not on `PATH`, `COPPERHEAD_CODEX_PATH` may point to the SDK dependency's bundled `@openai/codex/bin/codex.js` launcher.

### D2 — Codex is reasoning-only

The Codex thread runs with `sandboxMode: read-only`, `approvalPolicy: never`, network access disabled for model-initiated commands, and web search disabled. Each provider instance receives a unique temporary working directory rather than the target hardware repository, and the loop removes that directory when the provider closes. The read-only sandbox enforces mutation isolation, but it does not confine native reads to that directory; avoiding built-in shell/filesystem/MCP reads is prompt-enforced. Only Copperhead dispatches file and KiCad tools.

### D3 — Structural gating is mirrored in structured output

Every SDK turn receives a JSON Schema. `toolCalls[].name` is an enum built from that turn's `availableTools(ctx)`. Before proposal validation the enum cannot represent `edit_file` or `write_file`; after validation the next turn's schema can. Returned names and JSON arguments are validated against the selected tool's parameter schema before entering the normalized `Turn` type. If validation fails, the provider keeps the message cursor unchanged and gives the same thread one corrective retry containing the validation error without duplicating the original prompt. Copperhead messages and tool results use JSON framing so their content cannot terminate pseudo-XML delimiters.

### D4 — One Codex thread per Copperhead run

The provider retains a Codex `Thread` across loop turns. The first prompt carries the Copperhead system prompt and user request. Later turns send only new user nudges and Copperhead tool results, avoiding replay of the full conversation while preserving Codex reasoning state. SDK token usage maps into the existing transcript totals.

### D5 — Explicit provider namespace

`codex` selects the user's Codex default model. `codex:<model-id>` selects an explicit Codex model. Other non-Claude model strings continue to route to the direct OpenAI API, preserving backward compatibility.

## Failure behavior

Missing optional SDK, CLI, or authentication produces an actionable provider error. Only missing-CLI and authentication-shaped failures point to `codex login status`; rate limits and unrelated execution failures retain their original context. The normal loop failure path restores the git snapshot and writes the transcript. Codex does not silently fall back to a paid API provider.

## Security properties

- Copperhead never receives the saved ChatGPT credential; the Codex CLI owns authentication.
- Codex cannot mutate the target repo through its native tools.
- Native reads are not confined: despite the temporary working directory, Codex can technically read `.env` or any other host-readable file. The no-native-read rule is prompt-enforced.
- Codex writes its own session logs under `~/.codex/sessions/`. Those logs may contain the full prompt and design content, live outside the repository, and are not covered by Copperhead's transcript redaction or AC-4.1 tree scan.
- The current Copperhead tool catalog is the structured-output allowlist.
- Type-only SDK imports bind the adapter's load-bearing thread options to the pinned SDK declarations without adding a runtime import.
- `check` imports no provider and performs no model or network call.
