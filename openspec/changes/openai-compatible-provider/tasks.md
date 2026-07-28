# Tasks — openai-compatible-provider

## 1. OpenSpec artifacts

- [x] 1.1 `.openspec.yaml`, `proposal.md`, `design.md`, `tasks.md`
- [x] 1.2 `specs/openai-compatible-provider/spec.md`, `specs/cli-surface/spec.md` delta specs

## 2. Config layer

- [x] 2.1 Add `openaiCompatBaseUrl?: string` and `openaiCompatApiKeyEnv?: string` to `CopperheadConfig`
- [x] 2.2 Pass through in `loadConfig()` with `.trim()` blank-value normalization
- [x] 2.3 `COPPERHEAD_BASE_URL` / `COPPERHEAD_API_KEY_ENV` env-var overrides
- [x] 2.4 `resolveCompatSettings(config, env)` — single source of truth for the precedence chain (D5)
- [x] 2.5 `isLocalEndpoint(baseURL)` — loopback/`.local` classification for the no-credential bypass (D6)
- [x] 2.6 `resolveModel` refuses with an `ambiguous:` error when 2+ credentials are present and nothing selects a model (D9)
- [x] 2.7 `classifyPromptPrivacy(model, compat)` — shared, compat-gated training-risk classification (D10)

## 3. Provider

- [x] 3.1 `OpenAIProviderOptions` (`{ baseURL?, apiKeyEnv? }`) replaces positional `(apiKey, baseURL)` args
- [x] 3.2 Injectable `env` parameter (tests set fake vars without touching `process.env`)
- [x] 3.3 Pass `baseURL` to the `OpenAI` SDK client constructor
- [x] 3.4 Distinct provider `name` (`'openai-compat'` vs `'openai'`) so `otherProvider()`'s failover never redirects a compat run to a paid key (D8)
- [x] 3.5 Skip the missing-key throw for a local/loopback endpoint (D6); send the SDK client a placeholder value

## 4. makeProvider routing

- [x] 4.1 Explicit `compat`/`compat:<model-id>` prefix — the *only* route that reads compat settings (D4)
- [x] 4.2 Reject bare `compat` (no model id) and `compat:<id>` with no endpoint configured, both with actionable errors
- [x] 4.3 Thread `resolveCompatSettings(config)` through `makeProvider()`'s call sites (agent loop, create-pipeline `diagnose()`)
- [x] 4.4 Log one-line privacy notice at run-start via `classifyPromptPrivacy`, gated to the `'risk'` case only

## 5. Doctor command

- [x] 5.1 `src/commands/doctor.ts` — KiCad/git/node checks, compat-aware provider/key check, `warn`-level privacy check; stays network-free by design (D7)
- [x] 5.2 Wire `copperhead doctor` in `src/cli.ts`
- [x] 5.3 Strip a credential embedded in the endpoint URL itself (Gemini's `?key=...`) from the displayed report (D7)
- [x] 5.4 `warn` status distinct from `ok`/`fail`/`info` (color, tag) for the privacy check

## 6. Docs

- [x] 6.1 `docs/src/content/docs/getting-started/free-stack.md`
- [x] 6.2 `README.md`, `docs/src/content/docs/reference/cli.md`, `docs/src/content/docs/reference/configuration.md` — `compat:<id>` route, ambiguous-credential error, privacy check

## 7. Tests

- [x] 7.1 `test/openai-compat.test.ts` — offline coverage for config/provider/routing/doctor, including the explicit `compat:` prefix's rejection paths
- [x] 7.2 Real loopback-HTTP-server tests proving `baseURL`/key-env/model id reach the actual request (not mock-only)
- [x] 7.3 A full `runAgentLoop` test with a `.copperhead/config.json`-configured endpoint and no injected provider, crossing the `resolveCompatSettings` → `makeProvider` → `OpenAIProvider` seam end-to-end
- [x] 7.4 Ambiguous-credential, local-endpoint, and URL-credential-redaction regression tests

## 8. Verification

- [x] 8.1 `npm run typecheck`
- [x] 8.2 `npm run build`
- [x] 8.3 `npm test`
