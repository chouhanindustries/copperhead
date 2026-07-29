# Tasks — OpenAI-compatible provider

## 1. Config surface

- [x] 1.1 Add `baseURL` and `apiKeyEnv` to `CopperheadConfig` and `loadConfig` (`src/config.ts`). Verified: `npx vitest run test/openai-compat.test.ts` (config-resolution cases) + `npm run typecheck`.
- [x] 1.2 Add a `resolveCompatSettings(config, env)` helper: config values, overridden by `COPPERHEAD_BASE_URL` / `COPPERHEAD_API_KEY_ENV`, with `OPENAI_API_KEY` as the default variable name. Verified: same test file, "environment overrides config" + "ignores blank values" cases.

## 2. Provider

- [x] 2.1 `OpenAIProvider` accepts `baseURL` and an `apiKeyEnv` name; pass `baseURL` to the client (`src/agent/providers/openai.ts`). Verified live: a real loopback HTTP server test asserts the actual request lands on the configured `baseURL` with the right model id and `Authorization` header (`test/openai-compat.test.ts`); also confirmed against real Groq/OpenRouter/Gemini endpoints via manual `do` runs.
- [x] 2.2 Require a credential only for a remote endpoint; allow a keyless loopback endpoint (D4). Verified live: Ollama (`http://localhost:11434/v1`) ran with no key against `phi3:latest` and `qwen2.5:0.5b`.
- [x] 2.3 Error message names the expected variable when a remote endpoint has no key. Verified unit + live (Groq/OpenRouter runs with a missing key surfaced the exact variable name).

## 3. Routing

- [x] 3.1 Route `compat:<model-id>` in `makeProvider()`, rejecting both `compat:` (empty override) and bare `compat` (no override — a compatible endpoint has no default model, unlike `codex`/`claude-code`/`cursor`) (`src/agent/loop.ts`). Verified: regression test added after finding bare `compat` previously fell through to `OpenAIProvider`'s own `'gpt-5'` default instead of throwing.
- [x] 3.2 Add the optional settings parameter and thread it from the two production call sites (`loop.ts`, `create.ts`). Verified: `npm run typecheck` (source-compatible with all existing single-argument callers) + full suite green.
- [x] 3.3 Confirm a plain `gpt-5` run ignores `baseURL` (D2). Verified unit (`test/openai-compat.test.ts`) + live (`doctor --model gpt-5` with `COPPERHEAD_BASE_URL` exported still targeted real OpenAI, not the configured compat endpoint).

## 4. doctor

- [x] 4.1 `checkCredential` handles the compat route: resolve the configured variable, report the endpoint. Verified live across Groq, Ollama, OpenRouter, and Gemini configurations.
- [x] 4.2 Hostname-keyed training-risk map, emitted at `warn` (D5). Verified live: `doctor` with Gemini configured shows `[warn] privacy ... may train on submitted prompts` and still exits `ready` (0).

## 5. Tests

- [x] 5.1 Routing: `compat:<id>`, `compat:` empty override, and bare `compat` all rejected. `npm test`: 498 passed, 0 failed.
- [x] 5.2 `baseURL` reaches the client; model id passed through. Verified via the real-HTTP-server test in 2.1.
- [x] 5.3 Credential read from the configured variable name.
- [x] 5.4 Keyless loopback endpoint constructs; remote without key throws naming the variable.
- [x] 5.5 `gpt-5` unaffected by an exported `COPPERHEAD_BASE_URL`.
- [x] 5.6 doctor: compat credential present/absent, training-risk warn does not fail, default run makes no network call.
- [~] 5.7 Live AC-3.x: compat entry added to the provider-parity matrix (`test/agent-integration.test.ts`), correctly skips unless `COPPERHEAD_TEST_COMPAT_MODEL`/`COPPERHEAD_BASE_URL` are set. **Run for real** against Gemini (`compat:gemini-2.5-flash`): the entry mechanically works — not skipped, read the credential via `apiKeyEnv`, made real requests — but the model itself passed only 1 of 3 scenarios this run (AC-3.6 rollback-integrity passed; AC-3.1 net-rename and AC-3.4 budget-refusal both returned `outcome: 'failure'`), contradicting an earlier informal single manual success on the same model. Marked partial, not done: the harness is verified, the model's pass rate is not currently reliable enough to call this task complete. Re-run before relying on Gemini as a recommended stack.

## 6. Docs

- [x] 6.1 `.env.example`, README model list, `docs/reference/cli.md`, `docs/reference/configuration.md`.
- [x] 6.2 SPEC.md provider list, AC-3.10 parity note, and new AC-3.13–3.17 (credential, locality, routing, endpoint-isolation, prompt-privacy — one per delta-spec requirement).

