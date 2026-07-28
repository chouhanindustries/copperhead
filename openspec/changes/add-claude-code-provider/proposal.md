# Add a saved-login `claude-code` provider

## Why

copperhead ships two LLM providers today — OpenAI (`gpt-5`) and Anthropic (`claude`) — and both require an API key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) billed per token (`src/agent/providers/openai.ts`, `anthropic.ts`, routed by prefix in `makeProvider`, `src/agent/loop.ts:50`). Users who already pay for a Claude subscription and are logged into the Claude Code CLI have no way to point copperhead at that saved login — they must hold a separate, separately-billed API key.

This change adds a third provider, selected by `--model claude-code` (and `claude-code:<model-id>`), that drives the locally-installed Claude Code through the official **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) and reuses its authentication. A subscription user runs `claude setup-token` once, sets `CLAUDE_CODE_OAUTH_TOKEN`, and can then run copperhead with **no `ANTHROPIC_API_KEY`**. copperhead never reads, copies, or logs the credential — the CLI owns authentication.

## What Changes

- **New provider** `src/agent/providers/claude-code.ts` (`name: 'claude-code'`) implementing the existing `Provider.chat(messages, tools) -> Turn` seam on top of the Agent SDK's `query()` surface. It is a **reasoning-only** backend: each `chat()` issues one `query()` with no SDK tools registered and built-ins disabled, run in an isolated working directory, so the SDK executes nothing. copperhead's `loop.ts` stays the driver and every mutation still flows through copperhead's capability-filtered tools, obligations ledger, ERC/DRC verification, git snapshot, and commit gate — identically to the other providers.
- **Structural tool gating preserved**: the tools `availableTools(ctx)` returns each turn are advertised to the model as a text protocol in the system prompt and the model's reply is parsed back into `Turn.toolCalls`. A tool absent from the advertised set cannot be called, and `dispatchTool` re-checks — the spec-gated-in invariant stays structural, not schema-mirrored.
- **Auth stays external**: the provider performs no credential handling and requires no API key in its constructor. The SDK resolves `CLAUDE_CODE_OAUTH_TOKEN` / the logged-in CLI itself; a missing or unauthenticated install fails through copperhead's normal rollback path with an actionable error.
- **No silent fallback to a paid API**: the distinct provider `name` means the rate-limit failover in `otherProvider` (`src/agent/loop.ts:57`) never swaps a `claude-code` run onto a keyed provider.
- **Optional dependency**: `@anthropic-ai/claude-agent-sdk` is declared under `optionalDependencies` and lazily `import()`ed inside `chat()`, so it loads only when `claude-code` is selected and a missing install (e.g. `--omit=optional`) surfaces an actionable error. Declaring it required satisfying the SDK's `@anthropic-ai/sdk >=0.93.0` peer, done in the prerequisite PR #56 that bumped copperhead's core SDK and added a `zod ^4` override (see design D3).
- **Docs + config**: `--model` routing docs (`src/config.ts` comment, `.env.example`, the configuration reference, `README.md`) document `claude-code` / `claude-code:<id>`, the no-API-key setup, and the optional install.

## Capabilities

### New Capabilities

- `claude-code-provider`: a saved-login LLM backend selected by `--model claude-code` / `claude-code:<id>` that drives the local Claude Code via the Claude Agent SDK as a reasoning-only provider, needs no `ANTHROPIC_API_KEY`, keeps authentication external, maps onto the single-turn `Provider` seam so all of copperhead's safety gates apply, and never falls back to a paid API provider.

### Modified Capabilities

- `cli-surface`: `--model` / `COPPERHEAD_MODEL` / config `model` gain the `claude-code` and `claude-code:<id>` values, routed ahead of the `claude*` prefix.

## Impact

- `src/agent/providers/claude-code.ts` — new provider (reasoning-only single-turn mapping, JSON tool protocol, injectable `queryFn` seam, isolated `cwd`, actionable missing-dep/auth errors, error-status preservation).
- `src/agent/loop.ts` — `makeProvider` gains a `claude-code` / `claude-code:` branch **before** the `startsWith('claude')` branch; confirm `otherProvider` returns `null` for it (no fallback).
- `src/config.ts` — `resolveModel` doc comment documents the new values and that they need no API key.
- `package.json` — `@anthropic-ai/claude-agent-sdk` under `optionalDependencies`; the core `@anthropic-ai/sdk` bump and `zod` override that make its peers resolvable land in the prerequisite PR #56 (see design D3).
- `.env.example`, `docs/src/content/docs/reference/configuration.md`, `README.md` — document `claude-code`, `CLAUDE_CODE_OAUTH_TOKEN` (via `claude setup-token`), and the optional install.
- `test/claude-code-provider.test.ts` — new offline suite (routing, tool-protocol mapping, malformed-output tolerance, error-status preservation, missing-dependency error, no-fallback, usage extraction) using an injected fake `queryFn`.
- `test/agent-integration.test.ts` — opt-in live provider-parity entry for `claude-code` keyed on `CLAUDE_CODE_OAUTH_TOKEN` (AC-3.10).
- `openspec/specs/SPEC.md` — extend AC-3.10 to include `--model claude-code`; add a saved-login acceptance criterion; note the third provider in §4.4.
- No changes to `check` (stays LLM-free/network-free) and no breaking changes to existing providers or CLI flags.
