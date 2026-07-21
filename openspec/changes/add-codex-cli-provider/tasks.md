# Tasks: Add local Codex CLI provider

## 1. Provider

- [x] 1.1 Add the official Codex SDK dependency.
- [x] 1.2 Implement a provider using the installed Codex CLI and saved ChatGPT login.
- [x] 1.3 Constrain Codex to a read-only, no-approval, no-web reasoning thread.
- [x] 1.4 Generate structured output from the currently exposed Copperhead tool catalog and validate returned calls.
- [x] 1.5 Preserve one Codex thread across Copperhead loop turns and map token usage.

## 2. Selection and configuration

- [x] 2.1 Route `codex` and `codex:<model-id>` in `makeProvider`.
- [x] 2.2 Accept `--model codex` without an OpenAI or Anthropic API key.
- [x] 2.3 Add `COPPERHEAD_CODEX_PATH` as an optional CLI path override.

## 3. Tests and documentation

- [x] 3.1 Add offline tests for sandbox settings, structured call mapping, continuation, unavailable tools, and malformed arguments.
- [x] 3.2 Add Codex to the opt-in live provider-parity suite.
- [x] 3.3 Update the technical specification, README, generated repo docs, and documentation site.
- [x] 3.4 Run typecheck, build, offline tests, docs build, and live saved-login smoke verification.
- [x] 3.5 Run the fixture agent-loop acceptance test through `--model codex` with KiCad installed.