## 7. Failover isolation

- [x] 7.1 `OpenAIProvider.name` is derived from `baseURL` (`'openai-compat'` when set, `'openai'` otherwise) so `otherProvider()` (`src/agent/loop.ts`) cannot mistake a compat run for real OpenAI and fail it over to a paid `ANTHROPIC_API_KEY` on a 429 — a real bug found in review: `compat` endpoints (Groq, OpenRouter free tiers, local Ollama) 429 routinely, and the fixed literal name made every compat run indistinguishable from OpenAI to the failover check. Verified: `test/openai-compat.test.ts` ("has a distinct name so otherProvider() never fails a rate-limited compat run over to a paid key") + full suite green + AC-3.18 / new agent-core requirement added.

## 8. Spec coherence: ambiguous auto-selection

- [x] 8.1 SPEC.md's "Selection" line and the agent-core delta spec did not mention the two-or-more-keys refusal added in `resolveModel()` (`src/config.ts`), despite it already being tested (`test/init-check.test.ts`, "refuses to guess when two or more credentials are present"). Found in review: this is a breaking behavior change (an env with both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` set, no `--model`, previously ran `do`/`sync`/`create`/`demo` via silent OpenAI selection; now refuses with `exit 1` until a model is chosen explicitly — `repl` alone degrades gracefully via its interactive picker). Fixed: SPEC.md Selection line rewritten, new AC-3.19, new agent-core requirement with two scenarios. Documentation-only fix — the behavior itself was already implemented and tested. **Callout: this is a breaking change and should be flagged as such in the PR description / release notes.**

## 9. Endpoint-URL credential display

- [x] 9.1 `checkCredential`'s endpoint display (`src/commands/doctor.ts`) redacted a credential embedded in the endpoint URL (query param or userinfo) via `redactSecrets`' key-shape patterns (`sk-...`, `Bearer ...`, `npm_...`, `gh[pousr]_...`), none of which match Gemini's `AIza...` or Groq's `gsk_...` key formats — Gemini's own compat endpoint puts the key in the URL as `?key=...`, the exact case the comment claimed was covered. The existing test used an `sk-`-shaped key, the one format that happened to match, so it passed without proving the claim. Found in review. Fixed: `where` now parses the URL and keeps only `origin` + `pathname` (query and userinfo dropped entirely), robust to every key format rather than pattern-matching one. Verified: `test/doctor.test.ts` — existing case renamed to "strips" (no longer relies on `[REDACTED]`), plus a new `AIza...`-shaped regression case + full suite green (517 passed).

## 10. Test hygiene

- [x] 10.1 `withKey` in `test/openai-compat.test.ts` was typed `<T>(fn: () => T): T`; called with an async callback, `fn()` returns a pending promise synchronously, so the `finally` deleting `GROQ_API_KEY` ran immediately rather than after the callback's own awaits settled. It only passed because `makeProvider`'s compat branch has no `await` before the credential read in the `OpenAIProvider` constructor — any future `await` added ahead of that read would fail these tests for a reason nowhere near the edit that broke them. Found in review. Fixed: `withKey` is now `async <T>(fn: () => Promise<T>): Promise<T>` and awaits `fn()` before the `finally` runs. Verified: `npm run typecheck` + `test/openai-compat.test.ts` (19 passed).

## 11. Coverage: config-to-provider threading

- [x] 11.1 `opts.provider ?? (await makeProvider(opts.model, sessionResume, resolveCompatSettings(config)))` (`loop.ts:266-267`) and the equivalent in `create.ts:292` were never exercised offline: every offline loop test injects `opts.provider`, so the right-hand side (the actual config-to-provider seam that makes a real `do` run work) never evaluated. Only the opt-in live matrix crossed it, and that's skipped by default. Found in review. Fixed: new test in `test/openai-compat.test.ts` ("a compat baseURL configured in .copperhead/config.json is honoured with no injected provider") — writes `.copperhead/config.json` with a loopback-server `baseURL`, commits it, calls `runAgentLoop()` with no `opts.provider`, and asserts the real HTTP request lands on that server with the configured model id and `Authorization` header, reusing the loopback-server pattern from 2.1. Verified: `test/openai-compat.test.ts` (20 passed) + full suite green (518 passed).

## 12. Coverage: untested branches (doctor + config)

