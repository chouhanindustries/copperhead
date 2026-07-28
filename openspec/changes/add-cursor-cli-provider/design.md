# Design — add-cursor-cli-provider

## Context

Spike (2026-07-24): `agent` and `cursor-agent` on PATH; `agent status` succeeds with saved login; `--print --output-format json --mode plan --trust --workspace <tmpdir>` returns a single JSON result with `result` and `session_id` (official JSON schema does not expose token usage — run stats / create stage tables therefore report 0 tokens for cursor); `--resume <session_id>` continues multi-turn without re-sending history. The prompt is fed on **stdin** (not argv) so large tool results cannot hit Linux `MAX_ARG_STRLEN` / E2BIG.

Cursor Agent is a full coding agent (like Claude Code), not a sandboxed SDK (like Codex). Enforcement follows **claude-code** (reasoning-only + tripwire), not Codex native `outputSchema`.

## Decisions

### D1 — Subprocess reasoning-only backend

Each `chat()` runs one `agent` invocation with:

- `--mode plan` (read-only)
- `--sandbox enabled`
- `--print --output-format json --trust`
- `--workspace` = isolated temp dir (not the hardware repo)
- Optional `--model` from `cursor:<id>` override
- `--resume` only when opt-in session resume is on (mutually exclusive with the response cache, same as claude-code)
- Prompt on stdin (system + tool protocol + conversation), not as a trailing argv element

System + tool protocol prepended to the user prompt (CLI has no separate system flag).

**Tripwire:** scan stdout lines as JSON; throw if any object has `type` matching native tool execution (`tool_call`, `tool_use`, `shell`, `write`, `edit`, `apply_patch`) or if `subtype` indicates a executed mutation. Also throw on `is_error: true` when the message indicates tool execution escaped plan mode.

### D2 — Authentication external; strip billed keys

No `CURSOR_API_KEY` in Phase 1. Subprocess env is an explicit allowlist (`PATH`, `HOME`, Windows `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH`, locale/temp/XDG vars, etc.) — not a spread of `process.env` — so unrelated credentials never reach the CLI and billed keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`) are never passed.

### D3 — No SDK dependency

Subprocess only; injectable `runFn` for tests.

### D4 — `name = 'cursor'` ⇒ no keyed failover

`otherProvider()` returns null for cursor runs.

### D5 — Temp workspace + session resume

One `copperhead-cursor-*` dir per provider instance; `sessionId` from result JSON; `renderDelta` for resumed turns. Resume is opt-in via the same `sessionResume` flag / `COPPERHEAD_CC_SESSION_RESUME` gate as claude-code (off whenever `llmCache` is on). `close()` aborts in-flight subprocess and removes workspace.

### D6 — Injectable `runFn`

Constructor `(model?: string, runFn?: CursorRunLike, sessionResume?: boolean)` for offline tests.

## Spike reference

Default binary: `COPPERHEAD_CURSOR_PATH` or `agent`. Result shape:

```json
{"type":"result","result":"...","session_id":"..."}
```
