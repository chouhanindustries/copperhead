# Add a saved-login `cursor` provider

## Why

Users with Cursor Agent CLI authentication (`agent login`) cannot run copperhead's agent loop without a separate OpenAI or Anthropic API key. This change adds `--model cursor` / `cursor:<model-id>`, mirroring the saved-login story of `claude-code` and `codex`, while copperhead remains the sole mutator (spec-gated in, verification-gated out).

## What Changes

- New provider `src/agent/providers/cursor.ts` (`name: 'cursor'`) driving the local `agent` CLI in plan mode as a reasoning-only backend.
- Tool calls use the same JSON prompt protocol as `claude-code` (shared `tool-protocol.ts`).
- Session resume via `--resume <session_id>` across copperhead turns to avoid re-billing full history.
- Routing in `makeProvider()` for `cursor` and `cursor:<model-id>`; no silent fallback to keyed providers.
- `COPPERHEAD_CURSOR_PATH` override (default `agent` on PATH).
- Phase 1: saved login only; `CURSOR_API_KEY` deferred.

## Impact

- No new npm dependencies (subprocess to installed CLI).
- `check` unchanged (LLM-free).
- Docs, tests, and SPEC.md provider list updated.