- [x] 12.1 Five specific branches added by this change had no test reaching them, mapped by hand in review: (a) `isLoopbackHost`'s and `checkPromptPrivacy`'s catch arms on an unparseable `baseURL` (`doctor.ts`) — safe-default behavior, untested; (b) the subdomain arm of the training-risk host match (`host.endsWith('.' + h)`); (c) `formatDoctor`'s `warn`-status tag/color, exercised by no test; (d) the `compat ?? { apiKeyEnv: DEFAULT_API_KEY_ENV }` default arm in both `checkCredential` (`doctor.ts`) and `makeProvider` (`loop.ts`) — every real caller always passes resolved settings, so this only fires for a caller that omits the argument; (e) `::1`/`[::1]` in `isLocalEndpoint` (`config.ts`) — tested one-sided in `doctor.ts`'s `isLoopbackHost` but not here, despite AC-3.14 naming `::1` explicitly. None were suspected bugs (all traced by hand as correct); this is coverage, not a fix. Verified: 6 new tests across `test/doctor.test.ts` and `test/openai-compat.test.ts` (unparseable-URL null, subdomain warn, warn-tag rendering, both default-arm cases, `::1`/`[::1]` loopback) + full suite green (523 passed).

## 13. Test correctness: AC-4.1 safety-net scan asserted on an untouched repo

- [x] 13.1 `test/agent-integration.test.ts`'s "no API key material anywhere in the tree after runs" test built a fresh `tempFixtureRepo()` and scanned it immediately — no agent loop, transcript, or summary was ever written into the directory it inspected, so `expect(matches).toEqual([])` could not fail for the reason the test exists (predates this PR; the whole test body was rewritten here, so worth fixing while open). Found in review. Fixed: the test now runs one real, cheap turn first (`maxTurns: 1`, which fails fast and deterministically since edit tools are gated off on turn one for every provider — spec-gated-in) so a transcript + summary actually land under `.copperhead/runs/` before the scan runs against real content. Live-gated (`describe.skipIf`), so this cannot be verified offline; typecheck is clean and the suite still skips correctly with no key configured (19/19 skipped).

## 14. Correctness: response cache not endpoint-scoped for compat, and a key-shape regression it introduced

- [x] 14.1 `CachingProvider.keyFor` (`src/agent/response-cache.ts`) hashed only `{model, messages, tools}`; `model` is the string passed to it (e.g. `compat:llama-3.1-8b-instant`), which is not unique across hosts — Groq, OpenRouter, and others commonly serve overlapping model ids. Found in review: comparing the same model id across two compat endpoints silently replayed the first host's cached turns for the second, making a live backend comparison (the workflow this PR exists to enable) invisible. Fixed: `CachingProvider` takes an optional `baseURL` constructor argument, folded into the hashed key; `loop.ts` passes `resolveCompatSettings(config).baseURL` through. Verified: `test/recovery.test.ts` — same `modelId` (`compat:llama-3.1-8b-instant`), different `baseURL` (Groq vs OpenRouter), produces two independent cache entries.
- [x] 14.2 The first fix passed `baseURL` unconditionally, for every model — `resolveCompatSettings` reads `COPPERHEAD_BASE_URL` from the environment regardless of route, so a `gpt-5` run's cache key started varying with a variable that run never consults (the exact coupling D2/AC-3.16 exists to prevent; `makeProvider`'s own gate a few lines above does not have this bug). Found in review. Fixed: extracted `isCompatModel(model)` (`src/config.ts`) as the single source of truth for the gate, reused by both `makeProvider` and the cache-key wiring in `loop.ts` — `baseURL` now only enters the key when the model actually routes through `compat`. Verified: `test/openai-compat.test.ts` (`isCompatModel` unit test, true only for `compat`/`compat:<id>`).
- [x] 14.3 14.1's fix also changed the key's JSON shape (`baseURL: this.baseURL ?? null`) for *every* route, not just compat — a pre-existing `gpt-5` cache entry hashed `{model, messages, tools}` and would now hash `{model, baseURL: null, messages, tools}`, a different key, stranding every user's on-disk cache on the first run after upgrade (no eviction, so orphaned entries persist). Found in review. Fixed: `baseURL` is spread into the hashed object only when set (`...(this.baseURL ? { baseURL: this.baseURL } : {})`), so a non-compat key stays byte-identical to what it hashed before `baseURL` existed. Verified: `test/recovery.test.ts` — a cache file written under the pre-fix hash shape is still hit by a fresh non-compat `CachingProvider`.
- [x] 14.4 Spec coherence: added AC-3.20 (SPEC.md), a new "Compat cache entries are endpoint-scoped" requirement with two scenarios (endpoint switch misses; non-compat key unchanged) in the `openai-compatible-provider` delta spec, and this section, so the fix has an acceptance criterion and its own record — found in review, mirroring the section-8 pattern for AC-3.19.
