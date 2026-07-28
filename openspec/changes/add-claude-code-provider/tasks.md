# Tasks — add-claude-code-provider

## 1. Packaging

- [x] 1.1 Declare `@anthropic-ai/claude-agent-sdk` under `optionalDependencies` in `package.json` (its `@anthropic-ai/sdk >=0.93.0` peer is satisfied by the prerequisite PR #56 core-SDK bump plus a `zod ^4` override; design D3). The provider lazy-imports it and errors actionably when absent (e.g. `--omit=optional`)

## 2. Provider implementation

- [x] 2.1 Create `src/agent/providers/claude-code.ts` with `class ClaudeCodeProvider implements Provider` (`name = 'claude-code'`) and constructor `(model?: string, queryFn?: QueryLike)` — no API-key check; `queryFn` defaults to a lazy import of the SDK's `query`, injectable for tests (D6)
- [x] 2.2 Implement `chat(messages, tools, opts)`: build `systemPrompt` = joined system messages + a tool-protocol section rendering each `ToolSchema` (name, description, JSON-schema params) and the reply contract; build `prompt` = the non-system message history flattened to text (user turns; prior assistant tool-calls re-rendered as their JSON; `tool` results as `Result of <name>: …`)
- [x] 2.3 Call `queryFn({ prompt, options: { systemPrompt, ...(model?{model}:{}), tools: [], disallowedTools: [built-ins], cwd, env: {...process.env, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined}, maxTurns: 1 } })`; reuse one `mkdtemp` cwd per instance (no per-turn leak, D5); iterate messages, accumulate assistant text, read token usage from the `result` message (D1)
- [x] 2.4 Parse the assistant text: extract the tool-call JSON object into `Turn.toolCalls` (deterministic ids, e.g. `cc-<n>`); remaining prose → `Turn.text`; malformed JSON tolerated as text (no throw), mirroring `safeParse` in `openai.ts`
- [x] 2.5 Reasoning-only tripwire (D1): if any streamed assistant message carries a `tool_use` block, throw immediately (the SDK must execute nothing)
- [x] 2.6 Error handling: re-throw the original SDK error so `status`/`statusCode` survive for `withRetry`/`isRateLimit` (status-first: auth only on 401/403, D4); wrap the missing-dependency case (only `ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND`, re-throwing other import errors) and unauthenticated case into actionable, non-retryable messages (D2, D3)

## 3. Routing

- [x] 3.1 In `makeProvider` (`src/agent/loop.ts:50`), add a `model === 'claude-code' || model.startsWith('claude-code:')` branch that returns `new ClaudeCodeProvider(...)` **before** the `startsWith('claude')` branch; parse the `claude-code:<id>` model id
- [x] 3.2 Confirm `otherProvider` (`src/agent/loop.ts:57`) returns `null` for a `claude-code` current provider (distinct name ⇒ no fallback); add a code comment noting the no-fallback guarantee

## 4. Config & docs

- [x] 4.1 Update the `resolveModel` doc comment in `src/config.ts` to document `claude-code` / `claude-code:<id>` and that they need no API key (Claude Code login / `CLAUDE_CODE_OAUTH_TOKEN`)
- [x] 4.2 Update `.env.example`: add `CLAUDE_CODE_OAUTH_TOKEN` and document the `claude-code` routing values + optional install
- [x] 4.3 Update `docs/src/content/docs/reference/configuration.md`: add `CLAUDE_CODE_OAUTH_TOKEN` to the env-var table and `claude-code`/`claude-code:<id>` to the model-selection docs
- [x] 4.4 Update `README.md`: mention the saved-login `--model claude-code` path (no `ANTHROPIC_API_KEY`, optional dependency, `claude setup-token`)

## 5. Tests

- [x] 5.1 Create `test/claude-code-provider.test.ts` (offline, injected fake `queryFn`): routing (`claude-code` + `claude-code:<id>` → `ClaudeCodeProvider`; `claude-sonnet-5` still → `AnthropicProvider`); tool-protocol mapping (system prompt advertises `availableTools` schemas; scripted JSON reply → `Turn.toolCalls`); bare and multiple fenced JSON blocks; plain-text reply → `Turn.text`, no calls; malformed JSON tolerated (no throw); `renderConversation` flattening of assistant tool-calls + `[result of <name>]` mapping; tool_use tripwire throws; error-status preservation (fake throws `{status:429}` → re-thrown so `isRateLimit` sees it, including a 429 whose message mentions "oauth token"); missing-dependency → actionable error; no-fallback (`otherProvider(new ClaudeCodeProvider())` is `null`); env strips billed keys but inherits the rest; cwd reused across turns; usage extraction from the `result` message
- [x] 5.2 Extend the `providers` array in `test/agent-integration.test.ts` with a `claude-code` entry gated on **both** `CLAUDE_CODE_OAUTH_TOKEN` and the SDK being resolvable, so the AC-3.1/3.4/3.6 parity cases run against `claude-code` only when it can actually run (AC-3.10)

## 6. SPEC & verification

- [x] 6.1 Update `openspec/specs/SPEC.md`: extend AC-3.10 to include `--model claude-code`; add a saved-login acceptance criterion; note the third provider in §4.4 and the new env var in §5/.env.example reference
- [x] 6.2 Run `npm run build`, `npm run typecheck`, and `npm test` (full offline suite green, including the new provider tests); if the `openspec` CLI is available, run `openspec validate add-claude-code-provider` and fix fallout

## 7. Rebase onto v0.5.0 + review follow-ups

- [x] 7.1 Rebase onto `main` (v0.5.0, which merged `CodexProvider` and made `makeProvider` async): integrate the `claude-code` branch into the async `makeProvider` (matched before `claude*`, alongside `codex`), and list `claude-code` beside `codex` in SPEC §4.4, the routing tables, `.env.example`, and the config reference
- [x] 7.2 Implement `Provider.close()` to `rm` the scratch cwd (loop.ts calls it in a `finally`); reuse one cwd per instance (D5) — resolves the temp-dir-leak review finding
- [x] 7.3 Layer the "SDK executes nothing" defense to mirror `CodexProvider`'s sandbox: keep `tools: []`, add a `'*'` wildcard to `disallowedTools`, add a deny-all `canUseTool` handler (`interrupt: true`), and keep the tool_use tripwire
- [x] 7.4 Replace `options: Record<string, unknown>` with a local typed `QueryOptions` interface so option names are compile-checked (cannot `import type` from the undeclared SDK without coupling `tsc` to its install)
- [x] 7.5 Validate parsed tool-call names against the turn's `availableTools` catalog: an unknown/locked name is left as prose, not dispatched
- [x] 7.6 Docs nit: describe the reused login (not a "locally-installed Claude Code" binary) in README, the config reference, and `.env.example`
- [x] 7.7 New offline tests: `close()` removes the cwd, deny-all `canUseTool` present, empty `tools` + wildcard `disallowedTools`, unknown tool name left as prose; update routing tests for the async `makeProvider`
